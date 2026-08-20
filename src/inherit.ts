import path from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
  type PathMetadata,
  type ResolvedResource
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

import { resolveProviderModule, type ResolvedProviderModule } from "./provider.js";
import type { PiAppDefinition, PiInheritedPackageDefinition } from "./types.js";

export type ResolvedInheritedResource = {
  readonly path: string;
  readonly metadata: PathMetadata;
};

export type ResolvedInheritance = {
  readonly extensions: readonly ResolvedInheritedResource[];
  readonly skills: readonly ResolvedInheritedResource[];
  readonly promptTemplates: readonly ResolvedInheritedResource[];
  readonly themes: readonly ResolvedInheritedResource[];
  readonly providerModule?: ResolvedProviderModule;
};

// eslint-disable-next-line complexity -- Keep package and provider selection in one auditable boundary.
export async function resolveInheritance(input: {
  readonly app: PiAppDefinition;
  readonly cwd: string;
  readonly agentDir: string;
  readonly providerId: string;
  readonly signal?: AbortSignal;
}): Promise<ResolvedInheritance> {
  input.signal?.throwIfAborted();
  const inherit = input.app.inherit;
  if (inherit === undefined) {
    throw new Error(`provider ${input.providerId} is not selected in inherit.providers`);
  }
  const selectedProvider = input.app.providers.find((provider) => provider.id === input.providerId);
  const providerInherited = inherit.providers.includes(input.providerId);
  if (selectedProvider?.source === "pi" && !providerInherited) {
    throw new Error(`provider ${input.providerId} is not selected in inherit.providers`);
  }
  if (selectedProvider?.source !== "pi" && providerInherited) {
    throw new Error(`custom provider ${input.providerId} must not be inherited`);
  }
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir, {
    projectTrusted: false
  });
  const packageManager = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager
  });
  const configured = packageManager.listConfiguredPackages();
  const resolved = await packageManager.resolve(async () => "error");
  input.signal?.throwIfAborted();

  const selected = {
    extensions: [] as ResolvedInheritedResource[],
    skills: [] as ResolvedInheritedResource[],
    promptTemplates: [] as ResolvedInheritedResource[],
    themes: [] as ResolvedInheritedResource[]
  };
  for (const packageSelection of inherit.packages) {
    const matches = configured.filter(
      (entry) => entry.scope === "user" && entry.source === packageSelection.source
    );
    if (matches.length !== 1 || matches[0]?.installedPath === undefined) {
      throw new Error(
        `inherited package is not installed exactly once: ${packageSelection.source}`
      );
    }
    const root = path.resolve(matches[0].installedPath);
    selected.extensions.push(
      ...selectResources(packageSelection, "extensions", resolved.extensions, root)
    );
    selected.skills.push(...selectResources(packageSelection, "skills", resolved.skills, root));
    selected.promptTemplates.push(
      ...selectResources(packageSelection, "promptTemplates", resolved.prompts, root)
    );
    selected.themes.push(...selectResources(packageSelection, "themes", resolved.themes, root));
  }

  const providerModule = providerInherited
    ? await resolveProviderModule({
        providerId: input.providerId,
        packageManager,
        resolvedPaths: resolved
      })
    : undefined;
  return {
    extensions: uniqueResources(selected.extensions),
    skills: uniqueResources(selected.skills),
    promptTemplates: uniqueResources(selected.promptTemplates),
    themes: uniqueResources(selected.themes),
    ...(providerModule === undefined ? {} : { providerModule })
  };
}

function selectResources(
  selection: PiInheritedPackageDefinition,
  type: keyof Omit<PiInheritedPackageDefinition, "source">,
  resources: readonly ResolvedResource[],
  packageRoot: string
): readonly ResolvedInheritedResource[] {
  const patterns = selection[type] ?? [];
  const packageResources = resources.filter(
    (entry) => entry.metadata.scope === "user" && entry.metadata.source === selection.source
  );
  const selected: ResolvedInheritedResource[] = [];
  for (const pattern of patterns) {
    const enabled = packageResources.filter(
      (entry) =>
        entry.enabled &&
        minimatch(relativeResourcePath(packageRoot, entry.path), pattern, { dot: true })
    );
    if (enabled.length === 0) {
      throw new Error(`${type} resource ${pattern} is not enabled in ${selection.source}`);
    }
    selected.push(...enabled.map((entry) => ({ path: entry.path, metadata: entry.metadata })));
  }
  return selected;
}

function relativeResourcePath(packageRoot: string, resourcePath: string): string {
  const relative = path.relative(packageRoot, path.resolve(resourcePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`resolved package resource escapes package root: ${resourcePath}`);
  }
  return relative.split(path.sep).join("/");
}

function uniqueResources(
  resources: readonly ResolvedInheritedResource[]
): readonly ResolvedInheritedResource[] {
  const seen = new Set<string>();
  return resources.filter((entry) => {
    const key = path.resolve(entry.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
