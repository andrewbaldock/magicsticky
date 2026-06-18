// Per-sticky pastel colors. Each sticky gets a stable color by its position in the stack, so a
// note keeps the same color as you navigate. Soft/low-saturation pastels; the first is the
// lightened sticky-yellow (the brand color, a touch lighter + less saturated than before).
// `fill` = the note/tab surface; `edge` = the slightly darker inactive-tab / border shade.
export interface Pastel {
  fill: string;
  edge: string;
}

const PALETTE: Pastel[] = [
  { fill: "#fbe7a0", edge: "#ecd486" }, // yellow (lightened/softened brand)
  { fill: "#cfe8c9", edge: "#b6d6af" }, // green
  { fill: "#c9e2f0", edge: "#aed0e4" }, // blue
  { fill: "#e7d4f0", edge: "#d4bce4" }, // lavender
  { fill: "#f8d6c4", edge: "#eebfa8" }, // peach
  { fill: "#f6cdd6", edge: "#e8b2c0" }, // pink
  { fill: "#cfe9e6", edge: "#b3d8d3" }, // teal
  { fill: "#e3e3c4", edge: "#cfceac" }, // olive
  { fill: "#d9dcef", edge: "#c0c5e2" }, // periwinkle
  { fill: "#f1ddc0", edge: "#e2c8a4" }, // sand
];

export function pastelFor(position: number): Pastel {
  return PALETTE[((position % PALETTE.length) + PALETTE.length) % PALETTE.length];
}
