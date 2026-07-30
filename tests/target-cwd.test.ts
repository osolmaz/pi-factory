import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "../src/cli/cli.js";
import { createPiLaunchPlan, runPiApp } from "../src/launch.js";
import type { PiAppDefinition } from "../src/types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function app(rootDir: string, stateDir: string): PiAppDefinition {
  return {
    id: "regrafter",
    name: "Regrafter",
    rootDir,
    stateDir,
    sessionDir: path.join(stateDir, "sessions"),
    piCommand: ["true"],
    providers: [
      {
        id: "local-openai",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [{ id: "auto" }]
      }
    ],
    defaultProvider: "local-openai",
    defaultModel: "auto",
    thinking: "medium"
  };
}

describe("target working directories", () => {
  it("keeps the app root separate from a canonical target cwd", async () => {
    const root = await tempDir("pi-factory-app-");
    const targetParent = await tempDir("pi-factory-target-");
    const target = path.join(targetParent, "repo with spaces");
    const alias = path.join(targetParent, "repo-alias");
    await mkdir(target);
    await symlink(target, alias, "dir");

    const plan = await createPiLaunchPlan(app(root, path.join(root, "state")), undefined, {
      cwd: alias,
      mode: "json",
      session: "session-123",
      name: "vendor update",
      messages: ["Update the vendored packages"]
    });

    expect(plan.cwd).toBe(target);
    expect(plan.args.slice(-7)).toEqual([
      "--mode",
      "json",
      "--session",
      "session-123",
      "--name",
      "vendor update",
      "Update the vendored packages"
    ]);
  });

  it("resolves bundle-relative launch commands while running in the target cwd", async () => {
    const root = await tempDir("pi-factory-app-");
    const target = await tempDir("pi-factory-target-");
    const stateDir = path.join(root, "state");
    const output = path.join(root, "launch-cwd.txt");
    const binDir = path.join(root, "bin");
    const executable = path.join(binDir, "pi");
    await mkdir(binDir);
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$PWD" > "$PI_FACTORY_TEST_OUTPUT"\n`);
    await chmod(executable, 0o755);

    const definition = {
      ...app(root, stateDir),
      piCommand: ["sh", "./bin/pi"],
      env: { PI_FACTORY_TEST_OUTPUT: output }
    };
    const plan = await createPiLaunchPlan(definition, undefined, { cwd: target });
    expect(plan.command).toBe("sh");
    expect(plan.args[0]).toBe(executable);
    await expect(runPiApp(definition, { cwd: target })).resolves.toBe(0);
    expect(await readFile(output, "utf8")).toBe(`${target}\n`);

    const scriptsDir = path.join(root, "scripts");
    const nodeScript = path.join(scriptsDir, "launch-pi.mjs");
    await mkdir(scriptsDir);
    await writeFile(nodeScript, "process.exit(0);\n");
    const nodePlan = await createPiLaunchPlan(
      { ...definition, piCommand: ["node", "scripts/launch-pi.mjs"] },
      undefined,
      { cwd: target }
    );
    expect(nodePlan.command).toBe("node");
    expect(nodePlan.args[0]).toBe(nodeScript);

    const dynamicPlan = await createPiLaunchPlan(
      { ...definition, piCommand: ["./$PI_WRAPPER"] },
      undefined,
      { cwd: target }
    );
    expect(dynamicPlan.command).toBe("./$PI_WRAPPER");
  });

  it("rejects initial messages in RPC mode before writing runtime state", async () => {
    const root = await tempDir("pi-factory-app-");
    const stateDir = path.join(root, "state");
    const definition = app(root, stateDir);
    const overrides = { mode: "rpc", messages: ["This would be ignored"] } as const;
    await expect(createPiLaunchPlan(definition, undefined, overrides)).rejects.toThrow(
      "RPC mode accepts messages through stdin"
    );
    await expect(runPiApp(definition, overrides)).rejects.toThrow(
      "RPC mode accepts messages through stdin"
    );
    await expect(
      readFile(path.join(stateDir, "pi-config-runtime", "settings.json"))
    ).rejects.toThrow();
  });

  it("rejects missing and non-directory target paths before launch", async () => {
    const root = await tempDir("pi-factory-app-");
    const stateDir = path.join(root, "state");
    const file = path.join(root, "target.txt");
    await writeFile(file, "not a directory\n");

    await expect(
      runPiApp(app(root, stateDir), { cwd: path.join(root, "missing") })
    ).rejects.toThrow("launch cwd does not exist");
    await expect(runPiApp(app(root, stateDir), { cwd: file })).rejects.toThrow(
      "launch cwd must be a directory"
    );
    await expect(
      readFile(path.join(stateDir, "pi-config-runtime", "settings.json"))
    ).rejects.toThrow();
  });

  it("shows both appRoot and cwd in CLI plans", async () => {
    const root = await tempDir("pi-factory-app-");
    const target = await tempDir("pi-factory-target-");
    await mkdir(path.join(root, "extensions"));
    await writeFile(
      path.join(root, "pi-factory.toml"),
      `id = "regrafter"
name = "Regrafter"
version = "0.1.0"
schema_version = 1
state_dir = "./state"
pi_command = ["true"]
thinking = "medium"
tools = ["read", "bash"]

[provider]
id = "local-openai"
base_url = "http://127.0.0.1:1234/v1"
api = "openai-completions"

[model]
id = "auto"
reasoning = false
`
    );

    const result = await run(["plan", "--app-dir", root, "--cwd", target]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      appRoot: string;
      launch: { cwd?: string };
    };
    expect(output.appRoot).toBe(root);
    expect(output.launch.cwd).toBe(target);
  });
});
