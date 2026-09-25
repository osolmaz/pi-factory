import type { PiWebTheme, PiWebThemeChoice } from "./types.js";

/** The 14 Catppuccin accent colors, in the palette's order. */
export const catppuccinAccentNames = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender"
] as const;

type AccentName = (typeof catppuccinAccentNames)[number];

type Palette = Readonly<Record<AccentName, string>> & {
  readonly text: string;
  readonly subtext1: string;
  readonly subtext0: string;
  readonly surface2: string;
  readonly surface1: string;
  readonly surface0: string;
  readonly base: string;
  readonly mantle: string;
};

export type CatppuccinFlavor = "latte" | "frappe" | "macchiato" | "mocha";

// Catppuccin palettes, https://catppuccin.com/palette (MIT). Only the colors the page uses.
const palettes: Readonly<Record<CatppuccinFlavor, Palette>> = {
  latte: {
    rosewater: "#dc8a78",
    flamingo: "#dd7878",
    pink: "#ea76cb",
    mauve: "#8839ef",
    red: "#d20f39",
    maroon: "#e64553",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    sapphire: "#209fb5",
    blue: "#1e66f5",
    lavender: "#7287fd",
    text: "#4c4f69",
    subtext1: "#5c5f77",
    subtext0: "#6c6f85",
    surface2: "#acb0be",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    base: "#eff1f5",
    mantle: "#e6e9ef"
  },
  frappe: {
    rosewater: "#f2d5cf",
    flamingo: "#eebebe",
    pink: "#f4b8e4",
    mauve: "#ca9ee6",
    red: "#e78284",
    maroon: "#ea999c",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    sky: "#99d1db",
    sapphire: "#85c1dc",
    blue: "#8caaee",
    lavender: "#babbf1",
    text: "#c6d0f5",
    subtext1: "#b5bfe2",
    subtext0: "#a5adce",
    surface2: "#626880",
    surface1: "#51576d",
    surface0: "#414559",
    base: "#303446",
    mantle: "#292c3c"
  },
  macchiato: {
    rosewater: "#f4dbd6",
    flamingo: "#f0c6c6",
    pink: "#f5bde6",
    mauve: "#c6a0f6",
    red: "#ed8796",
    maroon: "#ee99a0",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    sky: "#91d7e3",
    sapphire: "#7dc4e4",
    blue: "#8aadf4",
    lavender: "#b7bdf8",
    text: "#cad3f5",
    subtext1: "#b8c0e0",
    subtext0: "#a5adcb",
    surface2: "#5b6078",
    surface1: "#494d64",
    surface0: "#363a4f",
    base: "#24273a",
    mantle: "#1e2030"
  },
  mocha: {
    rosewater: "#f5e0dc",
    flamingo: "#f2cdcd",
    pink: "#f5c2e7",
    mauve: "#cba6f7",
    red: "#f38ba8",
    maroon: "#eba0ac",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    sapphire: "#74c7ec",
    blue: "#89b4fa",
    lavender: "#b4befe",
    text: "#cdd6f4",
    subtext1: "#bac2de",
    subtext0: "#a6adc8",
    surface2: "#585b70",
    surface1: "#45475a",
    surface0: "#313244",
    base: "#1e1e2e",
    mantle: "#181825"
  }
};

const flavorLabels: Readonly<Record<CatppuccinFlavor, string>> = {
  latte: "Catppuccin Latte",
  frappe: "Catppuccin Frappé",
  macchiato: "Catppuccin Macchiato",
  mocha: "Catppuccin Mocha"
};

/**
 * Build the page theme from a Catppuccin flavor. The terminal's black and white follow the
 * Catppuccin terminal ports: on the light flavor, black is a text color and white a surface; on
 * the dark flavors, the other way round.
 */
export function catppuccinWebTheme(flavor: CatppuccinFlavor): PiWebTheme {
  const c = palettes[flavor];
  const light = flavor === "latte";
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

/**
 * The four Catppuccin flavors as theme choices, Latte first. `piThemes` names the Pi theme that
 * matches each flavor, when the app loads one; the web runner then switches Pi's theme too.
 */
export function catppuccinThemeChoices(
  piThemes: Partial<Record<CatppuccinFlavor, string>> = {}
): readonly PiWebThemeChoice[] {
  const flavors: readonly CatppuccinFlavor[] = ["latte", "frappe", "macchiato", "mocha"];
  return flavors.map((flavor) => {
    const piTheme = piThemes[flavor];
    const accents = Object.fromEntries(
      catppuccinAccentNames.map((name) => [name, palettes[flavor][name]])
    );
    return {
      id: `catppuccin-${flavor}`,
      label: flavorLabels[flavor],
      theme: catppuccinWebTheme(flavor),
      accents,
      ...(piTheme === undefined ? {} : { piTheme })
    };
  });
}

/** The default terminal font. The package serves Monaspace Argon itself, so no install is needed. */
export const defaultFontFamily = '"Monaspace Argon", ui-monospace, Menlo, Consolas, monospace';
