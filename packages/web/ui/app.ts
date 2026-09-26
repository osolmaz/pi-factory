import type { FitAddon as GhosttyFitAddon, ITheme, Terminal as GhosttyTerminal } from "ghostty-web";

type GhosttyModule = typeof import("ghostty-web");

type Theme = Record<string, string>;

type ThemeChoice = {
  readonly id: string;
  readonly label: string;
  readonly theme: Theme;
  readonly accents: Record<string, string>;
};

type Settings = { theme: string; accent: string | undefined; fontSize: number };

const fontSizes = [11, 12, 13, 14, 15, 16, 18, 20];

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
  // False until the session reports a state other than "starting". A new session is not in the
  // list yet when it is attached, so it starts as not ready.
  ready: boolean;
};

// How long the loading view waits for a session to report that it is ready.
const loadingTimeoutMs = 120_000;
// The module path is served by the web runner; a variable keeps TypeScript from resolving it.
const ghosttyPath = "/vendor/ghostty-web.js";
const token = new URLSearchParams(location.search).get("token") ?? "";
const element = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let ghostty: GhosttyModule | undefined;
let theme: Theme = {};
let themes: readonly ThemeChoice[] = [];
let settings: Settings = { theme: "", accent: undefined, fontSize: 14 };
let fontFamily = "monospace";
let appTitle = "";
let sessions: readonly SessionSummary[] = [];
let attached: Attached | undefined;
// While a rename box is open, list updates wait, so a re-render does not throw the edit away.
let renaming = false;
// The first session list decides whether the page starts a session on its own.
let firstList = true;

async function main(): Promise<void> {
  const [module, config] = await Promise.all([
    import(ghosttyPath) as Promise<GhosttyModule>,
    api<{ title: string; themes: ThemeChoice[]; settings: Settings; fontFamily: string }>(
      "GET",
      "/api/config"
    )
  ]);
  fontFamily = config.fontFamily;
  await loadFonts(config.fontFamily);
  await module.init();
  ghostty = module;
  themes = config.themes;
  appTitle = config.title;
  updateWindowTitle();
  element("app-title").textContent = config.title;
  applySettings(config.settings);
  setUpSettingsPanel();
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

// Apply settings from the server: page colors, accent, and a terminal view with the new look.
function applySettings(next: Settings): void {
  const changedTerminal = next.theme !== settings.theme || next.fontSize !== settings.fontSize;
  settings = next;
  const choice = themes.find((entry) => entry.id === next.theme) ?? themes[0];
  theme = choice?.theme ?? {};
  applyTheme(theme, accentColor(choice, next.accent));
  renderSettingsPanel();
  if (changedTerminal && attached !== undefined) {
    const key = attached.key;
    detach();
    attach(key);
  }
}

function accentColor(
  choice: ThemeChoice | undefined,
  name: string | undefined
): string | undefined {
  return name === undefined ? undefined : choice?.accents[name];
}

function setUpSettingsPanel(): void {
  const button = element("settings-button");
  const panel = element("settings-panel");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
  panel.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.addEventListener("click", () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
  element("theme-select").addEventListener("change", (event) => {
    void changeSettings({ theme: (event.target as HTMLSelectElement).value });
  });
  element("font-size-select").addEventListener("change", (event) => {
    void changeSettings({ fontSize: Number((event.target as HTMLSelectElement).value) });
  });
}

function renderSettingsPanel(): void {
  const select = element("theme-select") as HTMLSelectElement;
  select.replaceChildren(...themes.map((choice) => option(choice.id, choice.label)));
  select.value = settings.theme;
  const sizes = element("font-size-select") as HTMLSelectElement;
  sizes.replaceChildren(...fontSizes.map((size) => option(String(size), `${String(size)} px`)));
  sizes.value = String(settings.fontSize);
  const accents = themes.find((entry) => entry.id === settings.theme)?.accents ?? {};
  element("accent-swatches").replaceChildren(
    ...Object.entries(accents).map(([name, color]) => swatch(name, color))
  );
}

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function swatch(name: string, color: string): HTMLElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "swatch";
  item.style.background = color;
  item.title = name;
  item.setAttribute("role", "radio");
  item.setAttribute("aria-label", name);
  item.setAttribute("aria-checked", String(settings.accent === name));
  item.addEventListener("click", () => {
    void changeSettings({ accent: settings.accent === name ? null : name });
  });
  return item;
}

async function changeSettings(change: Record<string, unknown>): Promise<void> {
  const result = await api<{ settings: Settings }>("POST", "/api/settings", change);
  applySettings(result.settings);
}

function applyTheme(colors: Theme, accent: string | undefined): void {
  const root = document.documentElement.style;
  const variables: Record<string, string | undefined> = {
    "--background": colors["background"],
    "--foreground": colors["foreground"],
    "--sidebar-background": colors["sidebarBackground"],
    "--sidebar-foreground": colors["sidebarForeground"],
    "--muted": colors["mutedForeground"],
    "--accent": accent ?? colors["accent"],
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
    const message = JSON.parse(String(event.data)) as {
      sessions?: SessionSummary[];
      settings?: Settings;
    };
    if (message.sessions !== undefined) {
      sessions = message.sessions;
      renderSessions();
      startFirstSession();
    }
    if (message.settings !== undefined) applySettings(message.settings);
  });
  socket.addEventListener("close", () => {
    window.setTimeout(connectEvents, 1000);
  });
}

// On a first run there is nothing to pick, so the page starts a session instead of an empty view.
// Only the first list of this page load counts, so a reconnect or a deleted last session does not
// start one.
function startFirstSession(): void {
  if (!firstList) return;
  firstList = false;
  if (sessions.length === 0 && attached === undefined) void openSession(undefined);
}

// While the attached session's Pi starts, the terminal is blank, so the page shows that it loads.
function renderLoading(): void {
  if (attached !== undefined && !attached.ready) {
    const status = sessions.find((entry) => entry.key === attached?.key)?.status;
    attached.ready = status !== undefined && status !== "starting" && status !== "exited";
  }
  element("loading-title").textContent = `Starting ${appTitle}…`;
  element("loading").hidden = attached === undefined || attached.ready;
}

// The browser tab shows the selected session's name next to the app name.
function updateWindowTitle(): void {
  const session = sessions.find((entry) => entry.key === attached?.key);
  document.title = session === undefined ? appTitle : `${session.title} · ${appTitle}`;
}

function renderSessions(): void {
  updateWindowTitle();
  renderLoading();
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
    fontSize: settings.fontSize,
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
  const current: Attached = { key, term, socket, fit, ready: false };
  attached = current;
  // If the session never reports that it is ready, for example because its status extension
  // failed, the terminal must not stay hidden, so the loading view gives up after a while.
  window.setTimeout(() => {
    if (attached !== current || current.ready) return;
    current.ready = true;
    renderLoading();
  }, loadingTimeoutMs);
  wireTerminal(term, socket);
  element("empty").hidden = true;
  renderSessions();
  term.focus();
}

function wireTerminal(term: GhosttyTerminal, socket: WebSocket): void {
  const send = (data: string): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
  };
  const clipboard = osc52Reader();
  socket.addEventListener("message", (event) => {
    const data = String(event.data);
    clipboard(data);
    term.write(data);
  });
  // The server closes the socket when the session's Pi process ends.
  socket.addEventListener("close", () => {
    if (attached?.socket !== socket) return;
    const starting = !attached.ready;
    detach();
    if (starting) showNotice(`${appTitle} stopped before it was ready.`);
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

// Pi copies a fullscreen selection with OSC 52 (ESC ] 52 ; c ; base64 BEL), like the native Ghostty
// app expects. ghostty-web ignores OSC 52, so the page reads the sequence from the output and writes
// the clipboard. A sequence can span WebSocket messages, so an unfinished one waits for the rest.
// The browser allows the clipboard only in a secure context: HTTPS or localhost.
const osc52Start = "\x1b]52;";
const maxPendingOsc52 = 4 * 1024 * 1024;

function osc52Reader(): (data: string) => void {
  let pending = "";
  return (data) => {
    let text = pending + data;
    pending = "";
    for (;;) {
      const start = text.indexOf(osc52Start);
      if (start < 0) {
        pending = partialPrefix(text);
        return;
      }
      const rest = text.slice(start);
      const end = osc52End(rest);
      if (end === undefined) {
        pending = rest.length > maxPendingOsc52 ? "" : rest;
        return;
      }
      copyOsc52(rest.slice(osc52Start.length, end.index));
      text = rest.slice(end.index + end.length);
    }
  };
}

// The end of a message can hold the first characters of the prefix; keep them for the next one.
function partialPrefix(text: string): string {
  for (let length = Math.min(osc52Start.length - 1, text.length); length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (osc52Start.startsWith(tail)) return tail;
  }
  return "";
}

function osc52End(text: string): { index: number; length: number } | undefined {
  const bell = text.indexOf("\x07");
  const st = text.indexOf("\x1b\\");
  if (bell < 0 && st < 0) return undefined;
  if (st < 0 || (bell >= 0 && bell < st)) return { index: bell, length: 1 };
  return { index: st, length: 2 };
}

function copyOsc52(body: string): void {
  const payload = body.slice(body.indexOf(";") + 1);
  // "?" asks to read the clipboard, which a page must not answer.
  if (payload === "?") return;
  // Pi shows "Copied" in any case, so say plainly when the browser did not take the text.
  if (!window.isSecureContext) {
    showNotice(
      "Not copied to your clipboard: browsers allow copying only on HTTPS or localhost. " +
        "Open this page over HTTPS, or on localhost, for example through an SSH tunnel."
    );
    return;
  }
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch {
    return;
  }
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    showNotice(`Not copied to your clipboard: the browser refused (${reason}).`);
  });
}

let noticeTimer: number | undefined;

function showNotice(text: string): void {
  const notice = element("notice");
  notice.textContent = text;
  notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.hidden = true;
  }, 6000);
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
  renderLoading();
  updateWindowTitle();
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
