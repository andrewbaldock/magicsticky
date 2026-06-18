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
}

interface PastelPair {
  light: Pastel;
  dark: Pastel;
}

const DARK_INK = "#2a2a26";
const LIGHT_INK = "#f3efe6";

// 10 hues. Light = the existing pastels; dark = a deep muted version of the same hue + light ink.
const PALETTE: PastelPair[] = [
  { light: { fill: "#fbe7a0", edge: "#ecd486", ink: DARK_INK }, dark: { fill: "#5a4a1e", edge: "#6e5c2a", ink: LIGHT_INK } }, // yellow
  { light: { fill: "#cfe8c9", edge: "#b6d6af", ink: DARK_INK }, dark: { fill: "#2f4a2c", edge: "#3b5b38", ink: LIGHT_INK } }, // green
  { light: { fill: "#c9e2f0", edge: "#aed0e4", ink: DARK_INK }, dark: { fill: "#27414f", edge: "#33515f", ink: LIGHT_INK } }, // blue
  { light: { fill: "#e7d4f0", edge: "#d4bce4", ink: DARK_INK }, dark: { fill: "#43314f", edge: "#523e5f", ink: LIGHT_INK } }, // lavender
  { light: { fill: "#f8d6c4", edge: "#eebfa8", ink: DARK_INK }, dark: { fill: "#553227", edge: "#674033", ink: LIGHT_INK } }, // peach
  { light: { fill: "#f6cdd6", edge: "#e8b2c0", ink: DARK_INK }, dark: { fill: "#532836", edge: "#653444", ink: LIGHT_INK } }, // pink
  { light: { fill: "#cfe9e6", edge: "#b3d8d3", ink: DARK_INK }, dark: { fill: "#274a47", edge: "#335b57", ink: LIGHT_INK } }, // teal
  { light: { fill: "#e3e3c4", edge: "#cfceac", ink: DARK_INK }, dark: { fill: "#46462c", edge: "#565638", ink: LIGHT_INK } }, // olive
  { light: { fill: "#d9dcef", edge: "#c0c5e2", ink: DARK_INK }, dark: { fill: "#323651", edge: "#3e4360", ink: LIGHT_INK } }, // periwinkle
  { light: { fill: "#f1ddc0", edge: "#e2c8a4", ink: DARK_INK }, dark: { fill: "#4f3d24", edge: "#604c30", ink: LIGHT_INK } }, // sand
];

export function pastelFor(position: number, theme: "light" | "dark"): Pastel {
  const pair = PALETTE[((position % PALETTE.length) + PALETTE.length) % PALETTE.length];
  return theme === "dark" ? pair.dark : pair.light;
}
