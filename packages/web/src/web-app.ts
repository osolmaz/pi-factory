import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPiLaunchPlan,
  writePiRuntimeConfig,
  type PiAppDefinition,
  type PiRuntimeConfigPaths
} from "@osolmaz/pi-factory";
import { spawn as spawnPty } from "node-pty";

import { openBrowser } from "./open-browser.js";
import { createWebServer, type WebServer } from "./server.js";
import {
  SessionHub,
  type SessionHubDeps,
  type SessionTerminal,
  type SpawnSession
} from "./sessions.js";
import { controlUrlEnv, statusUrlEnv, writeStatusExtension } from "./status-extension.js";
import { deleteSessionFile, listStoredSessions, renameStoredSession } from "./stored-sessions.js";
import { catppuccinLatte } from "./theme.js";
import type { PiWebOptions } from "./types.js";

export type PiWebApp = {
  /** Page URL, including the access token. */
  readonly url: string;
  readonly hub: SessionHub;
  close(): Promise<void>;
};

/** Start the web app and return once the server listens. */
export async function startPiWebApp(
  app: PiAppDefinition,
  options: PiWebOptions = {}
): Promise<PiWebApp> {
  const cwd = await realpath(resolve(options.cwd ?? app.rootDir ?? process.cwd()));
  const runtimeConfig = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  const webApp = withWebLaunch(app, await writeStatusExtension(app.stateDir));
  const { hub, web, token, setBase } = wireServer(app, options, (urls) => ({
    spawn: ptySpawner(webApp, runtimeConfig, cwd, urls),
    listStored: () => listStoredSessions(cwd, app.sessionDir),
    renameStored: async (path, name) => {
      renameStoredSession(path, app.sessionDir, name);
    },
    deleteStored: (path) => deleteSessionFile(path)
  }));
  const base = await listen(web, options.host ?? "127.0.0.1", options.port ?? 0);
  setBase(base);
  const url = `${base}/?token=${token}`;
  options.onReady?.(url);
  if (options.open !== false) openBrowser(url);
  return {
    url,
    hub,
    close: async () => {
      hub.stopAll();
      await web.close();
    }
  };
}

type HubSources = Pick<SessionHubDeps, "spawn" | "listStored" | "renameStored" | "deleteStored">;

/** Per-session URLs that the status extension uses. */
type SessionUrls = {
  readonly status: (key: string) => string;
  readonly control: (key: string) => string;
};

// The hub reports changes to the server, and the server serves the hub, so this function ties the
// two together. Status URLs need the listening address, which is known only after listen().
function wireServer(
  app: PiAppDefinition,
  options: PiWebOptions,
  sources: (urls: SessionUrls) => HubSources
): { hub: SessionHub; web: WebServer; token: string; setBase: (base: string) => void } {
  const token = randomToken();
  const statusToken = randomToken();
  const state = { base: "", notify: (): void => undefined };
  const hub = new SessionHub({
    ...sources({
      status: (key) => `${state.base}/api/status/${encodeURIComponent(key)}?token=${statusToken}`,
      control: (key) => `${state.base}/api/control/${encodeURIComponent(key)}?token=${statusToken}`
    }),
    onChange: () => {
      state.notify();
    }
  });
  const web = createWebServer({
    hub,
    token,
    statusToken,
    title: app.name,
    theme: options.theme ?? catppuccinLatte,
    assets: webAssets(),
    hosts: [...(options.host === undefined ? [] : [options.host]), ...(options.allowedHosts ?? [])]
  });
  state.notify = () => {
    web.notify();
  };
  return {
    hub,
    web,
    token,
    setBase: (base) => {
      state.base = base;
    }
  };
}

/**
 * Serve the app in the browser until the process receives SIGINT or SIGTERM. Returns the exit
 * code for the caller's CLI.
 */
export async function runPiWebApp(
  app: PiAppDefinition,
  options: PiWebOptions = {}
): Promise<number> {
  // Listen for the stop signal before starting, so a signal during start is not lost.
  const stopped = new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
  const web = await startPiWebApp(app, {
    ...options,
    onReady:
      options.onReady ??
      ((url) => {
        process.stderr.write(`${app.name} web: ${url}\n`);
      })
  });
  await stopped;
  await web.close();
  return 0;
}

/**
 * The app as the web runner launches it: with the status extension, and in Pi's fullscreen TUI,
 * because Pi sends mouse clicks to extensions only there. A `--tui-mode` the app chose wins.
 */
export function withWebLaunch(app: PiAppDefinition, statusExtension: string): PiAppDefinition {
  const forwarded = app.forwardedArgs ?? [];
  const hasTuiMode = forwarded.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode="));
  return {
    ...app,
    extensions: [...(app.extensions ?? []), { path: statusExtension }],
    forwardedArgs: hasTuiMode ? forwarded : [...forwarded, "--tui-mode", "fullscreen"]
  };
}

function ptySpawner(
  app: PiAppDefinition,
  runtimeConfig: PiRuntimeConfigPaths,
  cwd: string,
  urls: SessionUrls
): SpawnSession {
  return async ({ key, sessionFile, cols, rows }): Promise<SessionTerminal> => {
    const plan = await createPiLaunchPlan(app, runtimeConfig, {
      cwd,
      ...(sessionFile === undefined ? {} : { session: sessionFile })
    });
    for (const warning of plan.warnings) process.stderr.write(`${app.name} web: ${warning}\n`);
    return spawnPty(plan.command, [...plan.args], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: plan.cwd ?? cwd,
      env: {
        ...definedEnv(process.env),
        ...plan.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        [statusUrlEnv]: urls.status(key),
        [controlUrlEnv]: urls.control(key)
      }
    });
  };
}

/** The files the page needs: the built UI and the ghostty-web terminal. */
export function webAssets(): Readonly<Record<string, string>> {
  const uiDir = fileURLToPath(new URL("../ui/", import.meta.url));
  const ghosttyDir = dirname(createRequire(import.meta.url).resolve("ghostty-web"));
  return {
    "/index.html": join(uiDir, "index.html"),
    "/app.js": join(uiDir, "app.js"),
    "/style.css": join(uiDir, "style.css"),
    "/vendor/ghostty-web.js": join(ghosttyDir, "ghostty-web.js"),
    "/ghostty-vt.wasm": join(ghosttyDir, "ghostty-vt.wasm")
  };
}

async function listen(web: WebServer, host: string, port: number): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    web.server.once("error", reject);
    web.server.listen(port, host, () => {
      resolveListen();
    });
  });
  const address = web.server.address() as AddressInfo;
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${shownHost}:${String(address.port)}`;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function randomToken(): string {
  return randomBytes(24).toString("hex");
}
