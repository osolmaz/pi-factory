import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { Provider } from "@earendil-works/pi-ai";
import type { PackageManager, ResolvedPaths } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
export const PI_FACTORY_PROVIDER_VERSION = 1 as const;

export type PiFactoryRunStatus = "success" | "error" | "cancelled";

export type CreatePiFactoryProviderInput = {
  readonly providerId: string;
  readonly agentDir: string;
  readonly nativeProvider?: Provider;
  readonly signal?: AbortSignal;
};

export type CreatedPiFactoryProvider = {
  readonly provider: Provider;
  readonly startRun?: (runId: string) => void | Promise<void>;
  readonly finishRun?: (runId: string, status: PiFactoryRunStatus) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
};

export type PiFactoryProviderModule = {
  readonly version: 1;
  readonly createProvider: (
    input: CreatePiFactoryProviderInput
  ) => CreatedPiFactoryProvider | Promise<CreatedPiFactoryProvider>;
};

export type ResolvedProviderModule = {
  readonly providerId: string;
  readonly source: string;
  readonly packageRoot: string;
  readonly modulePath: string;
  readonly activationExtensionPath: string;
};

type ConfiguredPackage = ReturnType<PackageManager["listConfiguredPackages"]>[number];

type ProviderDeclaration = {
  readonly version: 1;
  readonly id: string;
  readonly module: string;
  readonly extension: string;
};

export async function resolveProviderModule(input: {
  readonly providerId: string;
  readonly packageManager: PackageManager;
  readonly resolvedPaths: ResolvedPaths;
}): Promise<ResolvedProviderModule | undefined> {
  const matches: ResolvedProviderModule[] = [];
  for (const configured of input.packageManager.listConfiguredPackages()) {
    if (configured.scope !== "user" || configured.installedPath === undefined) continue;
    const declarations = await readProviderDeclarations(configured);
    for (const declaration of declarations) {
      if (declaration.id !== input.providerId) continue;
      const resolved = await resolveDeclaration(configured, declaration, input.resolvedPaths);
      if (resolved !== undefined) matches.push(resolved);
    }
  }
  if (matches.length > 1) {
    throw new Error(`multiple enabled packages provide ${input.providerId}`);
  }
  return matches[0];
}

export async function createDeclaredProvider(input: {
  readonly declaration: ResolvedProviderModule;
  readonly agentDir: string;
  readonly nativeProvider?: Provider;
  readonly signal?: AbortSignal;
}): Promise<CreatedPiFactoryProvider> {
  input.signal?.throwIfAborted();
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const loaded: unknown = await jiti.import(input.declaration.modulePath);
  const module = providerModule(loaded, input.declaration.modulePath);
  const created = await module.createProvider({
    providerId: input.declaration.providerId,
    agentDir: input.agentDir,
    ...(input.nativeProvider === undefined ? {} : { nativeProvider: input.nativeProvider }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return await validateCreatedProvider(created, input.declaration);
}

async function validateCreatedProvider(
  created: CreatedPiFactoryProvider,
  declaration: ResolvedProviderModule
): Promise<CreatedPiFactoryProvider> {
  if (!isRecord(created) || !isProvider(created["provider"])) {
    throw new Error(`provider module returned an invalid provider: ${declaration.modulePath}`);
  }
  const provider = created["provider"];
  const close = typeof created["close"] === "function" ? created["close"] : undefined;
  if (provider.id !== declaration.providerId) {
    await close?.();
    throw new Error(`provider module returned ${provider.id}; expected ${declaration.providerId}`);
  }
  try {
    return {
      provider,
      ...optionalFunction(created, "startRun"),
      ...optionalFunction(created, "finishRun"),
      ...optionalFunction(created, "close")
    };
  } catch (error) {
    await close?.();
    throw error;
  }
}

// eslint-disable-next-line complexity -- Validate one bounded external package manifest completely.
async function readProviderDeclarations(
  configured: ConfiguredPackage
): Promise<readonly ProviderDeclaration[]> {
  const root = await realpath(configured.installedPath as string);
  const manifestPath = path.join(root, "package.json");
  let info;
  try {
    info = await stat(manifestPath);
  } catch {
    return [];
  }
  if (!info.isFile()) throw new Error(`package manifest is not a regular file: ${manifestPath}`);
  if (info.size > MAX_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`package manifest exceeds ${String(MAX_PACKAGE_MANIFEST_BYTES)} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid package manifest: ${manifestPath}`, { cause: error });
  }
  if (!isRecord(parsed) || parsed["piFactory"] === undefined) return [];
  const piFactory = parsed["piFactory"];
  if (!isRecord(piFactory) || !Array.isArray(piFactory["providers"])) {
    throw new Error(`package piFactory.providers must be an array: ${manifestPath}`);
  }
  return piFactory["providers"].map((value, index) =>
    providerDeclaration(value, `${manifestPath} piFactory.providers[${String(index)}]`)
  );
}

function providerDeclaration(value: unknown, source: string): ProviderDeclaration {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  if (value["version"] !== PI_FACTORY_PROVIDER_VERSION) {
    throw new Error(`${source}.version must be ${String(PI_FACTORY_PROVIDER_VERSION)}`);
  }
  for (const field of ["id", "module", "extension"] as const) {
    if (typeof value[field] !== "string" || value[field] === "") {
      throw new Error(`${source}.${field} must be a nonempty string`);
    }
  }
  return {
    version: PI_FACTORY_PROVIDER_VERSION,
    id: value["id"] as string,
    module: value["module"] as string,
    extension: value["extension"] as string
  };
}

async function resolveDeclaration(
  configured: ConfiguredPackage,
  declaration: ProviderDeclaration,
  resolvedPaths: ResolvedPaths
): Promise<ResolvedProviderModule | undefined> {
  const packageRoot = await realpath(configured.installedPath as string);
  const modulePath = await containedRealpath(packageRoot, declaration.module);
  const activationExtensionPath = await containedRealpath(packageRoot, declaration.extension);
  const active = resolvedPaths.extensions.some(
    (entry) =>
      entry.enabled &&
      entry.metadata.scope === "user" &&
      entry.metadata.source === configured.source &&
      path.resolve(entry.path) === activationExtensionPath
  );
  if (!active) return undefined;
  return {
    providerId: declaration.id,
    source: configured.source,
    packageRoot,
    modulePath,
    activationExtensionPath
  };
}

async function containedRealpath(root: string, value: string): Promise<string> {
  const candidate = await realpath(path.resolve(root, value));
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error(`provider path escapes package root: ${value}`);
}

function providerModule(value: unknown, source: string): PiFactoryProviderModule {
  const candidate = moduleRecord(value);
  if (candidate["version"] !== PI_FACTORY_PROVIDER_VERSION) {
    throw new Error(
      `provider module version must be ${String(PI_FACTORY_PROVIDER_VERSION)}: ${source}`
    );
  }
  if (typeof candidate["createProvider"] !== "function") {
    throw new Error(`provider module must export createProvider: ${source}`);
  }
  return candidate as PiFactoryProviderModule;
}

function moduleRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("provider module must export an object");
  if (value["version"] === undefined && isRecord(value["default"])) return value["default"];
  return value;
}

function optionalFunction<T extends Record<string, unknown>, K extends keyof T & string>(
  value: T,
  key: K
): Partial<Pick<T, K>> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== "function") throw new Error(`provider ${key} must be a function`);
  return { [key]: entry } as Partial<Pick<T, K>>;
}

function isProvider(value: unknown): value is Provider {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["stream"] === "function" &&
    typeof value["streamSimple"] === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
