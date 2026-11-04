/** Math helpers ported from monaco/dashboards/risk-leaderboard-tile.js. Keep in sync. */

export type MaybeNum = number | null | undefined;

export const nonNull = (a: MaybeNum[]): number[] =>
  a.filter((v): v is number => v !== null && v !== undefined && !Number.isNaN(v));

export const sum = (a: MaybeNum[]): number => nonNull(a).reduce((s, v) => s + v, 0);

export const avg = (a: MaybeNum[]): number | null => {
  const n = nonNull(a);
  return n.length ? sum(n) / n.length : null;
};

export const median = (a: MaybeNum[]): number | null => {
  const s = nonNull(a).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const round = (v: MaybeNum, d = 1): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

export interface Trend {
  /** % change across the window implied by the fitted slope */
  pct: number | null;
  /** t-statistic of the slope, clamped to ±99 */
  t: number | null;
}

/** Ordinary least squares on (index, value); returns % change across the window and t-statistic. */
export function trend(values: MaybeNum[]): Trend {
  const pts = values
    .map((v, i): [number, MaybeNum] => [i, v])
    .filter((p): p is [number, number] => p[1] !== null && p[1] !== undefined);
  if (pts.length < 4) return { pct: null, t: null };
  const n = pts.length;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const b = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
  const sse = pts.reduce((s, [x, y]) => s + (y - (my + b * (x - mx))) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const span = pts[n - 1][0] - pts[0][0];
  const t = se > 1e-12 ? b / se : Math.sign(b) * 99;
  return { pct: my ? ((b * span) / my) * 100 : null, t: Math.max(-99, Math.min(99, t)) };
}

/** Min–max normalizes map values to [0, 1]; all zeros when the range is empty. */
export function minMax(map: Map<string, number>): Map<string, number> {
  const vals = [...map.values()];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return new Map([...map].map(([k, v]) => [k, hi > lo ? (v - lo) / (hi - lo) : 0]));
}
