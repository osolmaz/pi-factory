import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PiAppDefinition } from "@osolmaz/pi-factory";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { catppuccinThemeChoices } from "../src/theme.js";
import { startPiWebApp, type PiWebApp } from "../src/web-app.js";
import type { SessionSummary } from "../src/types.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function app(stateDir: string, extra: Partial<PiAppDefinition> = {}): PiAppDefinition {
  return {
    id: "webtest",
    name: "Web Test",
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: ["node", fakePi],
    providers: [
      { id: "local-openai", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "auto" }] }
    ],
    defaultProvider: "local-openai",
    defaultModel: "auto",
    thinking: "medium",
    ...extra
  };
}

type Started = { web: PiWebApp; base: string; token: string; stateDir: string; cwd: string };

async function start(extra: Partial<PiAppDefinition> = {}): Promise<Started> {
  const stateDir = await tempDir("pi-factory-web-state-");
  const cwd = await tempDir("pi-factory-web-cwd-");
  const web = await startPiWebApp(app(stateDir, extra), { open: false, cwd });
  cleanup.push(() => web.close());
  const url = new URL(web.url);
  return { web, base: url.origin, token: url.searchParams.get("token") ?? "", stateDir, cwd };
}

async function api<T>(started: Started, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${started.base}${route}?token=${started.token}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

class Socket {
  readonly text: string[] = [];
  readonly ws: WebSocket;

  constructor(started: Started, route: string, origin = started.base) {
    this.ws = new WebSocket(`${started.base.replace("http", "ws")}${route}`, { origin });
    this.ws.on("message", (data: Buffer) => {
      this.text.push(data.toString("utf8"));
    });
    cleanup.push(async () => {
      this.ws.terminate();
    });
  }

  async opened(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => {
        resolve();
      });
      this.ws.once("error", reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const all = this.text.join("");
      const match = pattern.exec(all);
      if (match !== null) return match[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${String(pattern)} in ${this.text.join("")}`);
  }

  sessionUpdates(): readonly (readonly SessionSummary[])[] {
    return this.text.map((entry) => (JSON.parse(entry) as { sessions: SessionSummary[] }).sessions);
  }
}

function terminal(started: Started, key: string, size = "cols=100&rows=30"): Socket {
  return new Socket(
    started,
    `/api/terminal/${encodeURIComponent(key)}?token=${started.token}&${size}`
  );
}

async function waitForSessions(
  events: Socket,
  check: (sessions: readonly SessionSummary[]) => boolean
): Promise<readonly SessionSummary[]> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const match = events.sessionUpdates().find(check);
    if (match !== undefined) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`sessions never matched: ${JSON.stringify(events.sessionUpdates().at(-1))}`);
}

function startedFrom(web: PiWebApp, stateDir: string): Started {
  const url = new URL(web.url);
  return {
    web,
    base: url.origin,
    token: url.searchParams.get("token") ?? "",
    stateDir,
    cwd: stateDir
  };
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function writeStoredSession(sessionDir: string, cwd: string, text: string): Promise<string> {
  const file = path.join(sessionDir, "2026-09-24T10-00-00-000Z_stored.jsonl");
  const time = "2026-09-24T10:00:00.000Z";
  const lines = [
    { type: "session", version: 3, id: "stored-session", timestamp: time, cwd },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: time,
      message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(time) }
    }
  ];
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function statusWithHost(started: Started, host: string): Promise<number | undefined> {
  const url = new URL(`${started.base}/api/sessions?token=${started.token}`);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

// Send an upgrade request with a raw request target, which fetch and ws would normalize.
function rawUpgrade(started: Started, target: string): Promise<string> {
  const url = new URL(started.base);
  return new Promise((resolve) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
          "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    socket.on("close", () => {
      resolve("closed");
    });
    socket.on("error", () => {
      resolve("closed");
    });
  });
}

describe("pi-factory web app", () => {
  it("serves the page and the terminal files only with the token", async () => {
    const started = await start();

    expect((await fetch(`${started.base}/`)).status).toBe(403);
    const page = await fetch(started.web.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="terminal">');
    const wasm = await fetch(`${started.base}/ghostty-vt.wasm`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect((await fetch(`${started.base}/vendor/ghostty-web.js`)).status).toBe(200);
    const font = await fetch(`${started.base}/fonts/monaspace-argon-400-italic.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${started.base}/api/sessions`)).status).toBe(403);
    expect((await fetch(`${started.base}/missing.js`)).status).toBe(404);
    const config = await api<{
      title: string;
      themes: { id: string }[];
      settings: unknown;
      fontFamily: string;
    }>(started, "GET", "/api/config");
    expect(config).toMatchObject({
      title: "Web Test",
      settings: { theme: "catppuccin-latte", fontSize: 14 },
      fontFamily: '"Monaspace Argon", ui-monospace, Menlo, Consolas, monospace'
    });
    expect(config.themes.map((choice) => choice.id)).toEqual([
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha"
    ]);
    const favicon = await fetch(`${started.base}/favicon.ico`);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    const logo = await fetch(`${started.base}/logo`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await logo.text()).toContain("pi.dev/press-kit");
  });

  it("starts a new session in fullscreen with the status extension and talks to it", async () => {
    const started = await start();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const term = terminal(started, key);
    await term.opened();

    const args = await term.waitFor(/FAKE_PI \[.*\]/u);
    expect(args).toContain('"--tui-mode","fullscreen"');
    expect(args).toContain(path.join(started.stateDir, "pi-factory-web", "status.ts"));
    expect(args).not.toContain("--session");

    term.send({ type: "input", data: "hello\r" });
    await term.waitFor(/echo:hello/u);
    term.send({ type: "resize", cols: 90, rows: 25 });
    await term.waitFor(/RESIZE 90x25/u);
  });

  it("keeps a TUI mode that the app chose", async () => {
    const started = await start({ forwardedArgs: ["--tui-mode", "regular"] });
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const term = terminal(started, key);
    await term.opened();

    const args = await term.waitFor(/FAKE_PI \[.*\]/u);
    expect(args).toContain('"--tui-mode","regular"');
    expect(args).not.toContain('"fullscreen"');
  });

  it("shows the reported status and session name in the session list", async () => {
    const started = await start();
    const events = new Socket(started, `/api/events?token=${started.token}`);
    await events.opened();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const term = terminal(started, key);
    await term.opened();

    const ready = await waitForSessions(events, (list) => list[0]?.status === "idle");
    expect(ready[0]).toMatchObject({ key, live: true, title: "New session" });
    expect(ready[0]?.sessionFile).toContain(path.join(started.stateDir, "sessions"));

    term.send({ type: "input", data: "work\r" });
    await waitForSessions(events, (list) => list[0]?.status === "responding");
    await waitForSessions(events, (list) => list[0]?.status === "waiting");
    const done = await waitForSessions(
      events,
      (list) => list[0]?.status === "idle" && list[0].title === "Worked"
    );
    expect(done).toHaveLength(1);
  });

  it("lists stored sessions and resumes one with its session file", async () => {
    const started = await start();
    const sessionDir = path.join(started.stateDir, "sessions");
    const file = await writeStoredSession(sessionDir, started.cwd, "Explain   the\nbuild");

    const before = await api<{ sessions: SessionSummary[] }>(started, "GET", "/api/sessions");
    expect(before.sessions).toEqual([
      expect.objectContaining({ key: file, title: "Explain the build", live: false })
    ]);

    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {
      sessionFile: file
    });
    const term = terminal(started, key);
    await term.opened();
    expect(await term.waitFor(/FAKE_PI \[.*\]/u)).toContain(`"--session","${file}"`);

    const events = new Socket(started, `/api/events?token=${started.token}`);
    await events.opened();
    const merged = await waitForSessions(events, (list) => list[0]?.status === "idle");
    expect(merged).toEqual([
      expect.objectContaining({ key, live: true, title: "Explain the build", sessionFile: file })
    ]);
    const again = await api<{ key: string }>(started, "POST", "/api/sessions", {
      sessionFile: file
    });
    expect(again.key).toBe(key);
  });

  it("renames a live session through its Pi and deletes sessions from the page", async () => {
    const started = await start();
    const events = new Socket(started, `/api/events?token=${started.token}`);
    await events.opened();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const term = terminal(started, key);
    await term.opened();
    await term.waitFor(/FAKE_PI/u);

    await api(started, "POST", "/api/sessions/rename", { key, name: "Planning" });
    await term.waitFor(/RENAMED:Planning/u);
    await waitForSessions(events, (list) => list[0]?.title === "Planning");

    const sessionDir = path.join(started.stateDir, "sessions");
    const stored = await writeStoredSession(sessionDir, started.cwd, "Old work");
    await api(started, "POST", "/api/sessions/delete", { key: stored });
    await api(started, "POST", "/api/sessions/delete", { key });
    await waitForSessions(events, (list) => list.length === 0);

    const badDelete = await fetch(`${started.base}/api/sessions/delete?token=${started.token}`, {
      method: "POST",
      body: JSON.stringify({ key: "/etc/passwd" })
    });
    expect(badDelete.status).toBe(400);
    const missingName = await fetch(`${started.base}/api/sessions/rename?token=${started.token}`, {
      method: "POST",
      body: JSON.stringify({ key })
    });
    expect(missingName.status).toBe(400);
  });

  it("saves settings, tells the pages, and switches the Pi theme of every session", async () => {
    const stateDir = await tempDir("pi-factory-web-state-");
    const logo = path.join(stateDir, "logo.png");
    await writeFile(logo, "png", "utf8");
    const themes = catppuccinThemeChoices({ latte: "catppuccin-latte", mocha: "catppuccin-mocha" });
    const web = await startPiWebApp(app(stateDir, { logo } as Partial<PiAppDefinition>), {
      open: false,
      cwd: stateDir,
      themes
    });
    cleanup.push(() => web.close());
    const started = startedFrom(web, stateDir);
    expect((await fetch(`${started.base}/logo`)).headers.get("content-type")).toBe("image/png");

    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const term = terminal(started, key);
    await term.opened();
    await term.waitFor(/THEME:catppuccin-latte/u);
    const events = new Socket(started, `/api/events?token=${started.token}`);
    await events.opened();

    const changed = await api<{ settings: unknown }>(started, "POST", "/api/settings", {
      theme: "catppuccin-mocha",
      accent: "peach",
      fontSize: 16
    });
    expect(changed.settings).toEqual({ theme: "catppuccin-mocha", accent: "peach", fontSize: 16 });
    await term.waitFor(/THEME:catppuccin-mocha/u);
    await until(() => events.text.some((entry) => entry.includes('"type":"settings"')));

    const frappe = await api<{ settings: unknown }>(started, "POST", "/api/settings", {
      theme: "catppuccin-frappe"
    });
    expect(frappe.settings).toEqual({ theme: "catppuccin-frappe", accent: "peach", fontSize: 16 });
    const bad = await fetch(`${started.base}/api/settings?token=${started.token}`, {
      method: "POST",
      body: JSON.stringify({ fontSize: 99 })
    });
    expect(bad.status).toBe(400);

    const again = await startPiWebApp(app(stateDir), { open: false, cwd: stateDir, themes });
    cleanup.push(() => again.close());
    const restarted = startedFrom(again, stateDir);
    const config = await api<{ settings: unknown }>(restarted, "GET", "/api/config");
    expect(config.settings).toEqual({ theme: "catppuccin-frappe", accent: "peach", fontSize: 16 });
  });

  it("refuses to start with a missing logo or an unknown default theme", async () => {
    const stateDir = await tempDir("pi-factory-web-state-");
    const options = { open: false, cwd: stateDir };
    await expect(
      startPiWebApp(app(stateDir), { ...options, logo: "/nope/logo.svg" })
    ).rejects.toThrow("logo not found: /nope/logo.svg");
    await expect(
      startPiWebApp(app(stateDir), { ...options, defaultTheme: "neon" })
    ).rejects.toThrow("unknown default theme neon");
    await expect(startPiWebApp(app(stateDir), { ...options, themes: [] })).rejects.toThrow(
      "web mode needs at least one theme"
    );
  });

  it("replays output and redraws for a viewer that attaches later", async () => {
    const started = await start();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    const first = terminal(started, key);
    await first.opened();
    await first.waitFor(/FAKE_PI/u);
    first.send({ type: "input", data: "before\r" });
    await first.waitFor(/echo:before/u);
    first.ws.close();

    const second = terminal(started, key);
    await second.opened();
    await second.waitFor(/echo:before/u);
    await second.waitFor(/RESIZE 100x30/u);
  });

  it("drops a session from the list when its process exits", async () => {
    const started = await start();
    const events = new Socket(started, `/api/events?token=${started.token}`);
    await events.opened();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});
    await waitForSessions(events, (list) => list.some((entry) => entry.key === key));

    started.web.hub.stopAll();
    const term = terminal(started, key);
    await new Promise<void>((resolve) => {
      term.ws.once("close", (code) => {
        expect(code).toBe(4404);
        resolve();
      });
    });
  });

  it("answers to the host it listens on and to extra allowed names", async () => {
    const stateDir = await tempDir("pi-factory-web-state-");
    const web = await startPiWebApp(app(stateDir), {
      open: false,
      cwd: stateDir,
      host: "127.0.0.1",
      allowedHosts: ["box.tailnet.example"]
    });
    cleanup.push(() => web.close());
    const url = new URL(web.url);
    const started = {
      web,
      base: url.origin,
      token: url.searchParams.get("token") ?? "",
      stateDir,
      cwd: stateDir
    };

    expect(await statusWithHost(started, "box.tailnet.example")).toBe(200);
    expect(await statusWithHost(started, "other.example")).toBe(403);
  });

  it("rejects sockets and requests that do not come from its own page", async () => {
    const started = await start();
    const { key } = await api<{ key: string }>(started, "POST", "/api/sessions", {});

    const wrongOrigin = new Socket(
      started,
      `/api/events?token=${started.token}`,
      "http://evil.example"
    );
    await expect(wrongOrigin.opened()).rejects.toThrow();
    const wrongToken = new Socket(started, `/api/events?token=nope`);
    await expect(wrongToken.opened()).rejects.toThrow();
    const badPath = new Socket(started, `/api/terminal/%E0%A4%A?token=${started.token}`);
    await badPath.opened();
    const closeCode = await new Promise<number>((resolve) => {
      badPath.ws.once("close", resolve);
    });
    expect(closeCode).toBe(4400);
    expect(await rawUpgrade(started, "http://localhost:99999/api/events")).toBe("closed");
    expect((await fetch(started.web.url)).status).toBe(200);

    expect(await statusWithHost(started, "attacker.example")).toBe(403);
    expect(await statusWithHost(started, "localhost")).toBe(200);
    const pageTokenStatus = await fetch(
      `${started.base}/api/status/${key}?token=${started.token}`,
      { method: "POST", body: "{}" }
    );
    expect(pageTokenStatus.status).toBe(403);
    const badBody = await fetch(`${started.base}/api/sessions?token=${started.token}`, {
      method: "POST",
      body: "[1]"
    });
    expect(badBody.status).toBe(400);
    const notJson = await fetch(`${started.base}/api/sessions?token=${started.token}`, {
      method: "POST",
      body: "{"
    });
    expect(notJson.status).toBe(400);
    const unknownRoute = await fetch(`${started.base}/api/nothing?token=${started.token}`);
    expect(unknownRoute.status).toBe(404);
  });
});
