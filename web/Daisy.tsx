// Magic Sticky's brand mark — a daisy, inline SVG. Eight rounded petals around a warm gold center.
// `color` tints the center + petal edges; `petalColor` fills the petals. Decorative (aria-hidden).
export function Daisy({
  size = 18,
  color = "#f4b942",
  petalColor = "#fff7e6",
  className,
}: {
  size?: number;
  color?: string;
  petalColor?: string;
  className?: string;
}) {
  const petals = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true">
      <g transform="translate(50,50)">
        {petals.map((deg) => (
          <path
            key={deg}
            transform={`rotate(${deg})`}
            d="M0,-8 C9,-14 11,-30 0,-42 C-11,-30 -9,-14 0,-8 Z"
            fill={petalColor}
            stroke={color}
            strokeWidth="2"
            strokeOpacity="0.55"
          />
        ))}
        <circle r="13" fill={color} />
        <circle r="13" fill="none" stroke={color} strokeOpacity="0.5" strokeWidth="2" />
      </g>
    </svg>
  );
}
