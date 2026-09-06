import path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";

import { resolveInheritance, type ResolvedInheritance } from "./inherit.js";
import {
  createDeclaredProvider,
  type CreatedPiFactoryProvider,
  type PiFactoryRunStatus
} from "./provider.js";
import type { PiAppDefinition } from "./types.js";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export type PiFactoryAppResources = {
  readonly settingsManager?: ResourceLoaderOptions["settingsManager"];
  readonly eventBus?: ResourceLoaderOptions["eventBus"];
  readonly extensionPaths?: readonly string[];
  readonly skillPaths?: readonly string[];
  readonly promptTemplatePaths?: readonly string[];
  readonly themePaths?: readonly string[];
  readonly extensionFactories?: ResourceLoaderOptions["extensionFactories"];
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly noContextFiles?: boolean;
};

export type PiFactoryRuntime = {
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly resourceLoader: ResourceLoader;
  readonly inheritance: ResolvedInheritance;
  readonly run: <T>(runId: string, operation: () => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
  readonly providerOwnsAuthentication: boolean;
};

// eslint-disable-next-line complexity -- Keep provider registration and cleanup order in one boundary.
export async function createPiFactoryRuntime(input: {
  readonly app: PiAppDefinition;
  readonly cwd: string;
  readonly agentDir: string;
  readonly appAgentDir: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly appResources?: PiFactoryAppResources;
  readonly prepareModelRuntime?: (modelRuntime: ModelRuntime) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<PiFactoryRuntime> {
  const inheritance = await resolveInheritance({
    app: input.app,
    cwd: input.cwd,
    agentDir: input.agentDir,
    providerId: input.providerId,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(input.agentDir, "auth.json"),
    modelsPath: path.join(input.agentDir, "models.json"),
    modelsStorePath: path.join(input.agentDir, "models-store.json"),
    allowModelNetwork: false,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  let createdProvider: CreatedPiFactoryProvider | undefined;
  try {
    await input.prepareModelRuntime?.(modelRuntime);
    if (inheritance.providerModule !== undefined) {
      const nativeProvider = modelRuntime.getProvider(input.providerId);
      createdProvider = await createDeclaredProvider({
        declaration: inheritance.providerModule,
        agentDir: input.agentDir,
        ...(nativeProvider === undefined ? {} : { nativeProvider }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      modelRuntime.registerNativeProvider(createdProvider.provider);
    }
    const model = modelRuntime.getModel(input.providerId, input.modelId);
    if (model === undefined) {
      throw new Error(`model not found: ${input.providerId}/${input.modelId}`);
    }
    if (!(await modelRuntime.checkAuth(input.providerId))) {
      throw new Error(`no authentication for provider ${input.providerId}`);
    }
    const resourceLoader = createSelectedResourceLoader(input, inheritance);
    await resourceLoader.reload();
    const extensionErrors = resourceLoader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      throw new Error(
        `selected extension failed to load: ${extensionErrors
          .map((entry) => entry.error)
          .join("; ")}`
      );
    }
    return runtimeResult(
      modelRuntime,
      model,
      resourceLoader,
      inheritance,
      createdProvider,
      input.signal
    );
  } catch (error) {
    await createdProvider?.close?.();
    throw error;
  }
}

// eslint-disable-next-line complexity -- Map app and inherited resources without changing their ownership.
function createSelectedResourceLoader(
  input: Parameters<typeof createPiFactoryRuntime>[0],
  inheritance: ResolvedInheritance
): DefaultResourceLoader {
  const resources = input.appResources;
  return new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.appAgentDir,
    ...(resources?.settingsManager === undefined
      ? {}
      : { settingsManager: resources.settingsManager }),
    ...(resources?.eventBus === undefined ? {} : { eventBus: resources.eventBus }),
    additionalExtensionPaths: [
      ...(resources?.extensionPaths ?? []),
      ...inheritance.extensions.map((entry) => entry.path)
    ],
    additionalSkillPaths: [
      ...(resources?.skillPaths ?? []),
      ...inheritance.skills.map((entry) => entry.path)
    ],
    additionalPromptTemplatePaths: [
      ...(resources?.promptTemplatePaths ?? []),
      ...inheritance.promptTemplates.map((entry) => entry.path)
    ],
    additionalThemePaths: [
      ...(resources?.themePaths ?? []),
      ...inheritance.themes.map((entry) => entry.path)
    ],
    ...(resources?.extensionFactories === undefined
      ? {}
      : { extensionFactories: resources.extensionFactories }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: resources?.noContextFiles ?? true,
    ...(resources?.systemPrompt === undefined ? {} : { systemPrompt: resources.systemPrompt }),
    ...(resources?.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: [...resources.appendSystemPrompt] })
  });
}

function runtimeResult(
  modelRuntime: ModelRuntime,
  model: Model<Api>,
  resourceLoader: ResourceLoader,
  inheritance: ResolvedInheritance,
  provider: CreatedPiFactoryProvider | undefined,
  signal: AbortSignal | undefined
): PiFactoryRuntime {
  let activeRun: string | undefined;
  const usedRunIds = new Set<string>();
  let closed = false;
  // eslint-disable-next-line complexity -- Own one complete provider run and its guaranteed settlement.
  const run = async <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error("pi-factory runtime is closed");
    if (runId === "") throw new Error("run ID must not be empty");
    if (activeRun !== undefined) throw new Error(`provider run ${activeRun} is already active`);
    if (usedRunIds.has(runId)) throw new Error(`provider run ID was already used: ${runId}`);
    usedRunIds.add(runId);
    activeRun = runId;
    let status: PiFactoryRunStatus = "success";
    try {
      await provider?.startRun?.(runId);
      return await operation();
    } catch (error) {
      status = signal?.aborted === true ? "cancelled" : "error";
      throw error;
    } finally {
      if (status === "success" && signal?.aborted === true) status = "cancelled";
      try {
        await provider?.finishRun?.(runId, status);
      } finally {
        activeRun = undefined;
      }
    }
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    if (activeRun !== undefined) throw new Error(`cannot close active provider run ${activeRun}`);
    closed = true;
    await provider?.close?.();
  };
  return {
    modelRuntime,
    model,
    resourceLoader,
    inheritance,
    run,
    close,
    providerOwnsAuthentication: provider !== undefined
  };
}
