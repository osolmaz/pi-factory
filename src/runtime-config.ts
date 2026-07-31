import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { withoutUndefined } from "./json.js";
import type { PiAppDefinition, PiModelDefinition, PiRuntimeConfig } from "./types.js";

export async function writePiRuntimeConfig(app: PiAppDefinition): Promise<PiRuntimeConfig> {
  const paths = runtimeConfigPathsForApp(app);
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.modelsPath, `${JSON.stringify(modelsConfig(app), null, 2)}\n`);
  await writeFile(paths.settingsPath, `${JSON.stringify(settingsConfig(app), null, 2)}\n`);
  return paths;
}

export function runtimeConfigPathsForApp(app: PiAppDefinition): PiRuntimeConfig {
  const configDir = path.join(app.stateDir, "pi-config-runtime");
  return {
    configDir,
    modelsPath: path.join(configDir, "models.json"),
    settingsPath: path.join(configDir, "settings.json")
  };
}

function modelsConfig(app: PiAppDefinition): unknown {
  return {
    providers: Object.fromEntries(
      app.providers
        .filter((provider) => provider.source !== "pi")
        .map((provider) => [
          provider.id,
          {
            baseUrl: provider.baseUrl,
            api: provider.api ?? "openai-completions",
            apiKey: provider.apiKey ?? "local",
            compat: {
              supportsDeveloperRole: provider.compat?.supportsDeveloperRole ?? false,
              supportsReasoningEffort: provider.compat?.supportsReasoningEffort ?? false
            },
            models: provider.models.map((model) => modelConfig(model))
          }
        ])
    )
  };
}

function modelConfig(model: PiModelDefinition): unknown {
  return withoutUndefined({
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    compat:
      model.thinkingFormat === undefined ? undefined : { thinkingFormat: model.thinkingFormat },
    input: model.input ?? ["text"],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    }
  });
}

function settingsConfig(app: PiAppDefinition): unknown {
  const provider = app.providers.find((entry) => entry.id === app.defaultProvider);
  const model = provider?.models.find((entry) => entry.id === app.defaultModel);
  return withoutUndefined({
    defaultProvider: app.defaultProvider,
    defaultModel: app.defaultModel,
    defaultThinkingLevel: app.thinking,
    enableInstallTelemetry: false,
    quietStartup: true,
    compaction: provider?.source === "pi" ? undefined : compactionConfig(model?.contextWindow)
  });
}

function compactionConfig(contextWindow: number | undefined): unknown {
  if (contextWindow === undefined) {
    return { enabled: false };
  }
  return {
    enabled: true,
    reserveTokens: Math.max(256, Math.min(16384, Math.floor(contextWindow / 4))),
    keepRecentTokens: Math.max(512, Math.min(20000, Math.floor(contextWindow / 2)))
  };
}
