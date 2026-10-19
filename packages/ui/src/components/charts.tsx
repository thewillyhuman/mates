/**
 * Hand-written SVG charts (decision 0016): stacked bars and a histogram.
 * Two-colour scales, labels, hover titles; no runtime dependency.
 */
export interface Series {
  name: string;
  color: string;
  values: number[];
}

const BLUES = ['#2457d6', '#7ea0ea', '#b9cbf4', '#1a3f9c'];
const GREENS = ['#1f7a3e', '#7fc29a', '#c3e3cf'];
export const PALETTE = { blues: BLUES, greens: GREENS };

export function StackedBars({
  labels,
  series,
  format,
  height = 220,
}: {
  labels: string[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
}) {
  const w = 720;
  const padL = 56;
  const padB = 28;
  const padT = 12;
  const innerW = w - padL - 8;
  const innerH = height - padB - padT;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const barW = labels.length ? innerW / labels.length : innerW;
  // Ticks at 0, ½ and max, without duplicates once formatted (small integer scales).
  const ticks = [0, 0.5, 1]
    .map((f) => f * max)
    .filter((t, i, arr) => arr.findIndex((x) => format(x) === format(t)) === i);
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${w} ${height}`}
      role="img"
      aria-label="chart"
      preserveAspectRatio="none"
    >
      {ticks.map((t) => {
        const y = padT + innerH - (t / max) * innerH;
        return (
          <g key={t}>
            <line x1={padL} x2={w - 8} y1={y} y2={y} stroke="#e2e5ea" />
            <text x={padL - 6} y={y + 4} fontSize="11" textAnchor="end" fill="#8a919b">
              {format(t)}
            </text>
          </g>
        );
      })}
      {labels.map((label, i) => {
        let y = padT + innerH;
        return (
          <g key={label}>
            {series.map((s) => {
              const v = s.values[i] ?? 0;
              const h = (v / max) * innerH;
              y -= h;
              return (
                <rect
                  key={s.name}
                  x={padL + i * barW + barW * 0.15}
                  y={y}
                  width={barW * 0.7}
                  height={h}
                  fill={s.color}
                >
                  <title>{`${label} · ${s.name}: ${format(v)}`}</title>
                </rect>
              );
            })}
            {(labels.length <= 16 || i % Math.ceil(labels.length / 16) === 0) && (
              <text
                x={padL + i * barW + barW / 2}
                y={height - 8}
                fontSize="11"
                textAnchor="middle"
                fill="#8a919b"
              >
                {label.slice(-5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function Histogram({
  buckets,
  color,
  height = 220,
}: {
  buckets: { label: string; count: number }[];
  color: string;
  height?: number;
}) {
  return (
    <StackedBars
      labels={buckets.map((b) => b.label)}
      series={[{ name: 'runs', color, values: buckets.map((b) => b.count) }]}
      format={(v) => String(Math.round(v))}
      height={height}
    />
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.name}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
