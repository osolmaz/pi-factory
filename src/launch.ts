import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { runtimeConfigPathsForApp, writePiRuntimeConfig } from "./runtime-config.js";
import type {
  PiAppDefinition,
  PiLaunchOverrides,
  PiLaunchPlan,
  PiRuntimeConfigPaths,
  PiRunMode
} from "./types.js";

export function runtimeConfigPaths(app: PiAppDefinition): PiRuntimeConfigPaths {
  return runtimeConfigPathsForApp(app);
}

export async function createPiLaunchPlan(
  app: PiAppDefinition,
  runtimeConfig: PiRuntimeConfigPaths = runtimeConfigPaths(app),
  overrides: PiLaunchOverrides = {}
): Promise<PiLaunchPlan> {
  const appEnv = withoutManagedPiEnv(app.env);
  const warnings = managedPiEnvWarnings(app.env);
  const cwd = await launchCwd(app, overrides.cwd);
  return {
    appId: app.id,
    appName: app.name,
    command: await launchCommand(app, cwd),
    args: [
      "--provider",
      app.defaultProvider,
      "--model",
      app.defaultModel,
      "--thinking",
      app.thinking,
      ...extensionArgs(app),
      ...systemPromptArgs(app),
      ...withDefaultTools(app.forwardedArgs ?? [], app.tools),
      ...runtimeArgs(overrides)
    ],
    env: {
      ...appEnv,
      PI_CODING_AGENT_DIR: runtimeConfig.configDir,
      PI_CODING_AGENT_SESSION_DIR: app.sessionDir,
      PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
      PI_TELEMETRY: process.env["PI_TELEMETRY"] ?? "0",
      PI_SKIP_VERSION_CHECK: process.env["PI_SKIP_VERSION_CHECK"] ?? "1"
    },
    ...(cwd === undefined ? {} : { cwd }),
    runtimeConfig,
    warnings
  };
}

export async function runPiApp(
  app: PiAppDefinition,
  overrides: PiLaunchOverrides = {}
): Promise<number> {
  validateRuntimeMessages(overrides);
  const cwd = await launchCwd(app, overrides.cwd);
  const runtimeConfig = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  return await execPiLaunchPlan(
    await createPiLaunchPlan(app, runtimeConfig, {
      ...overrides,
      ...(cwd === undefined ? {} : { cwd })
    })
  );
}

async function launchCwd(
  app: PiAppDefinition,
  override: string | undefined
): Promise<string | undefined> {
  const candidate = override ?? app.rootDir;
  if (candidate === undefined) return undefined;
  const absolute = resolve(candidate);
  const info = await stat(absolute).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) throw new Error(`launch cwd does not exist: ${absolute}`);
  if (!info.isDirectory()) throw new Error(`launch cwd must be a directory: ${absolute}`);
  return await realpath(absolute);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function runtimeArgs(overrides: PiLaunchOverrides): readonly string[] {
  const mode = overrides.mode ?? "interactive";
  validateRuntimeMessages(overrides);
  const args: string[] = [];
  args.push(...modeArgs(mode));
  if (overrides.session !== undefined) args.push("--session", overrides.session);
  if (overrides.name !== undefined) args.push("--name", overrides.name);
  args.push(...(overrides.messages ?? []));
  return args;
}

function validateRuntimeMessages(overrides: PiLaunchOverrides): void {
  if (
    overrides.mode === "rpc" &&
    overrides.messages !== undefined &&
    overrides.messages.length > 0
  ) {
    throw new Error("RPC mode accepts messages through stdin, not launch arguments");
  }
}

async function launchCommand(app: PiAppDefinition, cwd: string | undefined): Promise<string> {
  if (app.rootDir === undefined) return app.piCommand;
  if (cwd === undefined) return app.piCommand;
  const appRoot = await realpath(resolve(app.rootDir));
  if (appRoot === cwd) return app.piCommand;

  const replacements = await commandReplacements(app.piCommand, appRoot);
  if (replacements.length === 0) return app.piCommand;
  return applyCommandReplacements(app.piCommand, replacements);
}

interface CommandReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

async function commandReplacements(
  command: string,
  appRoot: string
): Promise<CommandReplacement[]> {
  const replacements: CommandReplacement[] = [];
  for (const word of commandWords(command)) {
    const replacement = await commandReplacement(word, appRoot);
    if (replacement !== undefined) replacements.push(replacement);
  }
  return replacements;
}

async function commandReplacement(
  word: CommandWord,
  appRoot: string
): Promise<CommandReplacement | undefined> {
  const reference = bundlePathReference(word.value);
  if (reference === undefined) return undefined;
  const absolute = resolve(appRoot, reference.path);
  if (!(await pathExists(absolute))) return undefined;
  return {
    start: word.start,
    end: word.end,
    value: shellQuote(`${reference.prefix}${absolute}`)
  };
}

function applyCommandReplacements(
  command: string,
  replacements: readonly CommandReplacement[]
): string {
  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    result += command.slice(cursor, replacement.start);
    result += replacement.value;
    cursor = replacement.end;
  }
  return `${result}${command.slice(cursor)}`;
}

function bundlePathReference(value: string): { prefix: string; path: string } | undefined {
  const equals = value.indexOf("=");
  const prefix = equals === -1 ? "" : value.slice(0, equals + 1);
  const path = equals === -1 ? value : value.slice(equals + 1);
  if (!path.includes("/") || path.startsWith("/") || hasDynamicPathSyntax(path)) {
    return undefined;
  }
  return { prefix, path };
}

function hasDynamicPathSyntax(path: string): boolean {
  return ["$", "*", "?", "[", "]", "{", "}", "~", "`"].some((char) => path.includes(char));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function modeArgs(mode: PiRunMode): readonly string[] {
  switch (mode) {
    case "interactive":
      return [];
    case "print":
      return ["--print"];
    case "json":
      return ["--mode", "json"];
    case "rpc":
      return ["--mode", "rpc"];
  }
}

export async function execPiLaunchPlan(plan: PiLaunchPlan): Promise<number> {
  const stdio: StdioOptions = "inherit";
  assertLaunchCommand(plan.command);
  const child = spawn(shellCommand(plan.command, plan.args), {
    shell: true,
    stdio,
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env }
  });
  child.stdout?.resume();
  return await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function extensionArgs(app: PiAppDefinition): readonly string[] {
  return (app.extensions ?? []).flatMap((extension) => ["--extension", extension.path]);
}

function systemPromptArgs(app: PiAppDefinition): readonly string[] {
  const args: string[] = [];
  if (app.systemPrompt !== undefined) {
    args.push("--system-prompt", app.systemPrompt);
  }
  for (const prompt of app.appendSystemPrompts ?? []) {
    args.push("--append-system-prompt", prompt);
  }
  for (const extension of app.extensions ?? []) {
    if (extension.appendSystemPrompt !== undefined) {
      args.push("--append-system-prompt", extension.appendSystemPrompt);
    }
  }
  return args;
}

function withDefaultTools(args: readonly string[], tools: string | undefined): readonly string[] {
  if (tools === undefined || hasToolFlag(args)) {
    return args;
  }
  return ["--tools", tools, ...args];
}

function hasToolFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === "--tools" || arg === "-t" || arg === "--no-tools" || arg === "-nt"
  );
}

function withoutManagedPiEnv(
  env: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (env === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== "PI_CODING_AGENT_DIR" && key !== "PI_CODING_AGENT_SESSION_DIR"
    )
  );
}

function managedPiEnvWarnings(
  env: Readonly<Record<string, string>> | undefined
): readonly string[] {
  if (env === undefined) {
    return [];
  }
  const warnings: string[] = [];
  if (env["PI_CODING_AGENT_DIR"] !== undefined) {
    warnings.push("ignored managed env PI_CODING_AGENT_DIR");
  }
  if (env["PI_CODING_AGENT_SESSION_DIR"] !== undefined) {
    warnings.push("ignored managed env PI_CODING_AGENT_SESSION_DIR");
  }
  return warnings;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertLaunchCommand(command: string): void {
  const [program] = commandWords(command);
  if (program === undefined) {
    throw new Error("launch command must not be empty");
  }
}

interface CommandWord {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface CommandScanState {
  readonly start?: number;
  readonly value: string;
  readonly quote?: "'" | '"';
  readonly escaping: boolean;
}

function commandWords(command: string): CommandWord[] {
  const words: CommandWord[] = [];
  let state: CommandScanState = { value: "", escaping: false };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char !== undefined) state = consumeCommandCharacter(words, state, char, index);
  }
  finishCommandWords(words, state, command);
  return words;
}

function consumeCommandCharacter(
  words: CommandWord[],
  state: CommandScanState,
  char: string,
  index: number
): CommandScanState {
  if (state.start === undefined && isWhitespace(char)) return state;
  const started: CommandScanState & { readonly start: number } = {
    ...state,
    start: state.start ?? index
  };
  return consumeStartedCommandCharacter(words, started, char, index);
}

function consumeStartedCommandCharacter(
  words: CommandWord[],
  state: CommandScanState & { readonly start: number },
  char: string,
  index: number
): CommandScanState {
  if (state.escaping) return { ...state, value: state.value + char, escaping: false };
  if (char === "\\" && state.quote !== "'") return { ...state, escaping: true };
  if (state.quote !== undefined) {
    return consumeQuotedCommandCharacter({ ...state, quote: state.quote }, char);
  }
  if (isQuote(char)) return { ...state, quote: char };
  if (!isWhitespace(char)) return { ...state, value: state.value + char };
  words.push({ start: state.start, end: index, value: state.value });
  return { value: "", escaping: false };
}

function consumeQuotedCommandCharacter(
  state: CommandScanState & { readonly start: number; readonly quote: "'" | '"' },
  char: string
): CommandScanState {
  if (char === state.quote) {
    return {
      start: state.start,
      value: state.value,
      escaping: state.escaping
    };
  }
  return { ...state, value: state.value + char };
}

function finishCommandWords(words: CommandWord[], state: CommandScanState, command: string): void {
  if (state.quote !== undefined) {
    throw new Error(`unterminated quote in launch command: ${command}`);
  }
  if (state.start === undefined) return;
  words.push({
    start: state.start,
    end: command.length,
    value: state.escaping ? `${state.value}\\` : state.value
  });
}

function isQuote(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}
