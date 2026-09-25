import { randomUUID } from "node:crypto";

import type { SessionStatus, SessionSummary, StatusUpdate, StoredSession } from "./types.js";

/** The part of a PTY that the hub uses. node-pty's IPty satisfies it. */
export type SessionTerminal = {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: () => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type SpawnSession = (input: {
  readonly key: string;
  readonly sessionFile: string | undefined;
  readonly cols: number;
  readonly rows: number;
}) => Promise<SessionTerminal>;

export type SessionHubDeps = {
  readonly spawn: SpawnSession;
  readonly listStored: () => Promise<readonly StoredSession[]>;
  /** Name a stored session that no process holds open. */
  readonly renameStored: (path: string, name: string) => Promise<void>;
  readonly deleteStored: (path: string) => Promise<void>;
  readonly onChange: () => void;
  readonly now?: () => number;
};

/** A request for a live session's Pi, picked up by its status extension. */
export type SessionControl = { readonly rename: string };

/** One viewer of a live session. */
export type SessionViewer = {
  readonly data: (data: string) => void;
  readonly exit: () => void;
};

type LiveSession = {
  readonly key: string;
  readonly terminal: SessionTerminal;
  readonly exited: Promise<void>;
  readonly controls: SessionControl[];
  waiter: ((control: SessionControl | undefined) => void) | undefined;
  readonly viewers: Set<SessionViewer>;
  status: SessionStatus;
  sessionFile: string | undefined;
  name: string | undefined;
  updatedAt: number;
  output: string;
  cols: number;
  rows: number;
};

// Enough output to redraw a fullscreen TUI and some history, without holding a whole day of logs.
const maxReplayChars = 2_000_000;
const maxNameLength = 200;
const defaultCols = 120;
const defaultRows = 40;

/**
 * Keeps one Pi process per open session and the list of all sessions.
 *
 * A live session keeps running when no browser is attached. Attaching replays the recent output
 * and resizes the PTY, so the TUI redraws for the new viewer.
 */
export class SessionHub {
  private readonly live = new Map<string, LiveSession>();
  private readonly now: () => number;

  constructor(private readonly deps: SessionHubDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Open a new session, or resume a stored one. A session that already runs is reused. */
  async open(sessionFile?: string): Promise<string> {
    const running = sessionFile === undefined ? undefined : this.findByFile(sessionFile);
    if (running !== undefined) {
      return running.key;
    }
    const key = randomUUID();
    const terminal = await this.deps.spawn({
      key,
      sessionFile,
      cols: defaultCols,
      rows: defaultRows
    });
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolveExit) => {
      markExited = resolveExit;
    });
    const session: LiveSession = {
      key,
      terminal,
      exited,
      controls: [],
      waiter: undefined,
      viewers: new Set(),
      status: "starting",
      sessionFile,
      name: undefined,
      updatedAt: this.now(),
      output: "",
      cols: defaultCols,
      rows: defaultRows
    };
    this.live.set(key, session);
    terminal.onData((data) => {
      this.record(session, data);
    });
    terminal.onExit(() => {
      this.live.delete(key);
      for (const viewer of session.viewers) viewer.exit();
      session.waiter?.(undefined);
      markExited();
      this.deps.onChange();
    });
    this.deps.onChange();
    return key;
  }

  has(key: string): boolean {
    return this.live.has(key);
  }

  /** Stream a session to one viewer. Returns a function that detaches the viewer. */
  attach(key: string, viewer: SessionViewer, cols: number, rows: number): () => void {
    const session = this.require(key);
    session.viewers.add(viewer);
    if (session.output !== "") {
      viewer.data(session.output);
    }
    this.redraw(session, cols, rows);
    return () => {
      session.viewers.delete(viewer);
    };
  }

  input(key: string, data: string): void {
    this.live.get(key)?.terminal.write(data);
  }

  resize(key: string, cols: number, rows: number): void {
    const session = this.live.get(key);
    if (session === undefined) {
      return;
    }
    session.cols = cols;
    session.rows = rows;
    session.terminal.resize(cols, rows);
  }

  /** Apply a status update from the session's status extension. */
  update(key: string, update: StatusUpdate): void {
    const session = this.live.get(key);
    if (session === undefined) {
      return;
    }
    if (update.status !== undefined) session.status = update.status;
    if (update.sessionFile !== undefined) session.sessionFile = update.sessionFile;
    if (update.name !== undefined) session.name = update.name === "" ? undefined : update.name;
    session.updatedAt = this.now();
    this.deps.onChange();
  }

  /** Every session, live ones merged with the stored ones, newest first. */
  async summaries(): Promise<readonly SessionSummary[]> {
    const stored = await this.deps.listStored();
    const liveFiles = new Map<string, LiveSession>();
    for (const session of this.live.values()) {
      if (session.sessionFile !== undefined) liveFiles.set(session.sessionFile, session);
    }
    const rows: SessionSummary[] = [...this.live.values()].map((session) =>
      liveSummary(session, stored)
    );
    for (const entry of stored) {
      if (!liveFiles.has(entry.path)) rows.push(storedSummary(entry));
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /** Rename a session. A live session renames itself through Pi, so Pi writes the entry. */
  async rename(key: string, name: string): Promise<void> {
    const clean = name.replace(/\s+/gu, " ").trim().slice(0, maxNameLength);
    if (clean === "") {
      throw new Error("a session name must not be empty");
    }
    const session = this.live.get(key);
    if (session !== undefined) {
      this.sendControl(session, { rename: clean });
      return;
    }
    await this.deps.renameStored(await this.storedPath(key), clean);
    this.deps.onChange();
  }

  /** Delete a session. A live session's Pi stops first, so nothing writes the file afterwards. */
  async remove(key: string): Promise<void> {
    const session = this.live.get(key);
    const file = session === undefined ? await this.storedPath(key) : session.sessionFile;
    if (session !== undefined) {
      session.terminal.kill();
      await session.exited;
    }
    const stored = await this.deps.listStored();
    if (file !== undefined && stored.some((entry) => entry.path === file)) {
      await this.deps.deleteStored(file);
    }
    this.deps.onChange();
  }

  /** Wait for the next request for a live session, or undefined after the timeout. */
  async nextControl(key: string, timeoutMs: number): Promise<SessionControl | undefined> {
    const session = this.live.get(key);
    if (session === undefined) return undefined;
    const queued = session.controls.shift();
    if (queued !== undefined) return queued;
    session.waiter?.(undefined);
    return await new Promise((resolveControl) => {
      const timer = setTimeout(() => {
        finish(undefined);
      }, timeoutMs);
      const finish = (control: SessionControl | undefined): void => {
        clearTimeout(timer);
        if (session.waiter === finish) session.waiter = undefined;
        resolveControl(control);
      };
      session.waiter = finish;
    });
  }

  stopAll(): void {
    for (const session of this.live.values()) {
      session.terminal.kill();
    }
    this.live.clear();
  }

  private record(session: LiveSession, data: string): void {
    session.output = (session.output + data).slice(-maxReplayChars);
    for (const viewer of session.viewers) {
      viewer.data(data);
    }
  }

  // A resize makes Pi draw its whole screen again. When the size did not change, a one-row nudge
  // forces the same full redraw for a viewer that just attached.
  private redraw(session: LiveSession, cols: number, rows: number): void {
    if (session.cols === cols && session.rows === rows) {
      session.terminal.resize(cols, Math.max(1, rows - 1));
    }
    this.resize(session.key, cols, rows);
  }

  private sendControl(session: LiveSession, control: SessionControl): void {
    const waiter = session.waiter;
    if (waiter === undefined) {
      session.controls.push(control);
      return;
    }
    session.waiter = undefined;
    waiter(control);
  }

  // A key that is not live must name a stored session, so the page cannot point at other files.
  private async storedPath(key: string): Promise<string> {
    const stored = await this.deps.listStored();
    const entry = stored.find((candidate) => candidate.path === key);
    if (entry === undefined) {
      throw new Error(`unknown session ${key}`);
    }
    return entry.path;
  }

  private findByFile(sessionFile: string): LiveSession | undefined {
    return [...this.live.values()].find((session) => session.sessionFile === sessionFile);
  }

  private require(key: string): LiveSession {
    const session = this.live.get(key);
    if (session === undefined) {
      throw new Error(`unknown session ${key}`);
    }
    return session;
  }
}

function liveSummary(session: LiveSession, stored: readonly StoredSession[]): SessionSummary {
  const file = stored.find((entry) => entry.path === session.sessionFile);
  return {
    key: session.key,
    title: session.name ?? file?.title ?? "New session",
    updatedAt: Math.max(session.updatedAt, file?.updatedAt ?? 0),
    live: true,
    status: session.status,
    sessionFile: session.sessionFile
  };
}

function storedSummary(entry: StoredSession): SessionSummary {
  return {
    key: entry.path,
    title: entry.title,
    updatedAt: entry.updatedAt,
    live: false,
    status: undefined,
    sessionFile: entry.path
  };
}
