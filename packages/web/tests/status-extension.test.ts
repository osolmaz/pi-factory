import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { controlUrlEnv, statusExtensionSource, statusUrlEnv } from "../src/status-extension.js";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Load the generated source the way Pi does: transpile the TypeScript, then import it.
async function loadExtension(): Promise<(pi: unknown) => void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-factory-web-extension-"));
  dirs.push(dir);
  const file = path.join(dir, "status.mjs");
  const output = ts.transpileModule(statusExtensionSource(), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  await writeFile(file, output, "utf8");
  const module = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
  return module.default;
}

describe("generated status extension", () => {
  it("reports Pi events as statuses and applies a rename from the control URL", async () => {
    vi.stubEnv(statusUrlEnv, "http://127.0.0.1:1/api/status/k?token=t");
    vi.stubEnv(controlUrlEnv, "http://127.0.0.1:1/api/control/k?token=t");
    const posts: unknown[] = [];
    let controls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (init?.body !== undefined) {
        posts.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      controls += 1;
      return controls === 1
        ? Response.json({ rename: "Renamed" })
        : new Promise<Response>(() => undefined);
    });
    const handlers = new Map<string, Handler>();
    const names: string[] = [];
    const extension = await loadExtension();
    extension({
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      getSessionName: () => "Old",
      setSessionName: (name: string) => names.push(name)
    });

    const ctx = { sessionManager: { getSessionFile: () => "/s/a.jsonl" } };
    const fire = (event: string, payload: Record<string, unknown> = {}): void => {
      const handler = handlers.get(event);
      if (handler === undefined) throw new Error(`no handler for ${event}`);
      handler(payload, ctx);
    };
    for (const event of [
      "session_start",
      "ui_prompt_start",
      "ui_prompt_end",
      "agent_start",
      "ui_prompt_start",
      "ui_prompt_end",
      "agent_settled"
    ]) {
      fire(event);
    }
    fire("session_info_changed", { name: "Renamed" });
    await vi.waitFor(() => {
      expect(names).toEqual(["Renamed"]);
    });
    fire("session_shutdown");

    expect(posts).toEqual([
      { status: "idle", sessionFile: "/s/a.jsonl", name: "Old" },
      { status: "waiting" },
      { status: "idle" },
      { status: "responding" },
      { status: "waiting" },
      { status: "responding" },
      { status: "idle" },
      { name: "Renamed" }
    ]);
  });

  it("does nothing without a status URL", async () => {
    vi.stubEnv(statusUrlEnv, "");
    const on = vi.fn();
    const extension = await loadExtension();
    extension({ on, getSessionName: () => undefined, setSessionName: () => undefined });
    expect(on).not.toHaveBeenCalled();
  });
});
