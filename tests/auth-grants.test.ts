import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getPiAuthGrant, grantPiAuth, loadPiAuthGrants, revokePiAuth } from "../src/auth-grants.js";
import { authGrantPreview, run } from "../src/cli/cli.js";
import { createPiCommandPlan, createPiLaunchPlan } from "../src/launch.js";
import type { PiAppDefinition } from "../src/types.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function environment(): Promise<{ root: string; agentDir: string; authFile: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-factory-auth-grant-"));
  cleanup.push(root);
  const agentDir = path.join(root, "pi-agent");
  const authFile = path.join(agentDir, "auth.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(authFile, "{}\n", { mode: 0o600 });
  vi.stubEnv("PI_FACTORY_STATE_DIR", path.join(root, "factory-state"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  return { root, agentDir, authFile };
}

function app(root: string): PiAppDefinition {
  return {
    id: "pi-reviewer",
    name: "Pi Reviewer",
    rootDir: root,
    stateDir: path.join(root, "app-state"),
    sessionDir: path.join(root, "app-state", "sessions"),
    piCommand: ["pi"],
    providers: [
      { id: "openai-codex", source: "pi", models: [{ id: "review-model", reasoning: true }] }
    ],
    defaultProvider: "openai-codex",
    defaultModel: "review-model",
    thinking: "high"
  };
}

describe("Pi auth grants", () => {
  it("stores only the canonical auth path and resolves it by app id", async () => {
    const { authFile } = await environment();
    await grantPiAuth("pi-reviewer", authFile);

    await expect(loadPiAuthGrants()).resolves.toEqual({
      "pi-reviewer": { source: "pi", authFile }
    });
    await expect(getPiAuthGrant("pi-reviewer")).resolves.toEqual({
      source: "pi",
      authFile
    });

    const stateFile = path.join(process.env["PI_FACTORY_STATE_DIR"] ?? "", "auth-grants.json");
    const stored = await readFile(stateFile, "utf8");
    expect(stored).not.toContain("credential");
    if (process.platform !== "win32") expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
  });

  it("adds the saved auth file to app and command launch plans", async () => {
    const { root, authFile } = await environment();
    await grantPiAuth("pi-reviewer", authFile);

    const application = app(root);
    const plan = await createPiLaunchPlan(application);
    expect(plan.args.slice(0, 2)).toEqual(["--auth-file", authFile]);
    expect(plan.env["PI_CODING_AGENT_DIR"]).toContain("app-state");
    const command = await createPiCommandPlan(application, ["--list-models"]);
    expect(command.args).toEqual(["--auth-file", authFile, "--list-models"]);
  });

  it("supports grant status and revocation through persistent CLI configuration", async () => {
    const { authFile } = await environment();
    const granted = await run(["auth", "grant", "pi-reviewer", "--source", "pi", "--yes"]);
    expect(granted.code).toBe(0);
    expect(granted.stdout).toContain(authFile);

    const status = await run(["auth", "status", "pi-reviewer"]);
    expect(status.stdout).toContain(authFile);
    const revoked = await run(["auth", "revoke", "pi-reviewer"]);
    expect(revoked.stdout).toContain('"revoked": true');
    await expect(getPiAuthGrant("pi-reviewer")).resolves.toBeUndefined();
    await expect(revokePiAuth("pi-reviewer")).resolves.toBe(false);
  });

  it("fails closed for missing, unreadable, and malformed auth state", async () => {
    const { root, authFile } = await environment();
    await rm(authFile);
    await expect(grantPiAuth("pi-reviewer", authFile)).rejects.toThrow("does not exist");

    await writeFile(authFile, "{}\n", { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(authFile, 0o000);
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        await expect(grantPiAuth("pi-reviewer", authFile)).rejects.toThrow("readable and writable");
      }
      await chmod(authFile, 0o600);
    }

    const stateDir = path.join(root, "factory-state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "auth-grants.json"),
      '{"version":1,"grants":{},"credentials":"secret"}\n'
    );
    await expect(loadPiAuthGrants()).rejects.toThrow("unknown auth grant state field");
  });

  it("does not confuse prototype properties with saved grants", async () => {
    await environment();
    for (const appId of ["constructor", "toString", "__proto__"]) {
      await expect(getPiAuthGrant(appId)).resolves.toBeUndefined();
      await expect(revokePiAuth(appId)).resolves.toBe(false);
    }
  });

  it("discloses that shared login state can be modified", () => {
    const preview = authGrantPreview("pi-reviewer", "/home/user/.pi/agent/auth.json");
    expect(preview).toContain("login and logout");
    expect(preview).toContain("modify regular Pi authentication");
  });

  it("rejects invalid app ids before confirmation", async () => {
    await environment();
    const result = await run(["auth", "grant", "bad\u001bapp", "--source", "pi"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("invalid Pi app id");
    expect(result.stderr).not.toContain("requires --yes");
  });

  it("requires explicit confirmation outside an interactive terminal", async () => {
    await environment();
    const result = await run(["auth", "grant", "pi-reviewer", "--source", "pi"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires --yes");
  });
});
