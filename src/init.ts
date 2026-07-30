import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isValidPiAppId } from "./manifest.js";

export async function initPiApp(appId: string, targetDir = appId): Promise<string> {
  if (!isValidPiAppId(appId)) {
    throw new Error(
      "app id may only contain ASCII letters, digits, dot, colon, underscore, and hyphen"
    );
  }
  const root = path.resolve(targetDir);
  const systemPromptPath = path.join(root, "prompts", "system.md");
  const manifestPath = path.join(root, "pi-factory.toml");
  await assertAbsent(systemPromptPath);
  await assertAbsent(manifestPath);
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await writeFile(systemPromptPath, `You are ${appId}, a Pi app.\n`, { flag: "wx" });
  await writeFile(
    manifestPath,
    `id = ${tomlString(appId)}\n` +
      `name = ${tomlString(appId)}\n` +
      `version = "0.1.0"\n` +
      `schema_version = 1\n` +
      `state_dir = ${tomlString(`~/.local/state/${appId}`)}\n` +
      `pi_command = ["npx", "-y", "@earendil-works/pi-coding-agent@latest"]\n` +
      `thinking = "medium"\n` +
      `tools = ["read", "bash"]\n` +
      `system_prompt = "prompts/system.md"\n\n` +
      `[provider]\n` +
      `id = "local-openai"\n` +
      `base_url = "http://127.0.0.1:1234/v1"\n` +
      `api = "openai-completions"\n\n` +
      `[model]\n` +
      `id = "auto"\n` +
      `reasoning = false\n`,
    { flag: "wx" }
  );
  return root;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function assertAbsent(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    return;
  }
  throw new Error(`${file} already exists`);
}
