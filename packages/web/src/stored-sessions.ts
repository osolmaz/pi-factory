import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

import type { StoredSession } from "./types.js";

const maxTitleLength = 80;

/** Read the sessions that Pi stored for this app and working directory. */
export async function listStoredSessions(
  cwd: string,
  sessionDir: string
): Promise<readonly StoredSession[]> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.filter((session) => session.messageCount > 0).map(storedSession);
}

export function storedSession(info: SessionInfo): StoredSession {
  return {
    path: info.path,
    title: sessionTitle(info),
    updatedAt: info.modified.getTime()
  };
}

function sessionTitle(info: Pick<SessionInfo, "name" | "firstMessage">): string {
  const text = (info.name ?? info.firstMessage).replace(/\s+/gu, " ").trim();
  if (text === "") {
    return "Untitled session";
  }
  return text.length > maxTitleLength ? `${text.slice(0, maxTitleLength - 1)}…` : text;
}

/**
 * Name a stored session the way Pi's /name command does: with a session_info entry. Only call this
 * for a session that no Pi process holds open.
 */
export function renameStoredSession(path: string, sessionDir: string, name: string): void {
  SessionManager.open(path, sessionDir).appendSessionInfo(name);
}

/** Delete a session file like Pi's session picker: through `trash` when it exists, else unlink. */
export async function deleteSessionFile(
  path: string,
  trash: (path: string) => boolean = moveToTrash
): Promise<void> {
  if (trash(path)) {
    return;
  }
  await unlink(path);
}

function moveToTrash(path: string): boolean {
  const args = path.startsWith("-") ? ["--", path] : [path];
  const result = spawnSync("trash", args, { encoding: "utf8" });
  return result.error === undefined && result.status === 0;
}
