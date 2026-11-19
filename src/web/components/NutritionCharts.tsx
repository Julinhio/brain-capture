import { useEffect, useRef, useState } from 'react';
import { macroSplit, type Macros } from '../../shared/nutrition';

// Three small charts drawn by hand (SVG): no chart library for three shapes. One measure per
// chart and one axis each. Values and labels stay in the text colours; a coloured mark next to
// them carries identity. The three macro colours were checked together against this surface
// for colour-blind separation and contrast (see docs/nutrition.md).

const HEIGHT = 220;
const PAD = { top: 18, right: 14, bottom: 26, left: 44 };

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round steps for an axis: 4 ticks or so, on 1 / 2 / 2.5 / 5 × 10ⁿ. */
function niceStep(span: number, target = 4): number {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * pow;
}

const shortDay = (day: string, withWeekday = false) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { ...(withWeekday ? { weekday: 'short' as const } : {}), day: 'numeric', month: 'short', timeZone: 'UTC' });
const num = (n: number) => n.toLocaleString('en-GB');

/** Which days get a label under the axis: all of a week, else as many as fit, always the last. */
function labelled(count: number, width: number): Set<number> {
  if (count <= 8) return new Set(Array.from({ length: count }, (_, i) => i));
  const every = Math.ceil(count / Math.max(2, Math.min(6, Math.floor(width / 72))));
  const picks = new Set<number>();
  for (let i = count - 1; i >= 0; i -= every) picks.add(i);
  return picks;
}

function Tip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  // Kept inside the plot: it flips to the left of the pointer in the right half.
  const left = x > width / 2;
  return (
    <div className="chart-tip" role="status" style={left ? { right: width - x + 10 } : { left: x + 10 }}>
      {children}
    </div>
  );
}

export interface CaloriesPoint {
  day: string;
  /** Null: nothing logged that day (no bar, rather than a bar at zero). */
  kcal: number | null;
  burned: number;
}

/** Energy eaten per day against the daily goal. One series, so no legend: the title names it. */
export function CaloriesChart({ points, goal }: { points: CaloriesPoint[]; goal: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const top = Math.max(goal, ...points.map((p) => p.kcal ?? 0), 1);
  const step = niceStep(top * 1.08);
  const max = Math.ceil((top * 1.08) / step) * step;
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const band = points.length ? innerW / points.length : 0;
  const barW = Math.max(2, Math.min(24, band - 2));
  const labels = labelled(points.length, innerW);
  const active = hover !== null ? points[hover] : null;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Calories eaten per day over ${points.length} days, against a goal of ${num(goal)} kcal`}>
          {Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="chart-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {num(tick)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = PAD.left + band * i + band / 2;
            const h = p.kcal ? Math.max(2, innerH - (y(p.kcal) - PAD.top)) : 0;
            const r = Math.min(4, barW / 2, h);
            const x0 = cx - barW / 2;
            const yTop = PAD.top + innerH - h;
            return (
              <g key={p.day}>
                {h > 0 && (
                  // Rounded at the data end only, square on the baseline.
                  <path
                    className="chart-bar"
                    data-active={hover === i || undefined}
                    d={`M${x0},${PAD.top + innerH} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${PAD.top + innerH} Z`}
                  />
                )}
                {labels.has(i) && (
                  <text className="chart-axis" x={cx} y={HEIGHT - 8} textAnchor="middle">
                    {points.length <= 8 ? shortDay(p.day, true).slice(0, 3) : shortDay(p.day)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="chart-goal" x1={PAD.left} x2={width - PAD.right} y1={y(goal)} y2={y(goal)} />
          <text className="chart-goal-label" x={width - PAD.right} y={y(goal) - 6} textAnchor="end">
            Goal {num(goal)}
          </text>
          {/* Hit areas: the whole column, far larger than the bar. */}
          {points.map((p, i) => (
            <rect
              key={p.day}
              x={PAD.left + band * i}
              y={PAD.top}
              width={band}
              height={innerH + PAD.bottom}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
              onPointerDown={() => setHover(i)}
              onPointerLeave={() => setHover((h) => (h === i ? null : h))}
            />
          ))}
        </svg>
      )}
      {active && hover !== null && (
        <Tip x={PAD.left + band * hover + band / 2} width={width}>
          <strong>{shortDay(active.day, true)}</strong>
          {active.kcal === null ? (
            <span>Nothing logged</span>
          ) : (
            <>
              <span>{num(active.kcal)} kcal eaten</span>
              {active.burned > 0 && <span>{num(active.burned)} kcal burned</span>}
              <span>{balanceText(goal - active.kcal + active.burned)}</span>
            </>
          )}
        </Tip>
      )}
    </div>
  );
}

export function balanceText(remaining: number): string {
  return remaining >= 0 ? `${num(remaining)} kcal under the goal` : `${num(-remaining)} kcal over the goal`;
}

export interface WeightPoint {
  day: string;
  kg: number;
}

/** The weight curve over the period. A line, so the axis frames the values instead of starting at zero. */
export function WeightChart({ points, from, to }: { points: WeightPoint[]; from: string; to: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = Date.parse(`${from}T12:00:00Z`);
  const span = Math.max(1, Date.parse(`${to}T12:00:00Z`) - t0);
  const kgs = points.map((p) => p.kg);
  const low = Math.min(...kgs);
  const high = Math.max(...kgs);
  const step = niceStep(Math.max(high - low, 2), 3);
  const min = Math.floor((low - step * 0.25) / step) * step;
  const max = Math.ceil((high + step * 0.25) / step) * step;
  const x = (day: string) => PAD.left + ((Date.parse(`${day}T12:00:00Z`) - t0) / span) * innerW;
  const y = (kg: number) => PAD.top + innerH - ((kg - min) / (max - min)) * innerH;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step);
  const active = hover !== null ? points[hover] : null;
  const last = points[points.length - 1];
  // The line reaches the last point from above or from below: its label goes on the other side.
  const before = points[points.length - 2];
  const labelBelow = Boolean(last && before && before.kg > last.kg);

  function nearest(clientX: number, target: SVGElement) {
    const px = clientX - target.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.day) - px) < Math.abs(x(points[best]!.day) - px)) best = i;
    });
    setHover(best);
  }

  return (
    <div className="chart" ref={ref}>
      {width > 0 && last && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Weight over the period, from ${points[0]!.kg} kg to ${last.kg} kg`}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="chart-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {Number.isInteger(tick) ? tick : tick.toFixed(1)}
              </text>
            </g>
          ))}
          {[from, to].map((day, i) => (
            <text key={day} className="chart-axis" x={i === 0 ? PAD.left : width - PAD.right} y={HEIGHT - 8} textAnchor={i === 0 ? 'start' : 'end'}>
              {shortDay(day)}
            </text>
          ))}
          {active && <line className="chart-cross" x1={x(active.day)} x2={x(active.day)} y1={PAD.top} y2={PAD.top + innerH} />}
          <polyline className="chart-line" points={points.map((p) => `${x(p.day)},${y(p.kg)}`).join(' ')} />
          {points.map((p, i) => (
            <circle key={p.day} className="chart-dot" data-active={hover === i || undefined} cx={x(p.day)} cy={y(p.kg)} r={hover === i ? 5 : 4} />
          ))}
          {/* Only the latest value is written on the chart; the others are a hover away. */}
          <text className="chart-value" x={Math.min(x(last.day), width - PAD.right) - 8} y={y(last.kg) + (labelBelow ? 18 : -10)} textAnchor="end">
            {last.kg} kg
          </text>
          <rect
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH + PAD.bottom}
            fill="transparent"
            onPointerMove={(e) => nearest(e.clientX, e.currentTarget.ownerSVGElement!)}
            onPointerDown={(e) => nearest(e.clientX, e.currentTarget.ownerSVGElement!)}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {active && (
        <Tip x={x(active.day)} width={width}>
          <strong>{shortDay(active.day, true)}</strong>
          <span>{active.kg} kg</span>
          {hover! > 0 && <span>{signed(active.kg - points[0]!.kg)} kg since {shortDay(points[0]!.day)}</span>}
        </Tip>
      )}
    </div>
  );
}

export const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 10) / 10)}`;

const MACROS = [
  { key: 'protein', label: 'Protein' },
  { key: 'carbs', label: 'Carbs' },
  { key: 'fat', label: 'Fat' },
] as const;

/**
 * Where the energy comes from: one bar split in three, each part named and given in grams and
 * in percent right under it, so nothing rests on colour alone.
 */
export function MacroBar({ macros, perDay = false }: { macros: Macros; perDay?: boolean }) {
  const split = macroSplit(macros);
  const empty = split.protein + split.carbs + split.fat === 0;
  return (
    <div className="macro-bar-wrap">
      <div className="macro-bar" role="img" aria-label={empty ? 'No macros yet' : `Protein ${split.protein}%, carbs ${split.carbs}%, fat ${split.fat}% of the energy`}>
        {!empty && MACROS.map((m) => split[m.key] > 0 && <span key={m.key} data-macro={m.key} style={{ flexGrow: split[m.key] }} />)}
      </div>
      <dl className="macro-legend">
        {MACROS.map((m) => (
          <div key={m.key}>
            <dt>
              <i className="macro-dot" data-macro={m.key} aria-hidden="true" /> {m.label}
            </dt>
            <dd>
              {Math.round(macros[m.key])} g{perDay ? ' / day' : ''} <span>{empty ? '' : `${split[m.key]}%`}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
