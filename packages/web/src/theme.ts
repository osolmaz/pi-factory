import type { PiWebTheme } from "./types.js";

type Palette = {
  readonly rosewater: string;
  readonly pink: string;
  readonly mauve: string;
  readonly red: string;
  readonly yellow: string;
  readonly green: string;
  readonly teal: string;
  readonly blue: string;
  readonly text: string;
  readonly subtext1: string;
  readonly subtext0: string;
  readonly surface2: string;
  readonly surface1: string;
  readonly surface0: string;
  readonly base: string;
  readonly mantle: string;
};

// Catppuccin palettes, https://catppuccin.com/palette (MIT). Only the colors the page uses.
const latte: Palette = {
  rosewater: "#dc8a78",
  pink: "#ea76cb",
  mauve: "#8839ef",
  red: "#d20f39",
  yellow: "#df8e1d",
  green: "#40a02b",
  teal: "#179299",
  blue: "#1e66f5",
  text: "#4c4f69",
  subtext1: "#5c5f77",
  subtext0: "#6c6f85",
  surface2: "#acb0be",
  surface1: "#bcc0cc",
  surface0: "#ccd0da",
  base: "#eff1f5",
  mantle: "#e6e9ef"
};

const frappe: Palette = {
  rosewater: "#f2d5cf",
  pink: "#f4b8e4",
  mauve: "#ca9ee6",
  red: "#e78284",
  yellow: "#e5c890",
  green: "#a6d189",
  teal: "#81c8be",
  blue: "#8caaee",
  text: "#c6d0f5",
  subtext1: "#b5bfe2",
  subtext0: "#a5adce",
  surface2: "#626880",
  surface1: "#51576d",
  surface0: "#414559",
  base: "#303446",
  mantle: "#292c3c"
};

const macchiato: Palette = {
  rosewater: "#f4dbd6",
  pink: "#f5bde6",
  mauve: "#c6a0f6",
  red: "#ed8796",
  yellow: "#eed49f",
  green: "#a6da95",
  teal: "#8bd5ca",
  blue: "#8aadf4",
  text: "#cad3f5",
  subtext1: "#b8c0e0",
  subtext0: "#a5adcb",
  surface2: "#5b6078",
  surface1: "#494d64",
  surface0: "#363a4f",
  base: "#24273a",
  mantle: "#1e2030"
};

const mocha: Palette = {
  rosewater: "#f5e0dc",
  pink: "#f5c2e7",
  mauve: "#cba6f7",
  red: "#f38ba8",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  teal: "#94e2d5",
  blue: "#89b4fa",
  text: "#cdd6f4",
  subtext1: "#bac2de",
  subtext0: "#a6adc8",
  surface2: "#585b70",
  surface1: "#45475a",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825"
};

/**
 * Build the page theme from a Catppuccin palette. The terminal's black and white follow the
 * Catppuccin terminal ports: on the light flavor, black is a text color and white a surface; on
 * the dark flavors, the other way round.
 */
export function catppuccinWebTheme(palette: Palette, light: boolean): PiWebTheme {
  const c = palette;
  return {
    background: c.base,
    foreground: c.text,
    sidebarBackground: c.mantle,
    sidebarForeground: c.text,
    mutedForeground: c.subtext0,
    accent: c.mauve,
    selectedBackground: c.surface0,
    border: c.surface1,
    cursor: c.rosewater,
    selectionBackground: c.surface2,
    black: light ? c.subtext1 : c.surface1,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.pink,
    cyan: c.teal,
    white: light ? c.surface2 : c.subtext1,
    brightBlack: light ? c.subtext0 : c.surface2,
    brightRed: c.red,
    brightGreen: c.green,
    brightYellow: c.yellow,
    brightBlue: c.blue,
    brightMagenta: c.pink,
    brightCyan: c.teal,
    brightWhite: light ? c.surface1 : c.subtext0
  };
}

/** Catppuccin Latte, the default light theme. */
export const catppuccinLatte: PiWebTheme = catppuccinWebTheme(latte, true);
export const catppuccinFrappe: PiWebTheme = catppuccinWebTheme(frappe, false);
export const catppuccinMacchiato: PiWebTheme = catppuccinWebTheme(macchiato, false);
export const catppuccinMocha: PiWebTheme = catppuccinWebTheme(mocha, false);

/** The default terminal font. The package serves Monaspace Argon itself, so no install is needed. */
export const defaultFontFamily = '"Monaspace Argon", ui-monospace, Menlo, Consolas, monospace';
