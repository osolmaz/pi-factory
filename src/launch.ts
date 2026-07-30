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
    command: app.piCommand,
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
  const args: string[] = [];
  args.push(...modeArgs(overrides.mode ?? "interactive"));
  if (overrides.session !== undefined) args.push("--session", overrides.session);
  if (overrides.name !== undefined) args.push("--name", overrides.name);
  args.push(...(overrides.messages ?? []));
  return args;
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
  const [program] = splitCommandLine(command);
  if (program === undefined) {
    throw new Error("launch command must not be empty");
  }
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let state: SplitState = { current: "", quote: undefined, escaping: false };
  for (const char of command) {
    state = consumeCommandChar(parts, state, char);
  }
  finishSplitCommand(parts, state, command);
  return parts;
}

interface SplitState {
  readonly current: string;
  readonly quote: "'" | '"' | undefined;
  readonly escaping: boolean;
}

function consumeCommandChar(parts: string[], state: SplitState, char: string): SplitState {
  if (state.escaping) {
    return { ...state, current: state.current + char, escaping: false };
  }
  if (startsEscape(char)) {
    return { ...state, escaping: true };
  }
  if (state.quote !== undefined) {
    return consumeQuotedChar(state, char);
  }
  if (isQuote(char)) {
    return { ...state, quote: char };
  }
  if (isWhitespace(char)) {
    return { ...state, current: flushPart(parts, state.current) };
  }
  return { ...state, current: state.current + char };
}

function finishSplitCommand(parts: string[], state: SplitState, command: string): void {
  const current = state.escaping ? `${state.current}\\` : state.current;
  if (state.quote !== undefined) {
    throw new Error(`unterminated quote in launch command: ${command}`);
  }
  flushPart(parts, current);
}

function startsEscape(char: string): boolean {
  return char === "\\";
}

function isQuote(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function consumeQuotedChar(state: SplitState, char: string): SplitState {
  if (char === state.quote) {
    return { ...state, quote: undefined };
  }
  return { ...state, current: state.current + char };
}

function flushPart(parts: string[], current: string): string {
  if (current !== "") {
    parts.push(current);
  }
  return "";
}
