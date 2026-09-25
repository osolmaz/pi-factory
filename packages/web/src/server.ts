import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { SessionHub } from "./sessions.js";
import type { PiWebSettings, PiWebThemeChoice, SessionStatus, StatusUpdate } from "./types.js";

/** The server-wide settings, which the page reads and changes. */
export type SettingsState = {
  current(): PiWebSettings;
  /** Validate and apply a change from the page; throws on a bad value. */
  update(change: unknown): Promise<PiWebSettings>;
};

export type WebServerDeps = {
  readonly hub: SessionHub;
  /** Required on every page request, API call, and WebSocket. */
  readonly token: string;
  /** Required on status updates, which come from Pi processes, not from the page. */
  readonly statusToken: string;
  readonly title: string;
  readonly themes: readonly PiWebThemeChoice[];
  readonly settings: SettingsState;
  readonly fontFamily: string;
  /** Image file for the sidebar logo and the favicon. */
  readonly logo: string;
  /** Maps a public path such as `/app.js` to a file on disk. */
  readonly assets: Readonly<Record<string, string>>;
  /** Host names the server answers to, besides the loopback names. */
  readonly hosts?: readonly string[];
};

export type WebServer = {
  readonly server: Server;
  /** Send the current session list to every open page. */
  notify(): void;
  /** Send changed settings to every open page. */
  notifySettings(settings: PiWebSettings): void;
  close(): Promise<void>;
};

const maxBodyBytes = 64 * 1024;
// A status extension holds one control request open this long before it asks again.
const controlWaitMs = 25_000;
const statuses: readonly SessionStatus[] = ["starting", "idle", "responding", "waiting", "exited"];
const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const pages = new Set<WebSocket>();
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    handleRequest(deps, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Everything here handles untrusted input outside the HTTP error handler, so any failure,
    // such as a request target that URL cannot parse, only drops this socket.
    try {
      upgradeSocket(deps, pages, sockets, { request, socket, head });
    } catch {
      socket.destroy();
    }
  });
  // Lists are computed asynchronously, so an older list can finish after a newer one. Only the
  // newest request may reach the pages.
  let latest = 0;
  const notify = (): void => {
    const request = (latest += 1);
    void deps.hub.summaries().then((sessions) => {
      if (request !== latest) return;
      const message = JSON.stringify({ type: "sessions", sessions });
      for (const page of pages) page.send(message);
    });
  };
  const close = async (): Promise<void> => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  const notifySettings = (settings: PiWebSettings): void => {
    const message = JSON.stringify({ type: "settings", settings });
    for (const page of pages) page.send(message);
  };
  return { server, notify, notifySettings, close };
}

type Upgrade = {
  readonly request: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
};

function upgradeSocket(
  deps: WebServerDeps,
  pages: Set<WebSocket>,
  sockets: WebSocketServer,
  upgrade: Upgrade
): void {
  const url = requestUrl(upgrade.request);
  if (!allowedSocket(upgrade.request, url, deps)) {
    upgrade.socket.destroy();
    return;
  }
  sockets.handleUpgrade(upgrade.request, upgrade.socket, upgrade.head, (ws) => {
    try {
      acceptSocket(deps, pages, ws, url);
    } catch {
      // A malformed path, such as a bad percent escape, must not stop the server.
      ws.close(4400, "bad request");
    }
  });
}

async function handleRequest(
  deps: WebServerDeps,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = requestUrl(request);
  if (!allowedHost(request, deps.hosts)) {
    throw new HttpError(403, "host not allowed");
  }
  if (url.pathname.startsWith("/api/status/") || url.pathname.startsWith("/api/control/")) {
    await handleSessionChannel(deps, request, response, url);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    requireToken(url, deps.token);
    await handleApi(deps, request, response, url);
    return;
  }
  await serveAsset(deps, response, url);
}

async function handleApi(
  deps: WebServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const route = `${request.method ?? "GET"} ${url.pathname}`;
  if (route === "GET /api/config") {
    sendJson(response, 200, {
      title: deps.title,
      themes: deps.themes,
      settings: deps.settings.current(),
      fontFamily: deps.fontFamily
    });
    return;
  }
  if (route === "POST /api/settings") {
    const change = await readJson(request);
    try {
      sendJson(response, 200, { settings: await deps.settings.update(change) });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (route === "GET /api/sessions") {
    sendJson(response, 200, { sessions: await deps.hub.summaries() });
    return;
  }
  if (route === "POST /api/sessions") {
    const body = asRecord(await readJson(request));
    const sessionFile = optionalString(body["sessionFile"], "sessionFile");
    sendJson(response, 200, { key: await deps.hub.open(sessionFile) });
    return;
  }
  await handleSessionAction(deps, route, request, response);
}

async function handleSessionAction(
  deps: WebServerDeps,
  route: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (route !== "POST /api/sessions/rename" && route !== "POST /api/sessions/delete") {
    throw new HttpError(404, "not found");
  }
  const body = asRecord(await readJson(request));
  const key = requiredString(body["key"], "key");
  try {
    if (route === "POST /api/sessions/rename") {
      await deps.hub.rename(key, requiredString(body["name"], "name"));
    } else {
      await deps.hub.remove(key);
    }
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  sendJson(response, 200, { ok: true });
}

// Requests from the status extensions: status updates in, control requests out.
async function handleSessionChannel(
  deps: WebServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  requireToken(url, deps.statusToken);
  const control = url.pathname.startsWith("/api/control/");
  const prefix = control ? "/api/control/" : "/api/status/";
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  if (control && request.method === "GET") {
    const next = await deps.hub.nextControl(key, controlWaitMs);
    if (next === undefined) response.writeHead(204).end();
    else sendJson(response, 200, next);
    return;
  }
  if (control || request.method !== "POST") {
    throw new HttpError(405, "method not allowed");
  }
  deps.hub.update(key, parseStatusUpdate(await readJson(request)));
  response.writeHead(204).end();
}

export function parseStatusUpdate(value: unknown): StatusUpdate {
  const body = asRecord(value);
  const status = optionalString(body["status"], "status");
  if (status !== undefined && !statuses.some((entry) => entry === status)) {
    throw new HttpError(400, `unknown status ${status}`);
  }
  const sessionFile = optionalString(body["sessionFile"], "sessionFile");
  const name = optionalString(body["name"], "name");
  return {
    ...(status === undefined ? {} : { status: status as SessionStatus }),
    ...(sessionFile === undefined ? {} : { sessionFile }),
    ...(name === undefined ? {} : { name })
  };
}

async function serveAsset(deps: WebServerDeps, response: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path === "/logo" ? deps.logo : deps.assets[path];
  if (file === undefined) {
    throw new HttpError(404, "not found");
  }
  if (path === "/index.html") {
    requireToken(url, deps.token);
  }
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  response.writeHead(200, {
    "content-type": contentTypes[extension] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(await readFile(file));
}

function acceptSocket(deps: WebServerDeps, pages: Set<WebSocket>, ws: WebSocket, url: URL): void {
  if (url.pathname === "/api/events") {
    pages.add(ws);
    ws.on("close", () => pages.delete(ws));
    void deps.hub.summaries().then((sessions) => {
      ws.send(JSON.stringify({ type: "sessions", sessions }));
    });
    return;
  }
  const key = decodeURIComponent(url.pathname.slice("/api/terminal/".length));
  if (!url.pathname.startsWith("/api/terminal/") || !deps.hub.has(key)) {
    ws.close(4404, "unknown session");
    return;
  }
  attachTerminal(deps.hub, ws, key, url);
}

function attachTerminal(hub: SessionHub, ws: WebSocket, key: string, url: URL): void {
  const detach = hub.attach(
    key,
    {
      data: (data) => {
        ws.send(data);
      },
      exit: () => {
        ws.close(4410, "session ended");
      }
    },
    positiveInt(url.searchParams.get("cols"), 120),
    positiveInt(url.searchParams.get("rows"), 40)
  );
  ws.on("message", (raw) => {
    handleTerminalMessage(hub, key, rawText(raw));
  });
  ws.on("close", detach);
}

function handleTerminalMessage(hub: SessionHub, key: string, raw: string): void {
  const message = parseMessage(raw);
  if (message?.type === "input" && typeof message.data === "string") {
    hub.input(key, message.data);
  } else if (message?.type === "resize") {
    hub.resize(key, positiveInt(String(message.cols), 120), positiveInt(String(message.rows), 40));
  }
}

type TerminalMessage = {
  readonly type?: unknown;
  readonly data?: unknown;
  cols?: unknown;
  rows?: unknown;
};

function parseMessage(raw: string): TerminalMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function rawText(raw: unknown): string {
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
}

// Only the page served by this server may open a socket: the Origin must match the Host, and the
// Host must be a loopback name or a host the app allowed, which also blocks DNS rebinding.
function allowedSocket(request: IncomingMessage, url: URL, deps: WebServerDeps): boolean {
  const origin = request.headers.origin ?? "";
  const host = request.headers.host ?? "";
  return (
    allowedHost(request, deps.hosts) &&
    (origin === `http://${host}` || origin === `https://${host}`) &&
    url.searchParams.get("token") === deps.token
  );
}

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

function allowedHost(request: IncomingMessage, extra: readonly string[] = []): boolean {
  const host = request.headers.host ?? "";
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return [...loopbackHosts, ...extra].some((allowed) => allowed === name);
}

function requireToken(url: URL, token: string): void {
  if (url.searchParams.get("token") !== token) {
    throw new HttpError(403, "missing or wrong token");
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBodyBytes) throw new HttpError(413, "body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value, field);
  if (text === undefined) throw new HttpError(400, `${field} is required`);
  return text;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 10_000 ? parsed : fallback;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  sendJson(response, status, { error: message });
}
