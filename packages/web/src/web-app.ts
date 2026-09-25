import { randomBytes } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
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
import { createWebServer, type SettingsState, type WebServer } from "./server.js";
import { defaultFontSize, loadSettings, mergeSettings, saveSettings } from "./settings.js";
import {
  SessionHub,
  type SessionHubDeps,
  type SessionTerminal,
  type SpawnSession
} from "./sessions.js";
import { controlUrlEnv, statusUrlEnv, writeStatusExtension } from "./status-extension.js";
import { deleteSessionFile, listStoredSessions, renameStoredSession } from "./stored-sessions.js";
import { catppuccinThemeChoices, defaultFontFamily } from "./theme.js";
import type { PiWebOptions, PiWebSettings, PiWebThemeChoice } from "./types.js";

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
  const look = await webLook(app, options);
  const { hub, web, token, setBase } = wireServer(app, options, look, (urls) => ({
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

/** Everything about how the page looks: themes, saved settings, font, and logo. */
type WebLook = {
  readonly themes: readonly PiWebThemeChoice[];
  readonly settingsPath: string;
  readonly settings: PiWebSettings;
  readonly fontFamily: string;
  readonly logo: string;
};

// The published core types may not know `logo` yet; the manifest has it from the core release on.
type AppWithLogo = PiAppDefinition & { readonly logo?: string };

async function webLook(app: AppWithLogo, options: PiWebOptions): Promise<WebLook> {
  const themes = options.themes ?? catppuccinThemeChoices();
  const first = themes[0];
  if (first === undefined) throw new Error("web mode needs at least one theme");
  const defaultTheme = options.defaultTheme ?? first.id;
  if (!themes.some((choice) => choice.id === defaultTheme)) {
    throw new Error(`unknown default theme ${defaultTheme}`);
  }
  const logo = options.logo ?? app.logo ?? join(uiDir(), "pi-logo.svg");
  await access(logo).catch(() => {
    throw new Error(`logo not found: ${logo}`);
  });
  const settingsPath = join(app.stateDir, "pi-factory-web", "settings.json");
  const defaults = { theme: defaultTheme, accent: undefined, fontSize: defaultFontSize };
  return {
    themes,
    settingsPath,
    settings: await loadSettings(settingsPath, defaults, themes),
    fontFamily: options.fontFamily ?? defaultFontFamily,
    logo
  };
}

function piThemeOf(look: WebLook, settings: PiWebSettings): string | undefined {
  return look.themes.find((choice) => choice.id === settings.theme)?.piTheme;
}

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
  look: WebLook,
  sources: (urls: SessionUrls) => HubSources
): { hub: SessionHub; web: WebServer; token: string; setBase: (base: string) => void } {
  const token = randomToken();
  const statusToken = randomToken();
  const state = {
    base: "",
    settings: look.settings,
    notify: (): void => undefined,
    notifySettings: (settings: PiWebSettings): void => {
      void settings;
    }
  };
  const hub = new SessionHub({
    startControls: () => {
      const piTheme = piThemeOf(look, state.settings);
      return piTheme === undefined ? [] : [{ theme: piTheme }];
    },
    ...sources({
      status: (key) => `${state.base}/api/status/${encodeURIComponent(key)}?token=${statusToken}`,
      control: (key) => `${state.base}/api/control/${encodeURIComponent(key)}?token=${statusToken}`
    }),
    onChange: () => {
      state.notify();
    }
  });
  const settings: SettingsState = {
    current: () => state.settings,
    update: async (change) => {
      const next = mergeSettings(state.settings, change, look.themes);
      const piTheme = piThemeOf(look, next);
      const themeChanged = piTheme !== undefined && piTheme !== piThemeOf(look, state.settings);
      state.settings = next;
      await saveSettings(look.settingsPath, next);
      if (themeChanged) hub.broadcast({ theme: piTheme });
      state.notifySettings(next);
      return next;
    }
  };
  const web = createWebServer({
    hub,
    token,
    statusToken,
    title: app.name,
    themes: look.themes,
    settings,
    fontFamily: look.fontFamily,
    logo: look.logo,
    assets: webAssets(),
    hosts: [...(options.host === undefined ? [] : [options.host]), ...(options.allowedHosts ?? [])]
  });
  state.notify = () => {
    web.notify();
  };
  state.notifySettings = (next) => {
    web.notifySettings(next);
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
function uiDir(): string {
  return fileURLToPath(new URL("../ui/", import.meta.url));
}

export function webAssets(): Readonly<Record<string, string>> {
  const ui = uiDir();
  const require = createRequire(import.meta.url);
  const ghosttyDir = dirname(require.resolve("ghostty-web"));
  const font = (file: string): string =>
    require.resolve(`@fontsource/monaspace-argon/files/monaspace-argon-latin-${file}.woff2`);
  return {
    "/fonts/monaspace-argon-400.woff2": font("400-normal"),
    "/fonts/monaspace-argon-400-italic.woff2": font("400-italic"),
    "/fonts/monaspace-argon-700.woff2": font("700-normal"),
    "/fonts/monaspace-argon-700-italic.woff2": font("700-italic"),
    "/index.html": join(ui, "index.html"),
    "/app.js": join(ui, "app.js"),
    "/style.css": join(ui, "style.css"),
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
