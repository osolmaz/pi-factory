import os from "node:os";
import path from "node:path";

export function stateDir(): string {
  return expandPath(process.env["PI_FACTORY_STATE_DIR"] ?? "~/.local/state/pi-factory");
}

export function appIndexPath(): string {
  return path.join(stateDir(), "apps.json");
}

export function managedAppsDir(): string {
  return path.join(stateDir(), "apps");
}

export function expandPath(value: string, baseDir?: string): string {
  const expandedHome = value === "~" ? os.homedir() : value.replace(/^~(?=\/|$)/u, os.homedir());
  const expandedEnv = expandedHome.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}/gu,
    (match, bare: string | undefined, braced: string | undefined) => {
      const key = bare ?? braced;
      return key === undefined ? match : (process.env[key] ?? "");
    }
  );
  return path.resolve(baseDir ?? process.cwd(), expandedEnv);
}

export function optionalExpandPath(
  value: string | undefined,
  baseDir?: string
): string | undefined {
  return value === undefined ? undefined : expandPath(value, baseDir);
}

export function currentPlatform(): "linux" | "macos" | "windows" {
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "win32") {
    return "windows";
  }
  return "linux";
}

export function safePathComponent(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return slug === "" ? "app" : slug.slice(0, 80);
}
