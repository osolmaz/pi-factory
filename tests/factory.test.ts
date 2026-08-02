import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/cli.js";
import { initPiApp } from "../src/init.js";
import { installPiApp, parseGithubSource } from "../src/install.js";
import {
  createPiCommandPlan,
  createPiLaunchPlan,
  execPiLaunchPlan,
  runPiCommand,
  shellCommand
} from "../src/launch.js";
import { loadPiApp, manifestToDefinition, parsePiAppManifest } from "../src/manifest.js";
import { expandPath, safePathComponent } from "../src/paths.js";
import {
  linkPiApp,
  listPiApps,
  loadAppIndex,
  managedAppPath,
  uninstallPiApp
} from "../src/registry.js";
import { writePiRuntimeConfig } from "../src/runtime-config.js";

describe("pi-factory", () => {
  it("parses pi-factory.toml manifests", () => {
    const manifest = parsePiAppManifest(sampleManifest("/tmp/pi-factory-state"));
    expect(manifest.id).toBe("demo-agent");
    expect(manifest.provider.id).toBe("local-openai");
    expect(manifest.extensions?.[0]?.path).toBe("extensions/demo.ts");
  });

  it("loads manifests and creates native Pi launch plans", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const plan = await createPiLaunchPlan(app);
      expect(plan.command).toBe("true");
      expect(plan.args).toContain("--provider");
      expect(plan.args).toContain("local-openai");
      expect(plan.args).toContain("--extension");
      expect(plan.args).toContain(path.join(root, "extensions", "demo.ts"));
      expect(plan.args).toContain("--append-system-prompt");
      expect(plan.env["PI_CODING_AGENT_DIR"]).toContain("pi-config-runtime");
      expect(shellCommand("pi", ["quoted 'arg'"])).toBe("pi 'quoted '\\''arg'\\'''");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generated Pi config env ahead of app env overrides", async () => {
    const plan = await createPiLaunchPlan({
      id: "demo-agent",
      name: "Demo Agent",
      stateDir: "/tmp/pi-factory-state",
      sessionDir: "/tmp/pi-factory-sessions",
      piCommand: ["sh"],
      providers: [
        { id: "local-openai", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "auto" }] }
      ],
      defaultProvider: "local-openai",
      defaultModel: "auto",
      thinking: "medium",
      env: {
        PI_CODING_AGENT_DIR: "/tmp/wrong-config",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/wrong-sessions",
        CUSTOM_ENV: "1"
      }
    });
    expect(plan.env["PI_CODING_AGENT_DIR"]).toContain("pi-config-runtime");
    expect(plan.env["PI_CODING_AGENT_SESSION_DIR"]).toBe("/tmp/pi-factory-sessions");
    expect(plan.env["CUSTOM_ENV"]).toBe("1");
    expect(plan.warnings).toContain("ignored managed env PI_CODING_AGENT_DIR");
  });

  it("keeps launch args minimal when optional fields are absent", async () => {
    const plan = await createPiLaunchPlan({
      id: "minimal-agent",
      name: "Minimal Agent",
      stateDir: "/tmp/pi-factory-state",
      sessionDir: "/tmp/pi-factory-sessions",
      piCommand: ["true"],
      providers: [
        { id: "local-openai", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "auto" }] }
      ],
      defaultProvider: "local-openai",
      defaultModel: "auto",
      thinking: "medium",
      forwardedArgs: ["--tools", "read"]
    });
    expect(plan.args).not.toContain("--system-prompt");
    expect(plan.args.filter((arg) => arg === "--tools")).toHaveLength(1);
    await expect(execPiLaunchPlan({ ...plan, command: "" })).rejects.toThrow(
      "launch command must not be empty"
    );
  });

  it("preserves launch argv and environment values", async () => {
    const plan = await createPiLaunchPlan({
      id: "minimal-agent",
      name: "Minimal Agent",
      stateDir: "/tmp/pi-factory-state",
      sessionDir: "/tmp/pi-factory-sessions",
      piCommand: ["sh", "-c", 'test "$LOCALPI_TEST" = ok'],
      providers: [
        { id: "local-openai", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "auto" }] }
      ],
      defaultProvider: "local-openai",
      defaultModel: "auto",
      thinking: "medium",
      env: { LOCALPI_TEST: "ok" }
    });

    await expect(execPiLaunchPlan(plan)).resolves.toBe(0);
  });

  it("supports Pi catalog providers without replacing their catalog", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-catalog-"));
    try {
      const manifest = parsePiAppManifest(`id = "reviewer"
name = "Reviewer"
version = "0.1.0"
schema_version = 1
state_dir = "${stateDir}"
pi_command = ["true"]
thinking = "high"

[provider]
id = "openai-codex"
source = "pi"

[model]
id = "gpt-review"
reasoning = true
`);
      const app = await manifestToDefinition(manifest, stateDir);
      expect(app.providers[0]).toMatchObject({ id: "openai-codex", source: "pi" });
      const runtime = await writePiRuntimeConfig(app);
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, unknown>;
      };
      expect(models.providers).toEqual({});
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        defaultProvider?: string;
        defaultModel?: string;
        defaultThinkingLevel?: string;
        compaction?: unknown;
      };
      expect(settings).toMatchObject({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-review",
        defaultThinkingLevel: "high"
      });
      expect(settings).not.toHaveProperty("compaction");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects custom fields on Pi catalog providers", () => {
    expect(() =>
      parsePiAppManifest(`id = "reviewer"
name = "Reviewer"
version = "0.1.0"
schema_version = 1
state_dir = "/tmp/reviewer"

[provider]
id = "openai-codex"
source = "pi"
base_url = "https://example.invalid"
api = "openai-completions"

[model]
id = "gpt-review"
`)
    ).toThrow("provider.base_url is not allowed when provider.source is pi");
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace(
          'id = "local-openai"',
          'id = "local-openai"\nsource = "unknown"'
        )
      )
    ).toThrow("provider.source must be pi or custom");
  });

  it("applies model overrides and ephemeral sessions to launch plans", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const plan = await createPiLaunchPlan(app, undefined, {
        provider: "openai-codex",
        model: "gpt-review",
        thinking: "high",
        noSession: true,
        mode: "json",
        messages: ["Review this change"]
      });
      expect(plan.args).toContain("openai-codex");
      expect(plan.args).toContain("gpt-review");
      expect(plan.args).toContain("high");
      expect(plan.args.slice(-4)).toEqual(["--mode", "json", "--no-session", "Review this change"]);
      await expect(
        createPiLaunchPlan(app, undefined, { noSession: true, session: "saved" })
      ).rejects.toThrow("noSession and session are mutually exclusive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates native Pi command plans in the isolated app profile", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const plan = await createPiCommandPlan(app, ["auth", "login", "openai-codex"]);
      expect(plan.args).toEqual(["auth", "login", "openai-codex"]);
      expect(plan.env["PI_CODING_AGENT_DIR"]).toContain("pi-config-runtime");
      expect(plan.env["PI_CODING_AGENT_SESSION_DIR"]).toBe(app.sessionDir);
      await expect(runPiCommand(app, ["--version"])).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes Pi models and settings config", async () => {
    const root = await createAppBundle();
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      const runtime = await writePiRuntimeConfig(app);
      const models = JSON.parse(await readFile(runtime.modelsPath, "utf8")) as {
        providers: Record<string, { models: readonly { id: string; contextWindow?: number }[] }>;
      };
      expect(models.providers["local-openai"]?.models[0]).toMatchObject({
        id: "auto",
        contextWindow: 4096
      });
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        defaultProvider?: string;
        defaultModel?: string;
        compaction?: { enabled?: boolean };
      };
      expect(settings.defaultProvider).toBe("local-openai");
      expect(settings.defaultModel).toBe("auto");
      expect(settings.compaction?.enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes disabled compaction when the selected model has no context window", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-runtime-"));
    try {
      const runtime = await writePiRuntimeConfig({
        id: "minimal-agent",
        name: "Minimal Agent",
        stateDir,
        sessionDir: path.join(stateDir, "sessions"),
        piCommand: ["true"],
        providers: [
          {
            id: "local-openai",
            baseUrl: "http://127.0.0.1:1234/v1",
            apiKey: "test-key",
            compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
            models: [
              {
                id: "auto",
                name: "Auto",
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
        ],
        defaultProvider: "missing-provider",
        defaultModel: "missing-model",
        thinking: "off"
      });
      const settings = JSON.parse(await readFile(runtime.settingsPath, "utf8")) as {
        compaction?: { enabled?: boolean };
      };
      expect(settings.compaction?.enabled).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves relative state paths from the app bundle root", async () => {
    const root = await createAppBundle("relative-state");
    try {
      const loaded = await loadPiApp({ appDir: root });
      const app = await manifestToDefinition(loaded.manifest, loaded.appRoot);
      expect(app.stateDir).toBe(path.join(root, "relative-state"));
      expect(app.sessionDir).toBe(path.join(root, "relative-state", "sessions"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed optional manifest fields", () => {
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace(
          'tools = ["read", "bash"]',
          'tools = "bash"'
        )
      )
    ).toThrow("tools must be an array of strings");
  });

  it("reports missing provider and model tables as validation errors", () => {
    expect(() =>
      parsePiAppManifest(`id = "demo"
name = "Demo"
version = "0.1.0"
schema_version = 1
state_dir = "/tmp/pi-factory-state"
`)
    ).toThrow("provider table is required");
  });

  it("rejects invalid provider and thinking enum values", () => {
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state")
          .replace('api = "openai-completions"', 'api = "typo"')
          .replace("reasoning = false", 'reasoning = false\nthinking_format = "bogus"')
      )
    ).toThrow("provider.api must be openai-completions");
  });

  it("rejects malformed optional model fields", () => {
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace(
          "context_window = 4096",
          'context_window = "4096"'
        )
      )
    ).toThrow("context_window must be a number");
  });

  it("rejects malformed optional string fields", () => {
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace('pi_command = ["true"]', "pi_command = 123")
      )
    ).toThrow("pi_command must be an array of strings");
  });

  it("preserves build platform filters", () => {
    const manifest = parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[build]]
command = ["echo", "build"]
platforms = ["linux"]
`);
    expect(manifest.build?.[0]).toEqual({ command: ["echo", "build"], platforms: ["linux"] });
  });

  it("accepts optional manifest variants", () => {
    const manifest = parsePiAppManifest(
      sampleManifest("/tmp/pi-factory-state")
        .replace('append_system_prompt = "prompts/extension.md"', "")
        .replace("reasoning = false", 'reasoning = true\nthinking_format = "qwen-chat-template"')
    );
    expect(manifest.extensions?.[0]).toEqual({ path: "extensions/demo.ts" });
    expect(manifest.model.thinking_format).toBe("qwen-chat-template");
  });

  it("rejects unknown build platform filters", () => {
    expect(() =>
      parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[build]]
command = ["echo", "build"]
platforms = ["darwin"]
`)
    ).toThrow("build[0].platforms must contain only linux, macos, or windows");
  });

  it("rejects malformed manifest collections", () => {
    const base = sampleManifest("/tmp/pi-factory-state").split("\n[[extensions]]")[0] ?? "";
    expect(() =>
      parsePiAppManifest(base.replace("\n[provider]", '\nextensions = "bad"\n\n[provider]'))
    ).toThrow("extensions must be an array of tables");
    expect(() =>
      parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[extensions]]
append_system_prompt = "missing-path.md"
`)
    ).toThrow("extensions[1].path is required");
    expect(() =>
      parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[extensions]]
path = "extensions/typed.ts"
append_system_prompt = 123
`)
    ).toThrow("extensions[1].append_system_prompt must be a string");
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace(
          "\n[provider]",
          '\nbuild = "bad"\n\n[provider]'
        )
      )
    ).toThrow("build must be an array of tables");
    expect(() =>
      parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[build]]
command = ["echo", 1]
`)
    ).toThrow("build[0].command must be an array of strings");
    expect(() =>
      parsePiAppManifest(`${sampleManifest("/tmp/pi-factory-state")}
[[build]]
platforms = ["linux"]
`)
    ).toThrow("build[0].command is required");
    expect(() =>
      parsePiAppManifest(
        sampleManifest("/tmp/pi-factory-state").replace(
          "\n[provider]",
          "\n[env]\nNUMBER = 1\n\n[provider]"
        )
      )
    ).toThrow("env must be a table of string values");
  });

  it("does not overwrite existing app bundles on init", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-init-"));
    await writeFile(path.join(root, "pi-factory.toml"), "existing\n");
    try {
      await expect(initPiApp("demo-agent", root)).rejects.toThrow("pi-factory.toml");
      await expect(readFile(path.join(root, "pi-factory.toml"), "utf8")).resolves.toBe(
        "existing\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid app ids on init", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-init-"));
    try {
      await expect(initPiApp("bad id", path.join(root, "bad id"))).rejects.toThrow(
        "app id may only contain"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a usable app bundle on init", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-init-"));
    const appDir = path.join(root, "sample-agent");
    try {
      const created = await initPiApp("sample-agent", appDir);
      expect(created).toBe(appDir);
      const loaded = await loadPiApp({ appDir });
      expect(loaded.manifest.id).toBe("sample-agent");
      expect((await stat(path.join(appDir, "extensions"))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links local app bundles and lists them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await createAppBundle();
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      const linked = await linkPiApp(root);
      expect(linked.appId).toBe("demo-agent");
      const result = await run(["list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("demo-agent");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps stale linked apps visible with warnings", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await createAppBundle();
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      await linkPiApp(root);
      await rm(root, { recursive: true, force: true });
      const apps = await listPiApps();
      expect(apps[0]?.warnings?.[0]).toContain("manifest unavailable");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("loads project-local apps even when the installed index is malformed", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-project-"));
    const previousState = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      await writeFile(path.join(stateDir, "apps.json"), "{bad json");
      await mkdir(path.join(root, ".pi", "apps", "demo-agent"), { recursive: true });
      await writeFile(
        path.join(root, ".pi", "apps", "demo-agent", "pi-factory.toml"),
        minimalManifest("demo-agent", path.join(root, "state"))
      );
      const loaded = await loadPiApp({ app: "demo-agent" });
      expect(loaded.manifest.id).toBe("demo-agent");
    } finally {
      cwdSpy.mockRestore();
      restoreEnv("PI_FACTORY_STATE_DIR", previousState);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("validates linked app ids through the installed app index", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await createAppBundle();
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      await linkPiApp(root);
      const result = await run(["validate", "demo-agent"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("valid demo-agent");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("supports plan, inspect, help, and uninstall CLI commands", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const root = await createAppBundle();
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      await linkPiApp(root);
      const help = await run(["--help"]);
      expect(help.stdout).toContain("pi-factory - run declarative Pi app bundles");

      const plan = await run(["plan", "demo-agent"]);
      expect(plan.code).toBe(0);
      expect(plan.stdout).toContain('"note": "plan does not write runtime config or launch Pi"');

      const inspect = await run(["inspect", "--app-dir", root]);
      expect(inspect.code).toBe(0);
      expect(inspect.stdout).toContain('"id": "demo-agent"');

      const validateDir = await run(["validate", root]);
      expect(validateDir.stdout).toContain("valid demo-agent");
      const validateFile = await run(["validate", path.join(root, "pi-factory.toml")]);
      expect(validateFile.stdout).toContain("valid demo-agent");

      const uninstall = await run(["uninstall", "demo-agent"]);
      expect(uninstall.stdout).toBe("uninstalled\n");
      const secondUninstall = await run(["uninstall", "demo-agent"]);
      expect(secondUninstall.stdout).toBe("not installed\n");
      const unknown = await run(["unknown"]);
      expect(unknown.code).toBe(2);
      const removedAuth = await run(["auth", "status", "demo-agent"]);
      expect(removedAuth.code).toBe(2);
      expect(removedAuth.stderr).toContain("unknown command: auth");
      const missingAppDir = await run(["plan", "--app-dir"]);
      expect(missingAppDir.stderr).toContain("--app-dir requires a value");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(root, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("installs GitHub shorthand apps through a fake git command", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-bin-"));
    const previousState = process.env["PI_FACTORY_STATE_DIR"];
    const previousPath = process.env["PATH"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    process.env["PATH"] = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await writeFakeGit(binDir);
      const installed = await installPiApp({
        source: "owner/repo/apps/demo",
        requestedRef: "main",
        yes: true
      });
      expect(installed.appId).toBe("remote-agent");
      expect(installed.source).toMatchObject({
        kind: "github",
        owner: "owner",
        repo: "repo",
        requestedRef: "main",
        resolvedCommit: "abc123def4567890"
      });
      await expect(readFile(path.join(installed.appRoot, "build.txt"), "utf8")).resolves.toBe(
        "built"
      );
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("PI_FACTORY_STATE_DIR", previousState);
      await rm(binDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("installs root app bundles without optional source fields", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-bin-"));
    const previousState = process.env["PI_FACTORY_STATE_DIR"];
    const previousPath = process.env["PATH"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    process.env["PATH"] = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await writeFakeGit(binDir);
      const installed = await installPiApp({ source: "owner/rootrepo", yes: true });
      const oldRoot = installed.appRoot;
      expect(installed.appId).toBe("root-agent");
      expect(installed.source).toMatchObject({
        kind: "github",
        owner: "owner",
        repo: "rootrepo"
      });
      expect(installed.source).not.toHaveProperty("subdir");
      expect(installed.source).not.toHaveProperty("requestedRef");
      const updated = await installPiApp({
        source: "owner/rootrepo",
        requestedRef: "next",
        yes: true
      });
      expect(updated.appRoot).not.toBe(oldRoot);
      await expect(stat(oldRoot)).rejects.toThrow();
      await expect(uninstallPiApp("root-agent")).resolves.toBe(true);
      await expect(stat(updated.appRoot)).rejects.toThrow();
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("PI_FACTORY_STATE_DIR", previousState);
      await rm(binDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("requires --yes for noninteractive remote installs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const binDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-bin-"));
    const previousState = process.env["PI_FACTORY_STATE_DIR"];
    const previousPath = process.env["PATH"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    process.env["PATH"] = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await writeFakeGit(binDir);
      await expect(installPiApp({ source: "owner/rootrepo" })).rejects.toThrow("requires --yes");
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("PI_FACTORY_STATE_DIR", previousState);
      await rm(binDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported install sources", () => {
    expect(parseGithubSource("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(() => parseGithubSource("https://github.com/owner/repo")).toThrow("GitHub shorthand");
    expect(() => parseGithubSource("owner")).toThrow("usage: pi-factory install");
  });

  it("expands path helpers predictably", () => {
    const previous = process.env["PI_FACTORY_TEST_DIR"];
    process.env["PI_FACTORY_TEST_DIR"] = "nested";
    try {
      expect(expandPath("~")).toBe(os.homedir());
      expect(expandPath("$PI_FACTORY_TEST_DIR/file", "/tmp/root")).toBe(
        path.join("/tmp/root", "nested", "file")
      );
      expect(expandPath("${PI_FACTORY_TEST_DIR}/file", "/tmp/root")).toBe(
        path.join("/tmp/root", "nested", "file")
      );
      expect(safePathComponent(" ??? ")).toBe("app");
      expect(managedAppPath("Demo Agent!")).toContain("Demo-Agent");
    } finally {
      restoreEnv("PI_FACTORY_TEST_DIR", previous);
    }
  });

  it("surfaces malformed installed app indexes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-state-"));
    const previous = process.env["PI_FACTORY_STATE_DIR"];
    process.env["PI_FACTORY_STATE_DIR"] = stateDir;
    try {
      await writeFile(path.join(stateDir, "apps.json"), "{not json");
      await expect(loadAppIndex()).rejects.toThrow("failed to load Pi Factory app index");
    } finally {
      restoreEnv("PI_FACTORY_STATE_DIR", previous);
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs a fake Pi command without touching real providers", async () => {
    const root = await createAppBundle();
    const fakePi = path.join(root, "fake-pi.sh");
    await writeFile(
      fakePi,
      '#!/bin/sh\n[ -d "$PI_CODING_AGENT_SESSION_DIR" ] || exit 42\nprintf \'%s\\n\' "$PI_CODING_AGENT_DIR" > pi-dir.txt\n'
    );
    await chmod(fakePi, 0o755);
    await writeFile(
      path.join(root, "pi-factory.toml"),
      sampleManifest(path.join(root, "state")).replace('["true"]', JSON.stringify([fakePi]))
    );
    try {
      const result = await run(["run", "--app-dir", root]);
      expect(result.code).toBe(0);
      const piDir = await readFile(path.join(root, "pi-dir.txt"), "utf8");
      expect(piDir).toContain("pi-config-runtime");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFakeGit(binDir: string): Promise<void> {
  const fakeGit = path.join(binDir, "git");
  await writeFile(
    fakeGit,
    `#!/bin/sh
set -eu
if [ "$1" = "clone" ]; then
  root_repo=0
  commit=abc123def4567890
  for arg in "$@"; do
    target="$arg"
    case "$arg" in
      *rootrepo*) root_repo=1 ;;
      next) commit=def456abc1237890 ;;
    esac
  done
  if [ "$root_repo" = "1" ]; then
    app_root="$target"
    app_id="root-agent"
    app_name="Root Agent"
  else
    app_root="$target/apps/demo"
    app_id="remote-agent"
    app_name="Remote Agent"
  fi
  mkdir -p "$app_root/prompts"
  cat > "$app_root/prompts/system.md" <<'PROMPT'
Remote system prompt
PROMPT
  cat > "$app_root/pi-factory.toml" <<MANIFEST
id = "$app_id"
name = "$app_name"
version = "0.1.0"
schema_version = 1
state_dir = "state"
pi_command = ["true"]
thinking = "medium"
system_prompt = "prompts/system.md"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
reasoning = false

[[build]]
command = ["sh", "-c", "printf built > build.txt"]
platforms = ["linux", "macos"]
MANIFEST
  printf '%s\n' "$commit" > "$target/.fake-commit"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  cat "$2/.fake-commit"
  exit 0
fi
exit 2
`
  );
  await chmod(fakeGit, 0o755);
}

async function createAppBundle(stateDir?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-app-"));
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await writeFile(path.join(root, "prompts", "system.md"), "System prompt\n");
  await writeFile(path.join(root, "prompts", "extension.md"), "Extension prompt\n");
  await writeFile(path.join(root, "extensions", "demo.ts"), "export default {};\n");
  await writeFile(
    path.join(root, "pi-factory.toml"),
    sampleManifest(stateDir ?? path.join(root, "state"))
  );
  return root;
}

function sampleManifest(stateDir: string): string {
  return `id = "demo-agent"
name = "Demo Agent"
version = "0.1.0"
schema_version = 1
state_dir = "${stateDir}"
pi_command = ["true"]
thinking = "medium"
tools = ["read", "bash"]
system_prompt = "prompts/system.md"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
context_window = 4096
max_tokens = 1024
reasoning = false

[[extensions]]
path = "extensions/demo.ts"
append_system_prompt = "prompts/extension.md"
`;
}

function minimalManifest(appId: string, stateDir: string): string {
  return `id = "${appId}"
name = "${appId}"
version = "0.1.0"
schema_version = 1
state_dir = "${stateDir}"

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
reasoning = false
`;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
