import { stat } from "node:fs/promises";
import readline from "node:readline/promises";

import {
  defaultPiAuthFile,
  getPiAuthGrant,
  grantPiAuth,
  revokePiAuth,
  validatePiAuthFile,
  validatePiAuthGrantAppId
} from "../auth-grants.js";
import { createPiLaunchPlan, runPiApp } from "../launch.js";
import { initPiApp } from "../init.js";
import { installPiApp } from "../install.js";
import { linkPiApp, listPiApps, uninstallPiApp } from "../registry.js";
import { loadPiApp, manifestToDefinition } from "../manifest.js";
import { runtimeConfigPathsForApp } from "../runtime-config.js";

export type CliResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CommandHandler = (args: readonly string[]) => Promise<CliResult>;

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  plan: async (args) => ok(`${JSON.stringify(await plan(args), null, 2)}\n`),
  run: async (args) => exitCode(await runApp(args)),
  validate: async (args) => ok(await validate(args)),
  init: async (args) => ok(`created ${await init(args)}\n`),
  link: async (args) => ok(`${JSON.stringify(await link(args), null, 2)}\n`),
  install: async (args) => ok(`${JSON.stringify(await install(args), null, 2)}\n`),
  uninstall: async (args) => ok(`${(await uninstall(args)) ? "uninstalled" : "not installed"}\n`),
  list: async () => ok(`${JSON.stringify(await listPiApps(), null, 2)}\n`),
  inspect: async (args) => ok(`${JSON.stringify(await inspect(args), null, 2)}\n`),
  auth: async (args) => ok(`${JSON.stringify(await auth(args), null, 2)}\n`)
};

export async function run(args: readonly string[]): Promise<CliResult> {
  const command = args[0];
  try {
    if (isHelpCommand(command)) {
      return ok(usage());
    }
    const handler = command === undefined ? undefined : COMMANDS[command];
    if (handler === undefined || command === undefined) {
      return { code: 2, stdout: "", stderr: `${usage()}unknown command: ${command ?? ""}\n` };
    }
    return await handler(args.slice(1));
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`
    };
  }
}

async function plan(args: readonly string[]): Promise<unknown> {
  const parsed = parseAppArgs(args);
  const loaded = await loadPiApp(appInput(parsed));
  const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  return {
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    app: {
      id: app.id,
      name: app.name,
      version: app.version
    },
    runtimeConfig: runtimeConfigPathsForApp(app),
    launch: await createPiLaunchPlan(
      app,
      runtimeConfigPathsForApp(app),
      parsed.cwd === undefined ? {} : { cwd: parsed.cwd }
    ),
    note: "plan does not write runtime config or launch Pi"
  };
}

function isHelpCommand(command: string | undefined): boolean {
  return command === "-h" || command === "--help" || command === "help";
}

async function runApp(args: readonly string[]): Promise<number> {
  const parsed = parseAppArgs(args);
  const loaded = await loadPiApp(appInput(parsed));
  const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
  return await runPiApp(app, parsed.cwd === undefined ? {} : { cwd: parsed.cwd });
}

async function validate(args: readonly string[]): Promise<string> {
  const target = required(args[0], "usage: pi-factory validate <app-id|app-dir|app-file>");
  const loaded = await loadPiApp(await validateTarget(target));
  return `valid ${loaded.manifest.id} (${loaded.manifestPath})\n`;
}

async function init(args: readonly string[]): Promise<string> {
  const appId = required(args[0], "usage: pi-factory init <app-id> [dir]");
  return await initPiApp(appId, args[1] ?? appId);
}

async function link(args: readonly string[]): Promise<unknown> {
  const appDir = required(args[0], "usage: pi-factory link <app-dir>");
  return await linkPiApp(appDir);
}

async function install(args: readonly string[]): Promise<unknown> {
  const source = required(args[0], "usage: pi-factory install <owner>/<repo>[/subdir...]");
  let requestedRef: string | undefined;
  let yes = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--ref") {
      requestedRef = required(args[index + 1], "--ref requires a value");
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${String(arg)}`);
  }
  return await installPiApp({
    source,
    ...(requestedRef === undefined ? {} : { requestedRef }),
    yes
  });
}

async function uninstall(args: readonly string[]): Promise<boolean> {
  return await uninstallPiApp(required(args[0], "usage: pi-factory uninstall <app-id>"));
}

async function inspect(args: readonly string[]): Promise<unknown> {
  const loaded = await loadPiApp(appInput(parseAppArgs(args)));
  return {
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    manifest: loaded.manifest
  };
}

async function auth(args: readonly string[]): Promise<unknown> {
  const [action, appId, ...options] = args;
  if (action === "status") return await authStatus(appId, options);
  if (action === "revoke") return await authRevoke(appId, options);
  if (action === "grant") return await authGrant(appId, options);
  throw new Error("usage: pi-factory auth <grant|status|revoke> <app-id>");
}

async function authStatus(appId: string | undefined, options: readonly string[]): Promise<unknown> {
  const id = authAppId(appId, options, "usage: pi-factory auth status <app-id>");
  return { appId: id, grant: (await getPiAuthGrant(id)) ?? null };
}

async function authRevoke(appId: string | undefined, options: readonly string[]): Promise<unknown> {
  const id = authAppId(appId, options, "usage: pi-factory auth revoke <app-id>");
  return { appId: id, revoked: await revokePiAuth(id) };
}

async function authGrant(appId: string | undefined, options: readonly string[]): Promise<unknown> {
  const id = required(appId, "usage: pi-factory auth grant <app-id> --source pi [--yes]");
  validatePiAuthGrantAppId(id);
  const parsed = parseAuthGrantOptions(options);
  const authFile = await validatePiAuthFile(defaultPiAuthFile());
  await confirmAuthGrant(id, authFile, parsed.yes);
  return { appId: id, grant: await grantPiAuth(id, authFile) };
}

function authAppId(
  appId: string | undefined,
  options: readonly string[],
  usageMessage: string
): string {
  if (options.length > 0) throw new Error(usageMessage);
  return required(appId, usageMessage);
}

function parseAuthGrantOptions(options: readonly string[]): { readonly yes: boolean } {
  let source: string | undefined;
  let yes = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--yes" || option === "-y") yes = true;
    else if (option === "--source") {
      source = required(options[index + 1], "--source requires a value");
      index += 1;
    } else throw new Error(`unknown option: ${String(option)}`);
  }
  if (source !== "pi") throw new Error("auth grant source must be pi");
  return { yes };
}

async function confirmAuthGrant(appId: string, authFile: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error("auth grant requires --yes when stdin is not interactive");
  }
  process.stderr.write(authGrantPreview(appId, authFile));
  const input = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await input.question("Grant access to this Pi auth file? [y/N] ");
    if (!/^y(?:es)?$/iu.test(answer.trim())) throw new Error("Pi auth grant cancelled");
  } finally {
    input.close();
  }
}

export function authGrantPreview(appId: string, authFile: string): string {
  return `Pi auth grant preview:\n  app: ${appId}\n  auth file: ${authFile}\n  shared state: login and logout through this app modify regular Pi authentication\n`;
}

interface ParsedAppArgs {
  app?: string;
  appFile?: string;
  appDir?: string;
  cwd?: string;
}

function parseAppArgs(args: readonly string[]): ParsedAppArgs {
  const parsed: ParsedAppArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error("missing argument");
    }
    if (setPathOption(parsed, arg, args[index + 1])) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    parsed.app = arg;
  }
  if (parsed.appFile === undefined && parsed.appDir === undefined) {
    parsed.app = required(parsed.app, "usage: pi-factory <plan|run|inspect> <app-id>");
  }
  return parsed;
}

function appInput(parsed: ParsedAppArgs): { app?: string; appFile?: string; appDir?: string } {
  if (parsed.appFile !== undefined) return { appFile: parsed.appFile };
  if (parsed.appDir !== undefined) return { appDir: parsed.appDir };
  return { app: required(parsed.app, "usage: pi-factory <plan|run|inspect> <app-id>") };
}

function setPathOption(
  parsed: ParsedAppArgs,
  arg: string | undefined,
  next: string | undefined
): boolean {
  if (arg === "--app-file") {
    parsed.appFile = required(next, "--app-file requires a value");
    return true;
  }
  if (arg === "--app-dir") {
    parsed.appDir = required(next, "--app-dir requires a value");
    return true;
  }
  if (arg === "--cwd") {
    parsed.cwd = required(next, "--cwd requires a value");
    return true;
  }
  return false;
}

async function validateTarget(
  target: string
): Promise<{ app?: string; appFile?: string; appDir?: string }> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      return { appDir: target };
    }
    return { appFile: target };
  } catch {
    return { app: target };
  }
}

function ok(stdout: string): CliResult {
  return { code: 0, stdout, stderr: "" };
}

function exitCode(code: number): CliResult {
  return { code, stdout: "", stderr: "" };
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
  return value;
}

function usage(): string {
  return `${[
    "pi-factory - run declarative Pi app bundles",
    "",
    "usage:",
    "  pi-factory plan <app-id>|--app-dir <dir>|--app-file <file> [--cwd <dir>]",
    "  pi-factory run <app-id>|--app-dir <dir>|--app-file <file> [--cwd <dir>]",
    "  pi-factory validate <app-id|app-dir|app-file>",
    "  pi-factory init <app-id> [dir]",
    "  pi-factory link <app-dir>",
    "  pi-factory install <owner>/<repo>[/subdir...] [--ref REF] [--yes]",
    "  pi-factory uninstall <app-id>",
    "  pi-factory list",
    "  pi-factory inspect <app-id>|--app-dir <dir>|--app-file <file>",
    "  pi-factory auth grant <app-id> --source pi [--yes]",
    "  pi-factory auth status <app-id>",
    "  pi-factory auth revoke <app-id>",
    ""
  ].join("\n")}\n`;
}
