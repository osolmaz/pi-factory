import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isValidPiAppId } from "./manifest.js";
import { authGrantStatePath, expandPath } from "./paths.js";

export type PiAuthGrant = {
  readonly source: "pi";
  readonly authFile: string;
};

type PiAuthGrantState = {
  readonly version: 1;
  readonly grants: Readonly<Record<string, PiAuthGrant>>;
};

const EMPTY_STATE: PiAuthGrantState = { version: 1, grants: {} };

export function defaultPiAuthFile(): string {
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(expandPath(agentDir), "auth.json");
}

export async function loadPiAuthGrants(): Promise<Readonly<Record<string, PiAuthGrant>>> {
  const statePath = authGrantStatePath();
  try {
    return validateState(JSON.parse(await readFile(statePath, "utf8")) as unknown, statePath)
      .grants;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return EMPTY_STATE.grants;
    if (error instanceof SyntaxError) {
      throw new Error(`failed to parse Pi Factory auth grants ${statePath}: ${error.message}`, {
        cause: error
      });
    }
    throw error;
  }
}

export async function getPiAuthGrant(appId: string): Promise<PiAuthGrant | undefined> {
  validatePiAuthGrantAppId(appId);
  const grants = await loadPiAuthGrants();
  if (!Object.hasOwn(grants, appId)) return undefined;
  const grant = grants[appId];
  if (grant === undefined) return undefined;
  return { ...grant, authFile: await validatePiAuthFile(grant.authFile) };
}

export async function grantPiAuth(
  appId: string,
  authFile = defaultPiAuthFile()
): Promise<PiAuthGrant> {
  validatePiAuthGrantAppId(appId);
  const grant: PiAuthGrant = { source: "pi", authFile: await validatePiAuthFile(authFile) };
  const current = await loadPiAuthGrants();
  await saveState({ version: 1, grants: { ...current, [appId]: grant } });
  return grant;
}

export async function revokePiAuth(appId: string): Promise<boolean> {
  validatePiAuthGrantAppId(appId);
  const current = await loadPiAuthGrants();
  if (!Object.hasOwn(current, appId)) return false;
  const grants = Object.fromEntries(Object.entries(current).filter(([key]) => key !== appId));
  await saveState({ version: 1, grants });
  return true;
}

export async function validatePiAuthFile(value: string): Promise<string> {
  const requested = expandPath(value);
  const canonical = await realpath(requested).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Pi auth file does not exist: ${requested}`, { cause: error });
    }
    throw error;
  });
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error(`Pi auth path is not a regular file: ${canonical}`);
  await access(canonical, constants.R_OK | constants.W_OK).catch((error: unknown) => {
    throw new Error(`Pi auth file must be readable and writable: ${canonical}`, { cause: error });
  });
  return canonical;
}

async function saveState(state: PiAuthGrantState): Promise<void> {
  const statePath = authGrantStatePath();
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  const sorted = {
    version: 1,
    grants: Object.fromEntries(
      Object.entries(state.grants).sort(([left], [right]) => left.localeCompare(right))
    )
  } satisfies PiAuthGrantState;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(sorted, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600);
  } catch (error) {
    throw new Error(
      `failed to save Pi Factory auth grants ${statePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function validateState(value: unknown, source: string): PiAuthGrantState {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["grants"])) {
    throw new Error(`${source}: auth grant state must contain version 1 and a grants object`);
  }
  rejectUnknownFields(value, ["version", "grants"], `${source}: unknown auth grant state field`);
  return { version: 1, grants: validateGrants(value["grants"], source) };
}

function validateGrants(
  value: Readonly<Record<string, unknown>>,
  source: string
): Readonly<Record<string, PiAuthGrant>> {
  return Object.fromEntries(
    Object.entries(value).map(([appId, entry]) => [appId, validateGrant(appId, entry, source)])
  );
}

function validateGrant(appId: string, value: unknown, source: string): PiAuthGrant {
  validatePiAuthGrantAppId(appId);
  if (!isRecord(value) || value["source"] !== "pi" || typeof value["authFile"] !== "string") {
    throw new Error(`${source}: invalid auth grant for ${appId}`);
  }
  rejectUnknownFields(
    value,
    ["source", "authFile"],
    `${source}: unknown auth grant field for ${appId}:`
  );
  return { source: "pi", authFile: value["authFile"] };
}

function rejectUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  message: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${message} ${unknown.join(", ")}`);
}

export function validatePiAuthGrantAppId(appId: string): void {
  if (!isValidPiAppId(appId)) throw new Error(`invalid Pi app id: ${appId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
