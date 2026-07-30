import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

import type {
  PiAppDefinition,
  PiAppManifest,
  PiProviderApi,
  PiThinkingFormat,
  PiThinkingLevel
} from "./types.js";
import { expandPath, optionalExpandPath } from "./paths.js";
import { findInstalledApp } from "./registry.js";

export type LoadPiAppInput = {
  readonly app?: string;
  readonly appFile?: string;
  readonly appDir?: string;
  readonly searchDirs?: readonly string[];
};

export function isValidPiAppId(value: string): boolean {
  return /^[A-Za-z0-9._:-]+$/u.test(value);
}

type TopLevelManifestFields = Pick<
  PiAppManifest,
  | "id"
  | "name"
  | "version"
  | "schema_version"
  | "state_dir"
  | "description"
  | "session_dir"
  | "pi_command"
  | "thinking"
  | "tools"
  | "system_prompt"
  | "env"
>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

type ExtensionDefinitions = NonNullable<PiAppDefinition["extensions"]>;

type ProviderManifestFields = PiAppManifest["provider"];

type ModelManifestFields = PiAppManifest["model"];

type CollectionManifestFields = Pick<PiAppManifest, "extensions" | "build">;

export async function loadPiApp(input: LoadPiAppInput): Promise<{
  readonly manifest: PiAppManifest;
  readonly manifestPath: string;
  readonly appRoot: string;
}> {
  const manifestPath = await resolveManifestPath(input);
  const content = await readFile(manifestPath, "utf8");
  const manifest = parsePiAppManifest(content, manifestPath);
  return {
    manifest,
    manifestPath,
    appRoot: path.dirname(manifestPath)
  };
}

export function parsePiAppManifest(content: string, source = "pi-factory.toml"): PiAppManifest {
  const parsed = parse(content);
  return validatePiAppManifest(parsed, source);
}

export function validatePiAppManifest(value: unknown, source = "pi-factory.toml"): PiAppManifest {
  if (!isRecord(value)) {
    throw new Error(`${source}: manifest must be a TOML table`);
  }
  const errors: string[] = [];
  const topLevel = readTopLevelFields(value, errors);
  const provider = readProviderFields(value, errors);
  const model = readModelFields(value, errors);
  const collections = readCollectionFields(value, errors);

  if (errors.length > 0) {
    throw new Error(
      `${source}: invalid manifest\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }

  return {
    ...topLevel,
    provider,
    model,
    ...collections
  };
}

function readTopLevelFields(
  value: Record<string, unknown>,
  errors: string[]
): TopLevelManifestFields {
  const fields: Partial<Mutable<TopLevelManifestFields>> = {};
  const schemaVersion = numberField(value, "schema_version", errors);
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    errors.push("schema_version must be 1");
  }
  const id = stringField(value, "id", errors);
  if (id !== undefined && !isValidPiAppId(id)) {
    errors.push("id may only contain ASCII letters, digits, dot, colon, underscore, and hyphen");
  }
  const thinking = optionalString(value, "thinking", errors);
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    errors.push("thinking must be one of off, minimal, low, medium, high, xhigh");
  }

  const description = optionalString(value, "description", errors);
  const sessionDir = optionalString(value, "session_dir", errors);
  const piCommand = piCommandField(value, errors);
  const tools = stringArrayField(value, "tools", false, errors);
  const systemPrompt = optionalString(value, "system_prompt", errors);
  const env = recordStringField(value, "env", false, errors);
  fields.id = id as string;
  fields.name = stringField(value, "name", errors) as string;
  fields.version = stringField(value, "version", errors) as string;
  fields.schema_version = schemaVersion as number;
  fields.state_dir = stringField(value, "state_dir", errors) as string;
  assignDefined(fields, "description", description);
  assignDefined(fields, "session_dir", sessionDir);
  assignDefined(fields, "pi_command", piCommand);
  assignDefined(fields, "thinking", thinking as PiThinkingLevel | undefined);
  assignDefined(fields, "tools", tools);
  assignDefined(fields, "system_prompt", systemPrompt);
  assignDefined(fields, "env", env);
  return fields as TopLevelManifestFields;
}

function readProviderFields(
  value: Record<string, unknown>,
  errors: string[]
): ProviderManifestFields {
  const provider = tableField(value, "provider", errors);
  const providerApi = provider === undefined ? undefined : optionalString(provider, "api", errors);
  if (providerApi !== undefined && !isProviderApi(providerApi)) {
    errors.push("provider.api must be openai-completions");
  }
  return {
    id: (provider === undefined ? undefined : stringField(provider, "id", errors)) as string,
    base_url: (provider === undefined
      ? undefined
      : stringField(provider, "base_url", errors)) as string,
    ...(providerApi === undefined ? {} : { api: providerApi as PiProviderApi })
  };
}

function readModelFields(value: Record<string, unknown>, errors: string[]): ModelManifestFields {
  const model = tableField(value, "model", errors);
  if (model === undefined) {
    return {} as ModelManifestFields;
  }
  const fields: Partial<Mutable<ModelManifestFields>> = {
    id: stringField(model, "id", errors) as string
  };
  assignModelOptions(fields, model, errors);
  return fields as ModelManifestFields;
}

function assignModelOptions(
  fields: Partial<Mutable<ModelManifestFields>>,
  model: Record<string, unknown>,
  errors: string[]
): void {
  assignDefined(fields, "name", optionalString(model, "name", errors));
  assignDefined(fields, "context_window", optionalNumber(model, "context_window", errors));
  assignDefined(fields, "max_tokens", optionalNumber(model, "max_tokens", errors));
  assignDefined(fields, "reasoning", optionalBoolean(model, "reasoning", errors));
  assignDefined(fields, "thinking_format", thinkingFormatField(model, errors));
}

function thinkingFormatField(
  model: Record<string, unknown>,
  errors: string[]
): PiThinkingFormat | undefined {
  const thinkingFormat = optionalString(model, "thinking_format", errors);
  if (thinkingFormat !== undefined && !isThinkingFormat(thinkingFormat)) {
    errors.push("model.thinking_format must be deepseek or qwen-chat-template");
    return undefined;
  }
  return thinkingFormat;
}

function readCollectionFields(
  value: Record<string, unknown>,
  errors: string[]
): CollectionManifestFields {
  const extensions = extensionsField(value, errors);
  const build = buildField(value, errors);
  return {
    ...(extensions === undefined ? {} : { extensions }),
    ...(build === undefined ? {} : { build })
  };
}

function assignDefined<T extends object, K extends keyof T>(
  target: Partial<T>,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export async function manifestToDefinition(
  manifest: PiAppManifest,
  appRoot: string
): Promise<PiAppDefinition> {
  const app: Partial<PiAppDefinition> = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    rootDir: appRoot,
    stateDir: expandPath(manifest.state_dir, appRoot),
    sessionDir: expandPath(manifest.session_dir ?? `${manifest.state_dir}/sessions`, appRoot),
    piCommand: manifest.pi_command ?? ["npx", "-y", "@earendil-works/pi-coding-agent@latest"],
    providers: [providerDefinition(manifest)],
    defaultProvider: manifest.provider.id,
    defaultModel: manifest.model.id,
    thinking: manifest.thinking ?? "medium"
  };
  assignDefined(app, "description", manifest.description);
  assignDefined(app, "tools", manifest.tools?.join(","));
  assignDefined(app, "systemPrompt", await systemPromptText(manifest, appRoot));
  assignDefined(app, "env", manifest.env);
  assignDefined(app, "build", manifest.build);
  const extensions = await extensionDefinitions(manifest, appRoot);
  assignDefined(app, "extensions", extensions.length === 0 ? undefined : extensions);
  return app as PiAppDefinition;
}

function providerDefinition(manifest: PiAppManifest): PiAppDefinition["providers"][number] {
  return {
    id: manifest.provider.id,
    baseUrl: manifest.provider.base_url,
    api: manifest.provider.api ?? "openai-completions",
    models: [modelDefinition(manifest)]
  };
}

function modelDefinition(
  manifest: PiAppManifest
): PiAppDefinition["providers"][number]["models"][number] {
  const model: Partial<PiAppDefinition["providers"][number]["models"][number]> = {
    id: manifest.model.id,
    name: manifest.model.name ?? manifest.model.id,
    reasoning: manifest.model.reasoning ?? false,
    input: ["text"]
  };
  assignDefined(model, "thinkingFormat", manifest.model.thinking_format);
  assignDefined(model, "contextWindow", manifest.model.context_window);
  assignDefined(model, "maxTokens", manifest.model.max_tokens);
  return model as PiAppDefinition["providers"][number]["models"][number];
}

async function systemPromptText(
  manifest: PiAppManifest,
  appRoot: string
): Promise<string | undefined> {
  const systemPromptPath = optionalExpandPath(manifest.system_prompt, appRoot);
  return systemPromptPath === undefined ? undefined : await readFile(systemPromptPath, "utf8");
}

async function extensionDefinitions(
  manifest: PiAppManifest,
  appRoot: string
): Promise<ExtensionDefinitions> {
  return await Promise.all(
    (manifest.extensions ?? []).map(async (extension) => {
      const resolved = { path: expandPath(extension.path, appRoot) };
      const appendPath = optionalExpandPath(extension.append_system_prompt, appRoot);
      if (appendPath === undefined) {
        return resolved;
      }
      return { ...resolved, appendSystemPrompt: await readFile(appendPath, "utf8") };
    })
  );
}

async function resolveManifestPath(input: LoadPiAppInput): Promise<string> {
  const explicit = explicitManifestPath(input);
  if (explicit !== undefined) {
    return explicit;
  }
  const app = input.app;
  if (app === undefined) {
    throw new Error("app, appFile, or appDir is required");
  }
  return await appManifestPath(app, input.searchDirs ?? []);
}

function explicitManifestPath(input: LoadPiAppInput): string | undefined {
  if (input.appFile !== undefined) {
    return expandPath(input.appFile);
  }
  return input.appDir === undefined
    ? undefined
    : path.join(expandPath(input.appDir), "pi-factory.toml");
}

async function appManifestPath(app: string, searchDirs: readonly string[]): Promise<string> {
  const candidates: string[] = [];
  for (const searchDir of searchDirs) {
    candidates.push(path.join(expandPath(searchDir), app, "pi-factory.toml"));
  }
  candidates.push(path.join(process.cwd(), ".pi", "apps", app, "pi-factory.toml"));
  const localExisting = await existingFiles(candidates);
  if (localExisting.length > 0) {
    return singleAppPath(app, localExisting);
  }
  const installed = await findInstalledApp(app);
  if (installed !== undefined) {
    candidates.push(installed.manifestPath);
  }
  const existing = await existingFiles(candidates);
  return singleAppPath(app, existing);
}

function singleAppPath(app: string, existing: readonly string[]): string {
  if (existing.length === 0) {
    throw new Error(`Pi app not found: ${app}`);
  }
  if (existing.length > 1) {
    throw new Error(`Pi app is ambiguous: ${app}\n${existing.join("\n")}`);
  }
  return existing[0] as string;
}

async function existingFiles(candidates: readonly string[]): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): string | undefined {
  const entry = value[key];
  if (typeof entry === "string" && entry.trim() !== "") {
    return entry;
  }
  errors.push(`${key} is required`);
  return undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): number | undefined {
  const entry = value[key];
  if (typeof entry === "number" && Number.isInteger(entry)) {
    return entry;
  }
  errors.push(`${key} is required`);
  return undefined;
}

function tableField(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): Record<string, unknown> | undefined {
  const entry = value[key];
  if (isRecord(entry)) {
    return entry;
  }
  errors.push(`${key} table is required`);
  return undefined;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): string | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry === "string") {
    return entry;
  }
  errors.push(`${key} must be a string`);
  return undefined;
}

function optionalNumber(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): number | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry === "number") {
    return entry;
  }
  errors.push(`${key} must be a number`);
  return undefined;
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  errors: string[]
): boolean | undefined {
  const entry = value[key];
  if (entry === undefined) {
    return undefined;
  }
  if (typeof entry === "boolean") {
    return entry;
  }
  errors.push(`${key} must be a boolean`);
  return undefined;
}

function piCommandField(
  value: Record<string, unknown>,
  errors: string[]
): readonly string[] | undefined {
  const command = stringArrayField(value, "pi_command", false, errors);
  if (command !== undefined && (command.length === 0 || command.some((part) => part === ""))) {
    errors.push("pi_command must be a nonempty array of nonempty strings");
  }
  return command;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[]
): readonly string[] | undefined {
  const entry = value[key];
  if (entry === undefined && !required) {
    return undefined;
  }
  if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
    return entry;
  }
  errors.push(`${key} must be an array of strings`);
  return undefined;
}

function recordStringField(
  value: Record<string, unknown>,
  key: string,
  required: boolean,
  errors: string[]
): Readonly<Record<string, string>> | undefined {
  const entry = value[key];
  if (entry === undefined && !required) {
    return undefined;
  }
  if (isRecord(entry) && Object.values(entry).every((item) => typeof item === "string")) {
    return entry as Readonly<Record<string, string>>;
  }
  errors.push(`${key} must be a table of string values`);
  return undefined;
}

function extensionsField(
  value: Record<string, unknown>,
  errors: string[]
): PiAppManifest["extensions"] | undefined {
  const entry = value["extensions"];
  if (entry === undefined) {
    return undefined;
  }
  if (!Array.isArray(entry)) {
    errors.push("extensions must be an array of tables");
    return undefined;
  }
  return entry.flatMap((item, index) => {
    if (!isRecord(item) || typeof item["path"] !== "string") {
      errors.push(`extensions[${String(index)}].path is required`);
      return [];
    }
    if (
      item["append_system_prompt"] !== undefined &&
      typeof item["append_system_prompt"] !== "string"
    ) {
      errors.push(`extensions[${String(index)}].append_system_prompt must be a string`);
      return [];
    }
    return [
      {
        path: item["path"],
        ...(typeof item["append_system_prompt"] === "string"
          ? { append_system_prompt: item["append_system_prompt"] }
          : {})
      }
    ];
  });
}

function buildField(
  value: Record<string, unknown>,
  errors: string[]
): PiAppManifest["build"] | undefined {
  const entry = value["build"];
  if (entry === undefined) {
    return undefined;
  }
  if (!Array.isArray(entry)) {
    errors.push("build must be an array of tables");
    return undefined;
  }
  return entry.flatMap((item, index) => {
    if (!isRecord(item) || !Array.isArray(item["command"])) {
      errors.push(`build[${String(index)}].command is required`);
      return [];
    }
    const command = item["command"];
    if (!command.every((part) => typeof part === "string")) {
      errors.push(`build[${String(index)}].command must be an array of strings`);
      return [];
    }
    const platforms = stringArrayField(item, "platforms", false, errors);
    if (platforms !== undefined && !platforms.every(isPlatform)) {
      errors.push(`build[${String(index)}].platforms must contain only linux, macos, or windows`);
      return [];
    }
    return [
      {
        command,
        ...(platforms === undefined ? {} : { platforms })
      }
    ];
  });
}

function isThinkingLevel(value: string): value is PiThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function isProviderApi(value: string): value is PiProviderApi {
  return value === "openai-completions";
}

function isThinkingFormat(value: string): value is PiThinkingFormat {
  return ["deepseek", "qwen-chat-template"].includes(value);
}

function isPlatform(value: string): value is "linux" | "macos" | "windows" {
  return ["linux", "macos", "windows"].includes(value);
}
