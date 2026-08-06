import type { StdioOptions } from "node:child_process";
import spawn from "cross-spawn";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { runtimeConfigPathsForApp, writePiRuntimeConfig } from "./runtime-config.js";
import type {
  PiAppDefinition,
  PiLaunchOverrides,
  PiLaunchPlan,
  PiProfile,
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
  const command = await resolveLaunchCommand(app);
  return {
    appId: app.id,
    appName: app.name,
    command: command.program,
    args: [
      ...command.args,
      "--provider",
      overrides.provider ?? app.defaultProvider,
      "--model",
      overrides.model ?? app.defaultModel,
      "--thinking",
      overrides.thinking ?? app.thinking,
      ...extensionArgs(app),
      ...systemPromptArgs(app),
      ...withDefaultTools(app.forwardedArgs ?? [], app.tools),
      ...runtimeArgs(overrides)
    ],
    env: launchEnv(app, runtimeConfig, appEnv, overrides.profile),
    ...(cwd === undefined ? {} : { cwd }),
    runtimeConfig,
    warnings
  };
}

export async function createPiCommandPlan(
  app: PiAppDefinition,
  piArgs: readonly string[],
  runtimeConfig: PiRuntimeConfigPaths = runtimeConfigPaths(app),
  cwdOverride?: string
): Promise<PiLaunchPlan> {
  const appEnv = withoutManagedPiEnv(app.env);
  const warnings = managedPiEnvWarnings(app.env);
  const cwd = await launchCwd(app, cwdOverride);
  const command = await resolveLaunchCommand(app);
  return {
    appId: app.id,
    appName: app.name,
    command: command.program,
    args: [...command.args, ...piArgs],
    env: launchEnv(app, runtimeConfig, appEnv),
    ...(cwd === undefined ? {} : { cwd }),
    runtimeConfig,
    warnings
  };
}

export async function runPiCommand(
  app: PiAppDefinition,
  piArgs: readonly string[],
  cwdOverride?: string
): Promise<number> {
  const cwd = await launchCwd(app, cwdOverride);
  const runtimeConfig = await writePiRuntimeConfig(app);
  await mkdir(app.sessionDir, { recursive: true });
  return await execPiLaunchPlan(await createPiCommandPlan(app, piArgs, runtimeConfig, cwd));
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

async function resolveLaunchCommand(
  app: PiAppDefinition
): Promise<{ program: string; args: readonly string[] }> {
  const [program, ...args] = app.piCommand;
  if (program === undefined || program === "") {
    throw new Error("launch command must not be empty");
  }
  if (app.rootDir === undefined) return { program, args };
  const root = await realpath(resolve(app.rootDir));
  return {
    program: await resolveCommandPart(program, root),
    args: await Promise.all(args.map((arg) => resolveCommandPart(arg, root)))
  };
}

async function resolveCommandPart(value: string, appRoot: string): Promise<string> {
  const reference = bundlePathReference(value);
  if (reference === undefined) return value;
  const nativePath = reference.path.replaceAll("\\", sep);
  return `${reference.prefix}${resolve(appRoot, nativePath)}`;
}

function bundlePathReference(value: string): { prefix: string; path: string } | undefined {
  const equals = value.indexOf("=");
  const prefix = equals === -1 ? "" : value.slice(0, equals + 1);
  const path = equals === -1 ? value : value.slice(equals + 1);
  const staticPath =
    /^\.{1,2}[\\/]/u.test(path) &&
    !isAbsolute(path) &&
    !["$", "*", "?", "[", "]", "{", "}", "~", "`"].some((char) => path.includes(char));
  if (!staticPath) return undefined;
  return { prefix, path };
}

function runtimeArgs(overrides: PiLaunchOverrides): readonly string[] {
  const mode = overrides.mode ?? "interactive";
  validateRuntimeMessages(overrides);
  const args: string[] = [];
  args.push(...modeArgs(mode));
  if (overrides.noSession === true) args.push("--no-session");
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
  if (overrides.noSession === true && overrides.session !== undefined) {
    throw new Error("noSession and session are mutually exclusive");
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
  if (plan.command === "") throw new Error("launch command must not be empty");
  const child = spawn(plan.command, plan.args, {
    shell: false,
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

function launchEnv(
  app: PiAppDefinition,
  runtimeConfig: PiRuntimeConfigPaths,
  appEnv: Readonly<Record<string, string>>,
  profile: PiProfile = "isolated"
): Readonly<Record<string, string>> {
  return {
    ...appEnv,
    PI_CODING_AGENT_DIR:
      profile === "ambient" ? ambientAgentDir(process.env) : runtimeConfig.configDir,
    PI_CODING_AGENT_SESSION_DIR: app.sessionDir,
    PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
    PI_TELEMETRY: process.env["PI_TELEMETRY"] ?? "0",
    PI_SKIP_VERSION_CHECK: process.env["PI_SKIP_VERSION_CHECK"] ?? "1"
  };
}

export function ambientAgentDir(env: NodeJS.ProcessEnv): string {
  return env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
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
