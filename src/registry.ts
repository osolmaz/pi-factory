import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { InstalledPiApp, PiAppSourceInfo } from "./types.js";
import { appIndexPath, managedAppsDir, safePathComponent } from "./paths.js";
import { loadPiApp } from "./manifest.js";

export async function loadAppIndex(): Promise<readonly InstalledPiApp[]> {
  const indexPath = appIndexPath();
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("app index must be a JSON array");
    }
    return parsed as readonly InstalledPiApp[];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw new Error(
      `failed to load pi-factory app index ${indexPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function saveAppIndex(apps: readonly InstalledPiApp[]): Promise<void> {
  const indexPath = appIndexPath();
  await mkdir(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(apps, null, 2)}\n`);
  await rename(tmpPath, indexPath);
}

export async function listPiApps(): Promise<readonly InstalledPiApp[]> {
  const apps = await loadAppIndex();
  const refreshed = await Promise.all(apps.map(refreshIndexedApp));
  return refreshed.sort((left, right) => left.appId.localeCompare(right.appId));
}

export async function findInstalledApp(appId: string): Promise<InstalledPiApp | undefined> {
  return (await listPiApps()).find((app) => app.appId === appId && app.enabled);
}

export async function linkPiApp(appDir: string, enabled = true): Promise<InstalledPiApp> {
  const loaded = await loadPiApp({ appDir });
  const app: InstalledPiApp = {
    appId: loaded.manifest.id,
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    enabled,
    source: { kind: "local" },
    installedUnixMs: Date.now()
  };
  await upsertApp(app);
  return app;
}

export async function registerManagedPiApp(
  appDir: string,
  source: PiAppSourceInfo
): Promise<InstalledPiApp> {
  const loaded = await loadPiApp({ appDir });
  const app: InstalledPiApp = {
    appId: loaded.manifest.id,
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    manifestPath: loaded.manifestPath,
    appRoot: loaded.appRoot,
    enabled: true,
    source,
    installedUnixMs: Date.now()
  };
  await upsertApp(app);
  return app;
}

export async function uninstallPiApp(appId: string): Promise<boolean> {
  const apps = await loadAppIndex();
  const existing = apps.find((app) => app.appId === appId);
  if (existing === undefined) {
    return false;
  }
  await saveAppIndex(apps.filter((app) => app.appId !== appId));
  if (existing.source.kind === "github" && existing.source.managedPath !== undefined) {
    await rm(existing.source.managedPath, { recursive: true, force: true });
  }
  return true;
}

export function managedAppPath(appId: string): string {
  return path.join(managedAppsDir(), `${safePathComponent(appId)}-${shortHash(appId)}`);
}

async function upsertApp(app: InstalledPiApp): Promise<void> {
  const apps = await loadAppIndex();
  const existing = apps.find((entry) => entry.appId === app.appId);
  await removeReplacedManagedApp(existing, app);
  await saveAppIndex([...apps.filter((entry) => entry.appId !== app.appId), app]);
}

async function removeReplacedManagedApp(
  existing: InstalledPiApp | undefined,
  replacement: InstalledPiApp
): Promise<void> {
  if (existing?.source.kind !== "github" || existing.source.managedPath === undefined) {
    return;
  }
  if (
    replacement.source.kind === "github" &&
    replacement.source.managedPath === existing.source.managedPath
  ) {
    return;
  }
  await rm(existing.source.managedPath, { recursive: true, force: true });
}

async function refreshIndexedApp(app: InstalledPiApp): Promise<InstalledPiApp> {
  try {
    const loaded = await loadPiApp({ appFile: app.manifestPath });
    return {
      ...app,
      name: loaded.manifest.name,
      version: loaded.manifest.version,
      warnings: []
    };
  } catch (error) {
    return {
      ...app,
      warnings: [`manifest unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
