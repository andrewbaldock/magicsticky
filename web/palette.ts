// Per-sticky colors. Each sticky has a stable color by its stack position, so a note keeps its
// identity as you navigate. Two themes:
//   light (default) — light pastel fill, dark ink (the look Andrew likes; desk/chrome stays dark)
//   dark            — a DEEP/MUTED version of the SAME hue, light ink (the sticky inverts; desk
//                     stays dark either way)
// `fill`/`edge` are the surface + the darker inactive-tab shade; `ink` is the text color.
export interface Pastel {
  fill: string;
  edge: string;
  ink: string;
  inkMuted: string; // secondary ink (counter, done-task, blockquote) — themed so it stays legible
}

interface PastelPair {
  light: Pastel;
  dark: Pastel;
}

const DARK_INK = "#2a2a26";
const LIGHT_INK = "#f3efe6";
const LIGHT_MUTED = "#6b6657"; // dark warm gray — ~4.65:1 on the light pastels (moby-measured)
const DARK_MUTED = "rgba(243,239,230,0.72)"; // translucent light ink — legible on the deep pastels

// fill+edge per theme; ink/inkMuted are constant per theme (dark↔light), so derive them.
function light(fill: string, edge: string): Pastel {
  return { fill, edge, ink: DARK_INK, inkMuted: LIGHT_MUTED };
}
function dark(fill: string, edge: string): Pastel {
  return { fill, edge, ink: LIGHT_INK, inkMuted: DARK_MUTED };
}

// 10 hues. Light = the existing pastels; dark = a deep version of the same hue + light ink.
const PALETTE: PastelPair[] = [
  { light: light("#fbe7a0", "#ecd486"), dark: dark("#5a4a1e", "#6e5c2a") }, // yellow
  { light: light("#cfe8c9", "#b6d6af"), dark: dark("#2f4a2c", "#3b5b38") }, // green
  { light: light("#c9e2f0", "#aed0e4"), dark: dark("#27414f", "#33515f") }, // blue
  { light: light("#e7d4f0", "#d4bce4"), dark: dark("#43314f", "#523e5f") }, // lavender
  { light: light("#f8d6c4", "#eebfa8"), dark: dark("#553227", "#674033") }, // peach
  { light: light("#f6cdd6", "#e8b2c0"), dark: dark("#532836", "#653444") }, // pink
  { light: light("#cfe9e6", "#b3d8d3"), dark: dark("#274a47", "#335b57") }, // teal
  { light: light("#e3e3c4", "#cfceac"), dark: dark("#46462c", "#565638") }, // olive
  { light: light("#d9dcef", "#c0c5e2"), dark: dark("#323651", "#3e4360") }, // periwinkle
  { light: light("#f1ddc0", "#e2c8a4"), dark: dark("#4f3d24", "#604c30") }, // sand
];

export function pastelFor(position: number, theme: "light" | "dark"): Pastel {
  const pair = PALETTE[((position % PALETTE.length) + PALETTE.length) % PALETTE.length];
  return theme === "dark" ? pair.dark : pair.light;
}
