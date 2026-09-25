import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PiWebSettings, PiWebThemeChoice } from "./types.js";

export const minFontSize = 10;
export const maxFontSize = 24;
export const defaultFontSize = 14;

/** Checks a settings change against the offered themes and accents, and fills the rest. */
export function mergeSettings(
  current: PiWebSettings,
  change: unknown,
  themes: readonly PiWebThemeChoice[]
): PiWebSettings {
  if (typeof change !== "object" || change === null || Array.isArray(change)) {
    throw new Error("settings must be a JSON object");
  }
  const input = change as Record<string, unknown>;
  const theme = input["theme"] === undefined ? current.theme : themeId(input["theme"], themes);
  const choice = themes.find((entry) => entry.id === theme);
  const fontSize = input["fontSize"] === undefined ? current.fontSize : size(input["fontSize"]);
  return { theme, accent: mergedAccent(current, input, choice), fontSize };
}

// An accent that the chosen theme does not offer falls back to the theme's own accent.
function mergedAccent(
  current: PiWebSettings,
  input: Record<string, unknown>,
  choice: PiWebThemeChoice | undefined
): string | undefined {
  const accent = "accent" in input ? accentName(input["accent"], choice) : current.accent;
  return accent !== undefined && choice?.accents[accent] !== undefined ? accent : undefined;
}

function themeId(value: unknown, themes: readonly PiWebThemeChoice[]): string {
  if (typeof value !== "string" || !themes.some((entry) => entry.id === value)) {
    throw new Error(`unknown theme ${JSON.stringify(value)}`);
  }
  return value;
}

function accentName(value: unknown, choice: PiWebThemeChoice | undefined): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || choice?.accents[value] === undefined) {
    throw new Error(`unknown accent ${JSON.stringify(value)}`);
  }
  return value;
}

function size(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minFontSize ||
    value > maxFontSize
  ) {
    throw new Error(
      `font size must be an integer from ${String(minFontSize)} to ${String(maxFontSize)}`
    );
  }
  return value;
}

/** Read saved settings. A missing or broken file, or an outdated value, gives the defaults. */
export async function loadSettings(
  path: string,
  defaults: PiWebSettings,
  themes: readonly PiWebThemeChoice[]
): Promise<PiWebSettings> {
  try {
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    return mergeSettings(defaults, saved, themes);
  } catch {
    return defaults;
  }
}

export async function saveSettings(path: string, settings: PiWebSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
