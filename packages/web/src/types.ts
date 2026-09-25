/** Colors for the browser page and the terminal. Every field is a CSS color. */
export type PiWebTheme = {
  readonly background: string;
  readonly foreground: string;
  readonly sidebarBackground: string;
  readonly sidebarForeground: string;
  readonly mutedForeground: string;
  readonly accent: string;
  readonly selectedBackground: string;
  readonly border: string;
  readonly cursor: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
};

export type PiWebOptions = {
  /**
   * Interface to listen on. Default: 127.0.0.1. A non-loopback address, such as a Tailscale
   * address, makes the app reachable from that network; the access token still protects it.
   */
  readonly host?: string;
  /** Extra host names the page may be opened under, such as a Tailscale MagicDNS name. */
  readonly allowedHosts?: readonly string[];
  /** Port to listen on. Default: 0, which picks a free port. */
  readonly port?: number;
  /** Open the page in the default browser. Default: true. */
  readonly open?: boolean;
  /** Working directory for new Pi sessions. Default: the app root or the current directory. */
  readonly cwd?: string;
  /** Page and terminal colors. Default: Catppuccin Latte. */
  readonly theme?: PiWebTheme;
  /** Called with the page URL once the server listens. */
  readonly onReady?: (url: string) => void;
};

/** What a session's agent is doing, as reported by the status extension. */
export type SessionStatus = "starting" | "idle" | "responding" | "waiting" | "exited";

/** One row in the session list. */
export type SessionSummary = {
  /** Stable key for this row: the live process key, or the session file for a stored session. */
  readonly key: string;
  readonly title: string;
  /** Last activity time in milliseconds since the epoch. */
  readonly updatedAt: number;
  readonly live: boolean;
  readonly status: SessionStatus | undefined;
  readonly sessionFile: string | undefined;
};

/** A session that Pi stored on disk. */
export type StoredSession = {
  readonly path: string;
  readonly title: string;
  readonly updatedAt: number;
};

/** A status update that the status extension sends for one live session. */
export type StatusUpdate = {
  readonly status?: SessionStatus;
  readonly sessionFile?: string;
  readonly name?: string;
};
