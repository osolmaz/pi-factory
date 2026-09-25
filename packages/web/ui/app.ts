import type { FitAddon as GhosttyFitAddon, ITheme, Terminal as GhosttyTerminal } from "ghostty-web";

type GhosttyModule = typeof import("ghostty-web");

type Theme = Record<string, string>;

type SessionSummary = {
  readonly key: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly live: boolean;
  readonly status: string | undefined;
  readonly sessionFile: string | undefined;
};

type Attached = {
  readonly key: string;
  readonly term: GhosttyTerminal;
  readonly socket: WebSocket;
  readonly fit: GhosttyFitAddon;
};

// The module path is served by the web runner; a variable keeps TypeScript from resolving it.
const ghosttyPath = "/vendor/ghostty-web.js";
const token = new URLSearchParams(location.search).get("token") ?? "";
const element = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let ghostty: GhosttyModule | undefined;
let theme: Theme = {};
let fontFamily = "monospace";
let sessions: readonly SessionSummary[] = [];
let attached: Attached | undefined;
// While a rename box is open, list updates wait, so a re-render does not throw the edit away.
let renaming = false;

async function main(): Promise<void> {
  const [module, config] = await Promise.all([
    import(ghosttyPath) as Promise<GhosttyModule>,
    api<{ title: string; theme: Theme; fontFamily: string }>("GET", "/api/config")
  ]);
  fontFamily = config.fontFamily;
  await loadFonts(config.fontFamily);
  await module.init();
  ghostty = module;
  theme = config.theme;
  document.title = config.title;
  element("app-title").textContent = config.title;
  applyTheme(config.theme);
  element("new-session").addEventListener("click", () => {
    void openSession(undefined);
  });
  connectEvents();
  window.addEventListener("resize", () => attached?.fit.fit());
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
}

// The terminal draws on a canvas, which does not wait for web fonts, so load them first. A font
// that fails to load leaves the rest of the list as the fallback.
async function loadFonts(family: string): Promise<void> {
  const loads = ["400", "700", "italic 400", "italic 700"].map((style) =>
    document.fonts.load(`${style} 14px ${family}`)
  );
  await Promise.allSettled(loads);
}

function applyTheme(colors: Theme): void {
  const root = document.documentElement.style;
  const variables: Record<string, string | undefined> = {
    "--background": colors["background"],
    "--foreground": colors["foreground"],
    "--sidebar-background": colors["sidebarBackground"],
    "--sidebar-foreground": colors["sidebarForeground"],
    "--muted": colors["mutedForeground"],
    "--accent": colors["accent"],
    "--selected": colors["selectedBackground"],
    "--border": colors["border"],
    "--waiting": colors["yellow"]
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) root.setProperty(name, value);
  }
}

function connectEvents(): void {
  const socket = new WebSocket(socketUrl("/api/events"));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { sessions?: SessionSummary[] };
    if (message.sessions !== undefined) {
      sessions = message.sessions;
      renderSessions();
    }
  });
  socket.addEventListener("close", () => {
    window.setTimeout(connectEvents, 1000);
  });
}

function renderSessions(): void {
  if (renaming) return;
  const nav = element("sessions");
  nav.replaceChildren();
  let group = "";
  for (const session of sessions) {
    const label = dayLabel(session.updatedAt);
    if (label !== group) {
      group = label;
      nav.append(groupHeading(label));
    }
    nav.append(sessionRow(session));
  }
}

function groupHeading(label: string): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "group";
  heading.textContent = label;
  return heading;
}

function sessionRow(session: SessionSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = session.key === attached?.key ? "session selected" : "session";
  row.tabIndex = 0;
  row.title = session.title;
  const dot = document.createElement("span");
  dot.className = `dot ${session.status ?? ""}`;
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = session.title;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "more";
  more.textContent = "⋯";
  more.setAttribute("aria-label", `Actions for ${session.title}`);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(more, session, title);
  });
  row.append(dot, title, more);
  row.addEventListener("click", () => {
    void openSession(session);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === row) void openSession(session);
  });
  return row;
}

function openMenu(anchor: HTMLElement, session: SessionSummary, title: HTMLElement): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.id = "menu";
  menu.setAttribute("role", "menu");
  menu.append(
    menuItem("Rename", () => {
      startRename(session, title);
    }),
    menuItem("Delete", () => {
      void deleteSession(session);
    })
  );
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${String(box.bottom + 4)}px`;
  menu.style.left = `${String(box.left)}px`;
  document.body.append(menu);
  (menu.firstElementChild as HTMLElement).focus();
}

function menuItem(label: string, action: () => void): HTMLElement {
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    closeMenu();
    action();
  });
  return item;
}

function closeMenu(): void {
  document.getElementById("menu")?.remove();
}

function startRename(session: SessionSummary, title: HTMLElement): void {
  const input = document.createElement("input");
  input.className = "rename";
  input.value = session.title;
  input.setAttribute("aria-label", "Session name");
  let done = false;
  renaming = true;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    renaming = false;
    const name = input.value.trim();
    input.replaceWith(title);
    if (save && name !== "" && name !== session.title) {
      title.textContent = name;
      void api("POST", "/api/sessions/rename", { key: session.key, name });
    }
    renderSessions();
  };
  input.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => {
    finish(true);
  });
  title.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSession(session: SessionSummary): Promise<void> {
  if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) return;
  if (attached?.key === session.key) detach();
  await api("POST", "/api/sessions/delete", { key: session.key });
}

function dayLabel(time: number): string {
  const day = new Date(time).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function openSession(session: SessionSummary | undefined): Promise<void> {
  if (session?.live === true) {
    attach(session.key);
    return;
  }
  const body = session?.sessionFile === undefined ? {} : { sessionFile: session.sessionFile };
  const { key } = await api<{ key: string }>("POST", "/api/sessions", body);
  attach(key);
}

function attach(key: string): void {
  if (ghostty === undefined || attached?.key === key) {
    attached?.term.focus();
    return;
  }
  detach();
  const term = new ghostty.Terminal({
    fontSize: 14,
    fontFamily,
    cursorBlink: true,
    theme: terminalTheme()
  });
  const fit = new ghostty.FitAddon();
  term.loadAddon(fit);
  term.open(element("terminal"));
  fit.fit();
  const socket = new WebSocket(
    socketUrl(`/api/terminal/${encodeURIComponent(key)}`, { cols: term.cols, rows: term.rows })
  );
  attached = { key, term, socket, fit };
  wireTerminal(term, socket);
  element("empty").hidden = true;
  renderSessions();
  term.focus();
}

function wireTerminal(term: GhosttyTerminal, socket: WebSocket): void {
  const send = (data: string): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
  };
  socket.addEventListener("message", (event) => {
    term.write(String(event.data));
  });
  // The server closes the socket when the session's Pi process ends.
  socket.addEventListener("close", () => {
    if (attached?.socket === socket) detach();
  });
  term.onData(send);
  term.onResize(({ cols, rows }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
  term.attachCustomKeyEventHandler((event) => encodeModifiedLetter(event, send));
  term.attachCustomWheelEventHandler((event) => encodeWheel(term, event, send));
}

// ghostty-web has no Kitty keyboard protocol yet, so it sends Ctrl+Shift+letter as plain
// Ctrl+letter. Pi reads Kitty-style sequences, so the page encodes these keys itself. Returning
// true tells ghostty-web that the key is handled.
function encodeModifiedLetter(event: KeyboardEvent, send: (data: string) => void): boolean {
  const plain = event.altKey || event.metaKey || !event.ctrlKey || !event.shiftKey;
  if (event.type !== "keydown" || plain || !/^Key[A-Z]$/u.test(event.code)) {
    return false;
  }
  const codePoint = event.code.slice(3).toLowerCase().charCodeAt(0);
  send(`\x1b[${String(codePoint)};6u`);
  event.preventDefault();
  return true;
}

// ghostty-web turns the wheel into arrow keys even when the program asked for mouse reports, so
// the page reports it as SGR wheel events while mouse tracking is on.
function encodeWheel(
  term: GhosttyTerminal,
  event: WheelEvent,
  send: (data: string) => void
): boolean {
  if (!term.hasMouseTracking() || event.deltaY === 0) {
    return false;
  }
  const box = element("terminal").getBoundingClientRect();
  const col = cell(event.clientX - box.left, box.width, term.cols);
  const row = cell(event.clientY - box.top, box.height, term.rows);
  const steps = Math.max(1, Math.min(5, Math.round(Math.abs(event.deltaY) / 40)));
  const button = event.deltaY < 0 ? 64 : 65;
  send(`\x1b[<${String(button)};${String(col)};${String(row)}M`.repeat(steps));
  event.preventDefault();
  return true;
}

function cell(offset: number, size: number, count: number): number {
  return Math.min(count, Math.max(1, Math.floor((offset / size) * count) + 1));
}

function detach(): void {
  if (attached === undefined) return;
  attached.socket.close();
  attached.term.dispose();
  attached = undefined;
  element("terminal").replaceChildren();
  element("empty").hidden = false;
}

function terminalTheme(): ITheme {
  const names = [
    "background",
    "foreground",
    "cursor",
    "selectionBackground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite"
  ];
  return Object.fromEntries(
    names.filter((name) => theme[name] !== undefined).map((name) => [name, theme[name]])
  );
}

function socketUrl(path: string, extra: Record<string, number> = {}): string {
  const params = new URLSearchParams({ token });
  for (const [name, value] of Object.entries(extra)) params.set(name, String(value));
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${path}?${params.toString()}`;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${path}?token=${encodeURIComponent(token)}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

void main();
