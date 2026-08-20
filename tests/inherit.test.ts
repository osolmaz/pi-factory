import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEventBus, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { resolveInheritance } from "../src/inherit.js";
import { createPiLaunchPlan } from "../src/launch.js";
import { parsePiAppManifest, manifestToDefinition } from "../src/manifest.js";
import { createDeclaredProvider, type ResolvedProviderModule } from "../src/provider.js";
import { createPiFactoryRuntime } from "../src/runtime.js";
import type { PiAppDefinition } from "../src/types.js";

const providerId = "test-provider";
const modelId = "test-model";

describe("selective profile inheritance", () => {
  it("parses explicit provider and package selections", async () => {
    const manifest = parsePiAppManifest(`
id = "demo"
name = "Demo"
version = "0.1.0"
schema_version = 1
state_dir = "/tmp/demo"

[provider]
id = "${providerId}"
source = "pi"

[model]
id = "${modelId}"

[inherit]
providers = ["${providerId}"]

[[inherit.packages]]
source = "example"
skills = ["skills/review/SKILL.md"]
prompt_templates = ["prompts/review.md"]
`);
    const app = await manifestToDefinition(manifest, "/tmp");
    expect(app.inherit).toEqual({
      providers: [providerId],
      packages: [
        {
          source: "example",
          skills: ["skills/review/SKILL.md"],
          promptTemplates: ["prompts/review.md"]
        }
      ]
    });
  });

  it("requires Pi providers to be selected explicitly", () => {
    expect(() =>
      parsePiAppManifest(`
id = "demo"
name = "Demo"
version = "0.1.0"
schema_version = 1
state_dir = "/tmp/demo"
[provider]
id = "${providerId}"
source = "pi"
[model]
id = "${modelId}"
`)
    ).toThrow(`inherit.providers must include Pi provider ${providerId}`);
  });

  it("rejects inherited custom providers", () => {
    expect(() =>
      parsePiAppManifest(`
id = "demo"
name = "Demo"
version = "0.1.0"
schema_version = 1
state_dir = "/tmp/demo"
[provider]
id = "custom"
base_url = "https://example.test/v1"
[model]
id = "model"
[inherit]
providers = ["custom"]
`)
    ).toThrow("must not include custom provider custom");
  });

  it("resolves only selected enabled package resources and one provider module", async () => {
    const fixture = await createProfileFixture();
    try {
      const resolved = await resolveInheritance({
        app: fixture.app,
        cwd: fixture.root,
        agentDir: fixture.agentDir,
        providerId
      });
      expect(resolved.skills.map((entry) => entry.path)).toEqual([fixture.skillPath]);
      expect(resolved.promptTemplates.map((entry) => entry.path)).toEqual([fixture.promptPath]);
      expect(resolved.themes.map((entry) => entry.path)).toEqual([fixture.themePath]);
      expect(resolved.extensions).toEqual([]);
      expect(resolved.providerModule?.modulePath).toBe(fixture.providerModulePath);
      expect(await readFile(fixture.unselectedExtensionPath, "utf8")).toContain("must not load");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("builds an explicit deny-by-default Pi launch", async () => {
    const fixture = await createProfileFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
    try {
      const plan = await createPiLaunchPlan(fixture.app);
      expect(plan.env["PI_CODING_AGENT_DIR"]).toBe(fixture.agentDir);
      expect(plan.args).toEqual(
        expect.arrayContaining([
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-approve",
          "--extension",
          fixture.providerModulePath,
          "--skill",
          fixture.skillPath,
          "--prompt-template",
          fixture.promptPath
        ])
      );
      expect(plan.args).not.toContain(fixture.unselectedExtensionPath);
    } finally {
      vi.unstubAllEnvs();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("inherits package resources for a custom provider without inheriting provider state", async () => {
    const fixture = await createProfileFixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
    const customApp: PiAppDefinition = {
      ...fixture.app,
      providers: [
        {
          id: "custom",
          source: "custom",
          baseUrl: "https://example.test/v1",
          models: [{ id: modelId }]
        }
      ],
      defaultProvider: "custom",
      inherit: {
        providers: [],
        packages: fixture.app.inherit?.packages ?? []
      }
    };
    try {
      const resolved = await resolveInheritance({
        app: customApp,
        cwd: fixture.root,
        agentDir: fixture.agentDir,
        providerId: "custom"
      });
      expect(resolved.providerModule).toBeUndefined();
      expect(resolved.skills.map((entry) => entry.path)).toEqual([fixture.skillPath]);

      const plan = await createPiLaunchPlan(customApp);
      expect(plan.env["PI_CODING_AGENT_DIR"]).toBe(plan.runtimeConfig.configDir);
      expect(plan.args).toEqual(expect.arrayContaining(["--skill", fixture.skillPath]));
      expect(plan.args).not.toContain(fixture.providerModulePath);
    } finally {
      vi.unstubAllEnvs();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps one provider run active through the complete operation", async () => {
    const fixture = await createProfileFixture();
    try {
      const runtime = await createPiFactoryRuntime({
        app: fixture.app,
        cwd: fixture.root,
        agentDir: fixture.agentDir,
        appAgentDir: fixture.appAgentDir,
        providerId,
        modelId,
        appResources: {
          settingsManager: SettingsManager.create(fixture.root, fixture.appAgentDir, {
            projectTrusted: false
          }),
          eventBus: createEventBus(),
          extensionPaths: [],
          skillPaths: [],
          promptTemplatePaths: [],
          themePaths: [],
          extensionFactories: [],
          appendSystemPrompt: [],
          systemPrompt: "Test",
          noContextFiles: false
        }
      });
      expect(runtime.model.id).toBe(modelId);
      expect(runtime.providerOwnsAuthentication).toBe(true);
      await expect(runtime.run("review-1", async () => "done")).resolves.toBe("done");
      await expect(runtime.run("review-1", async () => "again")).rejects.toThrow(
        "provider run ID was already used"
      );
      await runtime.close();
      await runtime.close();
      expect((await readFile(fixture.eventsPath, "utf8")).trim().split("\n")).toEqual([
        "start:review-1",
        "finish:review-1:success",
        "close"
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects omitted, missing, disabled, and unknown selections", async () => {
    const fixture = await createProfileFixture();
    try {
      const { inherit: removedInheritance, ...withoutInheritance } = fixture.app;
      expect(removedInheritance).toBeDefined();
      await expect(
        resolveInheritance({
          app: withoutInheritance,
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          providerId
        })
      ).rejects.toThrow("not selected");
      await expect(
        resolveInheritance({
          app: {
            ...fixture.app,
            inherit: {
              providers: [providerId],
              packages: [{ source: "missing", skills: ["missing"] }]
            }
          },
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          providerId
        })
      ).rejects.toThrow("not installed exactly once");
      await expect(
        resolveInheritance({
          app: {
            ...fixture.app,
            inherit: {
              providers: [providerId],
              packages: [
                {
                  source: fixture.packageRoot,
                  extensions: ["unselected.mjs"]
                }
              ]
            }
          },
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          providerId
        })
      ).rejects.toThrow("not enabled");
      await expect(
        resolveInheritance({
          app: {
            ...fixture.app,
            inherit: {
              providers: [providerId],
              packages: [{ source: fixture.packageRoot, skills: ["missing/**"] }]
            }
          },
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          providerId
        })
      ).rejects.toThrow("not enabled");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("settles failed and cancelled runs and rejects invalid run use", async () => {
    const failed = await createProfileFixture();
    try {
      const runtime = await createPiFactoryRuntime({
        app: failed.app,
        cwd: failed.root,
        agentDir: failed.agentDir,
        appAgentDir: failed.appAgentDir,
        providerId,
        modelId
      });
      await expect(
        runtime.run("failed", () => Promise.reject(new Error("operation failed")))
      ).rejects.toThrow("operation failed");
      await runtime.run("outer", async () => {
        await expect(runtime.run("nested", async () => undefined)).rejects.toThrow(
          "already active"
        );
        await expect(runtime.close()).rejects.toThrow("cannot close active");
      });
      await expect(runtime.run("", async () => undefined)).rejects.toThrow("must not be empty");
      await runtime.close();
      await expect(runtime.run("closed", async () => undefined)).rejects.toThrow("is closed");
      expect((await readFile(failed.eventsPath, "utf8")).trim().split("\n")).toEqual([
        "start:failed",
        "finish:failed:error",
        "start:outer",
        "finish:outer:success",
        "close"
      ]);
    } finally {
      await rm(failed.root, { recursive: true, force: true });
    }

    const cancelled = await createProfileFixture();
    const controller = new AbortController();
    try {
      const runtime = await createPiFactoryRuntime({
        app: cancelled.app,
        cwd: cancelled.root,
        agentDir: cancelled.agentDir,
        appAgentDir: cancelled.appAgentDir,
        providerId,
        modelId,
        signal: controller.signal
      });
      await expect(
        runtime.run("cancelled", async () => {
          controller.abort();
          throw new Error("cancelled");
        })
      ).rejects.toThrow("cancelled");
      await runtime.close();
      expect((await readFile(cancelled.eventsPath, "utf8")).trim().split("\n")).toEqual([
        "start:cancelled",
        "finish:cancelled:cancelled",
        "close"
      ]);
    } finally {
      await rm(cancelled.root, { recursive: true, force: true });
    }
  });

  it("validates provider module versions, provider shape, IDs, and lifecycle functions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-provider-module-"));
    const declaration = (name: string): ResolvedProviderModule => {
      const modulePath = path.join(root, `${name}.mjs`);
      return {
        providerId,
        source: root,
        packageRoot: root,
        modulePath,
        activationExtensionPath: modulePath
      };
    };
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        createDeclaredProvider({
          declaration: declaration("aborted"),
          agentDir: root,
          signal: controller.signal
        })
      ).rejects.toThrow();

      const wrongVersion = declaration("wrong-version");
      await writeFile(
        wrongVersion.modulePath,
        "export const version = 2; export function createProvider() {}\n"
      );
      await expect(
        createDeclaredProvider({ declaration: wrongVersion, agentDir: root })
      ).rejects.toThrow("module version");

      const missingFactory = declaration("missing-factory");
      await writeFile(missingFactory.modulePath, "export const version = 1;\n");
      await expect(
        createDeclaredProvider({ declaration: missingFactory, agentDir: root })
      ).rejects.toThrow("createProvider");

      const invalidProvider = declaration("invalid-provider");
      await writeFile(
        invalidProvider.modulePath,
        "export const version = 1; export function createProvider() { return {}; }\n"
      );
      await expect(
        createDeclaredProvider({ declaration: invalidProvider, agentDir: root })
      ).rejects.toThrow("invalid provider");

      const wrongId = declaration("wrong-id");
      await writeFile(wrongId.modulePath, wrongProviderModuleSource());
      await expect(
        createDeclaredProvider({ declaration: wrongId, agentDir: root })
      ).rejects.toThrow(`expected ${providerId}`);

      const invalidLifecycle = declaration("invalid-lifecycle");
      const invalidLifecycleEvents = path.join(root, "invalid-lifecycle-events.txt");
      await writeFile(
        invalidLifecycle.modulePath,
        invalidLifecycleModuleSource(invalidLifecycleEvents)
      );
      await expect(
        createDeclaredProvider({ declaration: invalidLifecycle, agentDir: root })
      ).rejects.toThrow("startRun must be a function");
      expect(await readFile(invalidLifecycleEvents, "utf8")).toBe("close\n");

      const valid = declaration("valid");
      const eventsPath = path.join(root, "valid-events.txt");
      await writeFile(valid.modulePath, providerModuleSource(eventsPath));
      const created = await createDeclaredProvider({ declaration: valid, agentDir: root });
      await created.startRun?.("valid");
      await created.finishRun?.("valid", "success");
      await created.close?.();

      const defaultExport = declaration("default-export");
      await writeFile(defaultExport.modulePath, defaultProviderModuleSource());
      const defaultCreated = await createDeclaredProvider({
        declaration: defaultExport,
        agentDir: root
      });
      expect(defaultCreated.provider.id).toBe(providerId);

      const withOptions = declaration("with-options");
      await writeFile(withOptions.modulePath, providerModuleSource(path.join(root, "options.txt")));
      const activeController = new AbortController();
      const configured = await createDeclaredProvider({
        declaration: withOptions,
        agentDir: root,
        nativeProvider: created.provider,
        signal: activeController.signal
      });
      await configured.close?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fall back after an enabled provider module fails", async () => {
    const fixture = await createProfileFixture({ failingProvider: true });
    try {
      await expect(
        createPiFactoryRuntime({
          app: fixture.app,
          cwd: fixture.root,
          agentDir: fixture.agentDir,
          appAgentDir: fixture.appAgentDir,
          providerId,
          modelId
        })
      ).rejects.toThrow("selected provider failed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createProfileFixture(options: { readonly failingProvider?: boolean } = {}): Promise<{
  readonly root: string;
  readonly agentDir: string;
  readonly appAgentDir: string;
  readonly packageRoot: string;
  readonly app: PiAppDefinition;
  readonly skillPath: string;
  readonly promptPath: string;
  readonly providerModulePath: string;
  readonly unselectedExtensionPath: string;
  readonly themePath: string;
  readonly eventsPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-inherit-"));
  const agentDir = path.join(root, "agent");
  const appAgentDir = path.join(root, "app-agent");
  const packageRoot = path.join(root, "provider-package");
  const skillPath = path.join(packageRoot, "skills", "review", "SKILL.md");
  const promptPath = path.join(packageRoot, "prompts", "review.md");
  const activationPath = path.join(packageRoot, "index.mjs");
  const unselectedExtensionPath = path.join(packageRoot, "unselected.mjs");
  const providerModulePath = path.join(packageRoot, "provider-module.mjs");
  const themePath = path.join(packageRoot, "themes", "test.json");
  const eventsPath = path.join(root, "events.txt");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(promptPath), { recursive: true });
  await mkdir(path.dirname(themePath), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(appAgentDir, { recursive: true });
  await writeFile(skillPath, "# Review skill\n");
  await writeFile(promptPath, "Review prompt\n");
  await writeFile(themePath, '{"name":"test","colors":{}}\n');
  await writeFile(activationPath, "export default function activate() {}\n");
  await writeFile(unselectedExtensionPath, "throw new Error('must not load');\n");
  await writeFile(
    providerModulePath,
    options.failingProvider === true
      ? `export const version = 1; export function createProvider() { throw new Error("selected provider failed"); }\n`
      : providerModuleSource(eventsPath)
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "test-provider-package",
        type: "module",
        pi: {
          extensions: ["./index.mjs", "./unselected.mjs"],
          skills: ["./skills"],
          prompts: ["./prompts"],
          themes: ["./themes"]
        },
        piFactory: {
          providers: [
            {
              version: 1,
              id: providerId,
              module: "./provider-module.mjs",
              extension: "./index.mjs"
            }
          ]
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({
      packages: [
        {
          source: packageRoot,
          autoload: false,
          extensions: ["index.mjs"],
          skills: ["skills/review/SKILL.md"],
          prompts: ["prompts/review.md"],
          themes: ["themes/test.json"]
        }
      ]
    })}\n`
  );
  const app: PiAppDefinition = {
    id: "test-app",
    name: "Test App",
    stateDir: path.join(root, "state"),
    sessionDir: path.join(root, "sessions"),
    piCommand: ["true"],
    providers: [{ id: providerId, source: "pi", models: [{ id: modelId }] }],
    defaultProvider: providerId,
    defaultModel: modelId,
    thinking: "off",
    inherit: {
      providers: [providerId],
      packages: [
        {
          source: packageRoot,
          skills: ["skills/review/SKILL.md"],
          promptTemplates: ["prompts/review.md"],
          themes: ["themes/test.json"]
        }
      ]
    }
  };
  return {
    root,
    agentDir,
    appAgentDir,
    packageRoot,
    app,
    skillPath,
    promptPath,
    providerModulePath,
    unselectedExtensionPath,
    themePath,
    eventsPath
  };
}

function defaultProviderModuleSource(): string {
  return `
export default {
  version: 1,
  createProvider() {
    return { provider: { id: ${JSON.stringify(providerId)}, stream() {}, streamSimple() {} } };
  }
};
`;
}

function wrongProviderModuleSource(): string {
  return `
export const version = 1;
export function createProvider() {
  return {
    provider: { id: "wrong", stream() {}, streamSimple() {} },
    close() {}
  };
}
`;
}

function invalidLifecycleModuleSource(eventsPath: string): string {
  return `
import { appendFile } from "node:fs/promises";
export const version = 1;
export function createProvider() {
  return {
    provider: { id: ${JSON.stringify(providerId)}, stream() {}, streamSimple() {} },
    startRun: 1,
    close: async () => appendFile(${JSON.stringify(eventsPath)}, "close\\n")
  };
}
`;
}

function providerModuleSource(eventsPath: string): string {
  const events = JSON.stringify(eventsPath);
  return `
import { appendFile } from "node:fs/promises";
export const version = 1;
const model = {
  id: ${JSON.stringify(modelId)},
  name: "Test Model",
  api: "openai-completions",
  provider: ${JSON.stringify(providerId)},
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024
};
export function createProvider() {
  return {
    provider: {
      id: ${JSON.stringify(providerId)},
      name: "Test Provider",
      auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
      getModels: () => [model],
      stream: () => { throw new Error("unused stream"); },
      streamSimple: () => { throw new Error("unused stream"); }
    },
    startRun: async (id) => appendFile(${events}, "start:" + id + "\\n"),
    finishRun: async (id, status) => appendFile(${events}, "finish:" + id + ":" + status + "\\n"),
    close: async () => appendFile(${events}, "close\\n")
  };
}
export default function providerExtension() {}
`;
}
