import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiAppDefinition } from "@osolmaz/pi-factory";
import { afterEach, describe, expect, it } from "vitest";

import { browserCommand, openBrowser } from "../src/open-browser.js";
import { parseStatusUpdate } from "../src/server.js";
import { SessionHub, type SessionTerminal } from "../src/sessions.js";
import { statusExtensionSource, statusUrlEnv } from "../src/status-extension.js";
import {
  deleteSessionFile,
  listStoredSessions,
  renameStoredSession,
  storedSession
} from "../src/stored-sessions.js";
import { loadSettings, mergeSettings, saveSettings } from "../src/settings.js";
import { catppuccinAccentNames, catppuccinThemeChoices, catppuccinWebTheme } from "../src/theme.js";
import { runPiWebApp, withWebLaunch } from "../src/web-app.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeTerminal implements SessionTerminal {
  readonly writes: string[] = [];
  readonly sizes: string[] = [];
  killed = false;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: (() => void) | undefined;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: () => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push(`${String(cols)}x${String(rows)}`);
  }
  kill(): void {
    this.killed = true;
  }
  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(): void {
    this.exitListener?.();
  }
}

type FileLog = { renamed: string[]; deleted: string[] };

function hub(
  terminals: FakeTerminal[],
  changes: { count: number } = { count: 0 },
  files: FileLog = { renamed: [], deleted: [] }
): SessionHub {
  let time = 1_000;
  return new SessionHub({
    spawn: async () => {
      const terminal = new FakeTerminal();
      terminals.push(terminal);
      return terminal;
    },
    listStored: async () => [{ path: "/s/old.jsonl", title: "Old", updatedAt: 500 }],
    renameStored: async (path, name) => {
      files.renamed.push(`${path}=${name}`);
    },
    deleteStored: async (path) => {
      files.deleted.push(path);
    },
    onChange: () => {
      changes.count += 1;
    },
    now: () => (time += 1)
  });
}

describe("session hub", () => {
  it("merges live and stored sessions, newest first, and applies updates", async () => {
    const terminals: FakeTerminal[] = [];
    const sessions = hub(terminals);
    const key = await sessions.open();

    sessions.update(key, { status: "responding", name: "Refactor" });
    expect(await sessions.summaries()).toEqual([
      expect.objectContaining({ key, title: "Refactor", status: "responding", live: true }),
      expect.objectContaining({ key: "/s/old.jsonl", title: "Old", live: false })
    ]);

    sessions.update(key, { name: "", sessionFile: "/s/old.jsonl" });
    expect(await sessions.summaries()).toEqual([
      expect.objectContaining({ key, title: "Old", sessionFile: "/s/old.jsonl" })
    ]);
  });

  it("ignores input, resizes, and updates for sessions that do not run", async () => {
    const changes = { count: 0 };
    const sessions = hub([], changes);

    sessions.input("missing", "x");
    sessions.resize("missing", 10, 10);
    sessions.update("missing", { status: "idle" });

    expect(changes.count).toBe(0);
    const viewer = { data: () => undefined, exit: () => undefined };
    expect(() => sessions.attach("missing", viewer, 80, 24)).toThrow("unknown session missing");
  });

  it("replays output, nudges an unchanged size, and forgets exited sessions", async () => {
    const terminals: FakeTerminal[] = [];
    const sessions = hub(terminals);
    const key = await sessions.open();
    const terminal = terminals[0] as FakeTerminal;
    terminal.emit("hello");

    const seen: string[] = [];
    let exited = 0;
    const viewer = {
      data: (data: string) => seen.push(data),
      exit: () => (exited += 1)
    };
    const detach = sessions.attach(key, viewer, 120, 40);
    terminal.emit(" world");
    detach();
    terminal.emit("!");
    sessions.input(key, "typed");

    expect(seen).toEqual(["hello", " world"]);
    expect(terminal.sizes).toEqual(["120x39", "120x40"]);
    expect(terminal.writes).toEqual(["typed"]);

    sessions.attach(key, viewer, 120, 40);
    terminal.exit();
    expect(sessions.has(key)).toBe(false);
    expect(exited).toBe(1);
  });

  it("renames a live session through its Pi and a stored one through its file", async () => {
    const files: FileLog = { renamed: [], deleted: [] };
    const sessions = hub([], { count: 0 }, files);
    const key = await sessions.open();

    await sessions.rename(key, "  New   name ");
    expect(await sessions.nextControl(key, 1_000)).toEqual({ rename: "New name" });
    const waiting = sessions.nextControl(key, 1_000);
    await sessions.rename(key, "Second");
    expect(await waiting).toEqual({ rename: "Second" });

    await sessions.rename("/s/old.jsonl", "Stored");
    expect(files.renamed).toEqual(["/s/old.jsonl=Stored"]);
    await expect(sessions.rename(key, "   ")).rejects.toThrow("must not be empty");
    await expect(sessions.rename("/etc/passwd", "x")).rejects.toThrow(
      "unknown session /etc/passwd"
    );
  });

  it("times out an idle control wait and ends it when the session exits", async () => {
    const terminals: FakeTerminal[] = [];
    const sessions = hub(terminals);
    const key = await sessions.open();

    expect(await sessions.nextControl(key, 10)).toBeUndefined();
    const first = sessions.nextControl(key, 1_000);
    const second = sessions.nextControl(key, 1_000);
    expect(await first).toBeUndefined();
    (terminals[0] as FakeTerminal).exit();
    expect(await second).toBeUndefined();
    expect(await sessions.nextControl(key, 10)).toBeUndefined();
  });

  it("stops a live session before deleting its file, and deletes stored files", async () => {
    const terminals: FakeTerminal[] = [];
    const files: FileLog = { renamed: [], deleted: [] };
    const sessions = hub(terminals, { count: 0 }, files);
    const key = await sessions.open();
    sessions.update(key, { sessionFile: "/s/old.jsonl" });
    const terminal = terminals[0] as FakeTerminal;
    const kill = terminal.kill.bind(terminal);
    terminal.kill = () => {
      kill();
      terminal.exit();
    };

    await sessions.remove(key);
    expect(terminal.killed).toBe(true);
    expect(sessions.has(key)).toBe(false);
    expect(files.deleted).toEqual(["/s/old.jsonl"]);

    const unsaved = await sessions.open();
    const other = terminals[1] as FakeTerminal;
    other.kill = () => {
      other.exit();
    };
    await sessions.remove(unsaved);
    await sessions.remove("/s/old.jsonl");
    expect(files.deleted).toEqual(["/s/old.jsonl", "/s/old.jsonl"]);
    await expect(sessions.remove("/nope.jsonl")).rejects.toThrow("unknown session /nope.jsonl");
  });

  it("sends start requests to new sessions and broadcasts to every live one", async () => {
    let time = 0;
    const sessions = new SessionHub({
      spawn: async () => new FakeTerminal(),
      listStored: async () => [],
      renameStored: async () => undefined,
      deleteStored: async () => undefined,
      startControls: () => [{ theme: "cat-latte" }],
      onChange: () => undefined,
      now: () => (time += 1)
    });
    const first = await sessions.open();
    const second = await sessions.open();

    sessions.broadcast({ theme: "cat-mocha" });

    for (const key of [first, second]) {
      expect(await sessions.nextControl(key, 10)).toEqual({ theme: "cat-latte" });
      expect(await sessions.nextControl(key, 10)).toEqual({ theme: "cat-mocha" });
    }
  });

  it("kills every process on stop", async () => {
    const terminals: FakeTerminal[] = [];
    const sessions = hub(terminals);
    await sessions.open();
    await sessions.open();

    sessions.stopAll();

    expect(terminals.map((terminal) => terminal.killed)).toEqual([true, true]);
  });
});

describe("status updates", () => {
  it("accepts known fields and rejects bad ones", () => {
    expect(parseStatusUpdate({ status: "waiting", sessionFile: "/s/a.jsonl", name: "A" })).toEqual({
      status: "waiting",
      sessionFile: "/s/a.jsonl",
      name: "A"
    });
    expect(parseStatusUpdate({ name: null })).toEqual({});
    expect(() => parseStatusUpdate({ status: "asleep" })).toThrow("unknown status asleep");
    expect(() => parseStatusUpdate({ name: 3 })).toThrow("name must be a string");
    expect(() => parseStatusUpdate("idle")).toThrow("body must be a JSON object");
  });

  it("generates an extension that reads its URL from the environment", () => {
    const source = statusExtensionSource();
    expect(source).toContain(`process.env[${JSON.stringify(statusUrlEnv)}]`);
    for (const event of [
      "session_start",
      "agent_start",
      "ui_prompt_start",
      "ui_prompt_end",
      "agent_settled",
      "session_info_changed"
    ]) {
      expect(source).toContain(`pi.on("${event}"`);
    }
  });
});

describe("stored session titles", () => {
  const info = {
    path: "/s/a.jsonl",
    id: "a",
    cwd: "/w",
    created: new Date(0),
    modified: new Date(5_000),
    messageCount: 1,
    allMessagesText: ""
  };

  it("prefers the session name and shortens long first messages", () => {
    expect(storedSession({ ...info, name: "Named", firstMessage: "ignored" }).title).toBe("Named");
    expect(storedSession({ ...info, firstMessage: "x".repeat(100) }).title).toBe(
      `${"x".repeat(79)}…`
    );
    expect(storedSession({ ...info, firstMessage: "  " }).title).toBe("Untitled session");
    expect(storedSession({ ...info, firstMessage: "hi" }).updatedAt).toBe(5_000);
  });
});

describe("themes", () => {
  it("offers every Catppuccin flavor with its accents and optional Pi theme", () => {
    const [latte, frappe, macchiato, mocha] = catppuccinThemeChoices({ mocha: "cat-mocha" });
    expect(latte?.theme).toMatchObject({ background: "#eff1f5", black: "#5c5f77" });
    expect(frappe?.theme).toMatchObject({ background: "#303446", black: "#51576d" });
    expect(macchiato?.theme).toMatchObject({ background: "#24273a", white: "#b8c0e0" });
    expect(mocha).toMatchObject({ id: "catppuccin-mocha", piTheme: "cat-mocha" });
    expect(Object.keys(latte?.accents ?? {})).toEqual([...catppuccinAccentNames]);
    expect(latte?.piTheme).toBeUndefined();
    expect(catppuccinWebTheme("mocha").brightWhite).toBe("#a6adc8");
  });
});

describe("settings", () => {
  const themes = catppuccinThemeChoices();
  const defaults = { theme: "catppuccin-latte", accent: undefined, fontSize: 14 };

  it("validates changes and drops an accent the new theme lacks", () => {
    expect(mergeSettings(defaults, { accent: "blue", fontSize: 12 }, themes)).toEqual({
      theme: "catppuccin-latte",
      accent: "blue",
      fontSize: 12
    });
    const first = themes[0];
    if (first === undefined) throw new Error("no theme");
    const plain = [{ ...first, id: "plain", accents: {} }];
    expect(mergeSettings({ ...defaults, accent: "blue" }, { theme: "plain" }, plain)).toEqual({
      theme: "plain",
      accent: undefined,
      fontSize: 14
    });
    expect(mergeSettings({ ...defaults, accent: "blue" }, { accent: null }, themes).accent).toBe(
      undefined
    );
    expect(() => mergeSettings(defaults, { theme: "neon" }, themes)).toThrow(
      'unknown theme "neon"'
    );
    expect(() => mergeSettings(defaults, { accent: "gold" }, themes)).toThrow(
      'unknown accent "gold"'
    );
    expect(() => mergeSettings(defaults, { fontSize: 9 }, themes)).toThrow("font size must be");
    expect(() => mergeSettings(defaults, [], themes)).toThrow("settings must be a JSON object");
  });

  it("saves and loads settings, and falls back to the defaults", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-factory-web-settings-")));
    cleanup.push(dir);
    const file = path.join(dir, "nested", "settings.json");

    expect(await loadSettings(file, defaults, themes)).toEqual(defaults);
    await saveSettings(file, { theme: "catppuccin-mocha", accent: "red", fontSize: 18 });
    expect(await loadSettings(file, defaults, themes)).toEqual({
      theme: "catppuccin-mocha",
      accent: "red",
      fontSize: 18
    });
    await writeFile(file, '{"theme":"gone"}', "utf8");
    expect(await loadSettings(file, defaults, themes)).toEqual(defaults);
  });
});

describe("session files", () => {
  it("renames a stored session with a Pi session_info entry and deletes files", async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-factory-web-files-")));
    cleanup.push(dir);
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-completions",
      provider: "p",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 2
    });
    const file = manager.getSessionFile() ?? "";

    renameStoredSession(file, dir, "Renamed");
    expect((await listStoredSessions(dir, dir)).map((entry) => entry.title)).toEqual(["Renamed"]);

    const trashed: string[] = [];
    await deleteSessionFile(file, (target) => {
      trashed.push(target);
      return true;
    });
    expect(trashed).toEqual([file]);
    await deleteSessionFile(file, () => false);
    expect(await listStoredSessions(dir, dir)).toEqual([]);
  });
});

describe("browser opener", () => {
  it("uses the platform's opener", () => {
    expect(browserCommand("http://x", "darwin")).toEqual(["open", ["http://x"]]);
    expect(browserCommand("http://x", "win32")).toEqual(["cmd", ["/c", "start", "", "http://x"]]);
    expect(browserCommand("http://x", "linux")).toEqual(["xdg-open", ["http://x"]]);
  });

  it("does not throw when the opener is missing", () => {
    const path = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      expect(() => {
        openBrowser("http://127.0.0.1:1/", "linux");
      }).not.toThrow();
    } finally {
      process.env["PATH"] = path;
    }
  });
});

describe("web launch", () => {
  const base: PiAppDefinition = {
    id: "a",
    name: "A",
    stateDir: "/s",
    sessionDir: "/s/sessions",
    piCommand: ["pi"],
    providers: [],
    defaultProvider: "p",
    defaultModel: "m",
    thinking: "medium"
  };

  it("adds the status extension and fullscreen mode", () => {
    const app = withWebLaunch(
      { ...base, extensions: [{ path: "/e/app.ts" }], forwardedArgs: ["--verbose"] },
      "/s/status.ts"
    );
    expect(app.extensions).toEqual([{ path: "/e/app.ts" }, { path: "/s/status.ts" }]);
    expect(app.forwardedArgs).toEqual(["--verbose", "--tui-mode", "fullscreen"]);
    expect(
      withWebLaunch({ ...base, forwardedArgs: ["--tui-mode=regular"] }, "/x").forwardedArgs
    ).toEqual(["--tui-mode=regular"]);
  });

  it("serves until the process gets SIGINT", async () => {
    const stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-factory-web-run-")));
    cleanup.push(stateDir);
    const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
    let url = "";
    const running = runPiWebApp(
      {
        ...base,
        stateDir,
        sessionDir: path.join(stateDir, "sessions"),
        piCommand: ["node", fakePi],
        providers: [{ id: "p", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m" }] }]
      },
      {
        open: false,
        cwd: stateDir,
        onReady: (ready) => {
          url = ready;
          process.emit("SIGINT");
        }
      }
    );

    expect(await running).toBe(0);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/u);
  });
});
