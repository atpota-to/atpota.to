/**
 * A small line chart for the weather report's trends (weather-page.ts): one series, one
 * axis, drawn as SVG at the host's own width. A smooth 2px line over a 10% wash, three
 * hairline gridlines from zero, and a gap wherever the station missed a step (it doesn't
 * join across missing time, which would read as a quiet stretch).
 *
 * The curve is monotone (smoothPath): it bends between points but never overshoots
 * them, so a smooth line never shows a peak or a dip that isn't in the data.
 *
 * The newest step is often still filling up (today, this hour), which would draw as a dip
 * that isn't there. projectLast turns it into an estimate for the whole step, drawn as a
 * dashed line to a hollow dot; the tooltip has what's in so far and the estimate.
 *
 * Hover, touch or the arrow keys move a crosshair to the nearest point and show its value
 * and time, read out politely for the arrow keys, so no value needs a mouse to reach.
 * Labels only reach the DOM through textContent.
 */

export interface ChartPoint {
  /** Milliseconds. */
  t: number;
  /** null for a step with no data. */
  v: number | null;
  /** A step still filling up: what's in so far, with `v` the estimate for the whole step (projectLast). */
  soFar?: number;
}

export interface ChartOptions {
  /** What the line is, for the accessible name ("new records a second"). */
  label: string;
  /** A CSS colour for the line, usually a var(). */
  color: string;
  format: (v: number) => string;
  /** For the axis labels; default `format`. */
  formatTick?: (v: number) => string;
  formatTime: (t: number) => string;
  /** For the tooltip and readout; default `formatTime`. */
  formatTipTime?: (t: number) => string;
  /** The time between points; a bigger gap breaks the line. */
  stepMs: number;
  /** false fits the axis to the line instead of starting at zero, for a share that moves by hundredths. */
  fromZero?: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 180;
const PAD = { top: 12, right: 10, bottom: 24, left: 46 };

/** A round number at or above `max` (1, 2, 2.5 or 5 times a power of ten). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * The axis's bottom and top: from zero to a round number, or (not fromZero) a round
 * range just around the values, three gridlines a round step apart.
 */
export function axisRange(values: number[], fromZero = true): [number, number] {
  const hi = Math.max(0, ...values);
  if (fromZero || values.length === 0) return [0, niceMax(hi)];
  const lo = Math.min(...values);
  let step = niceMax((hi - lo) / 2 || Math.abs(hi) * 0.01 || 1);
  for (;;) {
    const round = (v: number) => Number(v.toPrecision(12)); // 1.45, not 1.4500000000000002
    const bottom = round(Math.max(0, Math.floor(lo / step) * step));
    if (bottom + 2 * step >= hi) return [bottom, round(bottom + 2 * step)];
    step = niceMax(step * 1.000001);
  }
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * A smooth SVG path through points in x order: a monotone cubic (Steffen's method, as in
 * d3's curveMonotoneX), so between two points the curve stays between their values.
 */
export function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  const n = pts.length;
  if (n === 0) return '';
  const [x0, y0] = pts[0]!;
  if (n === 1) return `M${f(x0)},${f(y0)}`;
  if (n === 2) return `M${f(x0)},${f(y0)}L${f(pts[1]![0])},${f(pts[1]![1])}`;
  const slope = (i: number) => {
    const h = pts[i + 1]![0] - pts[i]![0];
    return h ? (pts[i + 1]![1] - pts[i]![1]) / h : 0;
  };
  // the tangent at each inner point, never steeper than either side allows
  const t: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i]![0] - pts[i - 1]![0];
    const h1 = pts[i + 1]![0] - pts[i]![0];
    const s0 = slope(i - 1);
    const s1 = slope(i);
    const p = h0 + h1 ? (s0 * h1 + s1 * h0) / (h0 + h1) : 0;
    t[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  // the ends lean the way their first and last stretches go
  t[0] = (3 * slope(0) - t[1]!) / 2;
  t[n - 1] = (3 * slope(n - 2) - t[n - 2]!) / 2;
  let d = `M${f(x0)},${f(y0)}`;
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[i + 1]!;
    const third = (bx - ax) / 3;
    d += `C${f(ax + third)},${f(ay + t[i]! * third)},${f(bx - third)},${f(by - t[i + 1]! * third)},${f(bx)},${f(by)}`;
  }
  return d;
}

/** Too little of a step heard to say where it's going: under this share, no estimate. */
export const MIN_PROJECT = 0.1;

/**
 * The last point, when its step (starting at its `t`) is still under way at `now`, as an
 * estimate for the whole step: what's in so far, scaled by how much of the step was heard
 * (`heardMs`, the station's own seconds, since a cached history is a little behind the
 * clock; or the time gone since the step began). A count that adds up (records) scales
 * straight; one that doesn't (active accounts, who come back through the day) grows as
 * the share heard to the power `exponent` (accountsExponent). `scale: false` keeps the
 * value as it is and only marks it as so far (a share, or the apps heard, which mostly
 * turn up early on). Too early in a step to guess (MIN_PROJECT), the point has no value,
 * only what's in so far.
 */
export function projectLast(points: ChartPoint[], now: number, stepMs: number, opts: { scale?: boolean; heardMs?: number; exponent?: number } = {}): ChartPoint[] {
  const last = points[points.length - 1];
  if (!last || last.v === null || now < last.t || now - last.t >= stepMs) return points;
  const gone = Math.min(1, (opts.heardMs ?? now - last.t) / stepMs);
  const v = opts.scale === false ? last.v : gone >= MIN_PROJECT ? last.v / gone ** (opts.exponent ?? 1) : null;
  return [...points.slice(0, -1), { t: last.t, v, soFar: last.v }];
}

/** Runs of consecutive points with data, split wherever a step is missing. */
export function segments(points: ChartPoint[], stepMs: number): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  let last: number | null = null;
  for (const p of points) {
    if (p.v === null || (last !== null && p.t - last > stepMs * 1.5)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (p.v !== null) run.push(p);
    last = p.t;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** A step still filling up, in the tooltip: "1,234 so far", and "on pace for about 5,678" when there's an estimate. */
export function soFarWords(p: ChartPoint, format: (v: number) => string): { value: string; pace: string } {
  return { value: `${format(p.soFar!)} so far`, pace: p.v === null || p.v === p.soFar ? '' : `on pace for about ${format(p.v)}` };
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

interface Drawn {
  points: ChartPoint[];
  opts: ChartOptions;
}

const drawn = new WeakMap<HTMLElement, Drawn>();
const observed = new WeakSet<HTMLElement>();

export function renderChart(host: HTMLElement, points: ChartPoint[], opts: ChartOptions): void {
  drawn.set(host, { points, opts });
  draw(host);
  if (!observed.has(host) && typeof ResizeObserver === 'function') {
    observed.add(host);
    let width = host.clientWidth;
    new ResizeObserver(() => {
      if (host.clientWidth === width) return;
      width = host.clientWidth;
      draw(host);
    }).observe(host);
  }
}

function draw(host: HTMLElement): void {
  const state = drawn.get(host);
  if (!state) return;
  const { points, opts } = state;
  const width = Math.max(240, host.clientWidth || 600);
  const known = points.filter((p): p is ChartPoint & { v: number } => p.v !== null);
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0;
  const [yMin, yMax] = axisRange(known.map((p) => p.v), opts.fromZero ?? true);
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const svg = el('svg', { class: 'weather-chart__svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, tabindex: 0, role: 'img' });
  svg.setAttribute('aria-label', `${opts.label}: a chart. use the arrow keys to read each point.`);
  svg.style.setProperty('--chart-color', opts.color);

  // gridlines and their labels: the bottom (usually zero), half way, the top
  for (const v of [yMin, (yMin + yMax) / 2, yMax]) {
    svg.append(el('line', { class: 'weather-chart__grid', x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v) }));
    const label = el('text', { class: 'weather-chart__tick', x: PAD.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = (opts.formatTick ?? opts.format)(v);
    svg.append(label);
  }
  // time labels: the start, the middle and the end of the axis
  const times = t1 === t0 ? [t0] : [t0, (t0 + t1) / 2, t1];
  times.forEach((t, i) => {
    const anchor = times.length === 1 ? 'middle' : i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle';
    const label = el('text', { class: 'weather-chart__tick', x: x(t), y: HEIGHT - 6, 'text-anchor': anchor });
    label.textContent = opts.formatTime(t);
    svg.append(label);
  });

  for (const all of segments(points, opts.stepMs)) {
    // a step still filling up: a dashed line out to its estimate, a hollow dot at the end
    const end = all[all.length - 1]!;
    const run = end.soFar === undefined ? all : all.slice(0, -1);
    if (run !== all) {
      const from = run[run.length - 1];
      if (from) svg.append(el('path', { class: 'weather-chart__line weather-chart__line--projected', d: `M${x(from.t).toFixed(1)},${y(from.v!).toFixed(1)}L${x(end.t).toFixed(1)},${y(end.v!).toFixed(1)}` }));
      svg.append(el('circle', { class: 'weather-chart__dot weather-chart__dot--projected', cx: x(end.t), cy: y(end.v!), r: 4 }));
    }
    if (!run.length) continue;
    const line = smoothPath(run.map((p) => [x(p.t), y(p.v!)] as const));
    if (run.length === 1) {
      svg.append(el('circle', { class: 'weather-chart__dot', cx: x(run[0]!.t), cy: y(run[0]!.v!), r: 4 }));
      continue;
    }
    const area = `${line}L${x(run[run.length - 1]!.t).toFixed(1)},${y(yMin)}L${x(run[0]!.t).toFixed(1)},${y(yMin)}Z`;
    svg.append(el('path', { class: 'weather-chart__area', d: area }), el('path', { class: 'weather-chart__line', d: line }));
  }

  const cross = el('line', { class: 'weather-chart__cross', x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + innerH, visibility: 'hidden' });
  const mark = el('circle', { class: 'weather-chart__dot weather-chart__mark', cx: 0, cy: 0, r: 5, visibility: 'hidden' });
  const hit = el('rect', { class: 'weather-chart__hit', x: PAD.left, y: 0, width: innerW, height: HEIGHT });
  svg.append(cross, mark, hit);

  const tip = document.createElement('div');
  tip.className = 'weather-chart__tip';
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  const tipValue = document.createElement('strong');
  const tipTime = document.createElement('span');
  const tipPace = document.createElement('span');
  tipPace.hidden = true;
  tip.append(tipValue, tipTime, tipPace);

  const live = document.createElement('p');
  live.className = 'visually-hidden';
  live.setAttribute('aria-live', 'polite');

  let at = -1;
  const show = (i: number, announce: boolean) => {
    const p = points[i];
    if (!p) return;
    at = i;
    const px = x(p.t);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    cross.setAttribute('visibility', 'visible');
    const words = p.soFar !== undefined ? soFarWords(p, opts.format) : { value: p.v === null ? 'no reading' : opts.format(p.v), pace: '' };
    const value = words.value;
    if (p.v === null) mark.setAttribute('visibility', 'hidden');
    else {
      mark.setAttribute('cx', String(px));
      mark.setAttribute('cy', String(y(p.v)));
      mark.setAttribute('visibility', 'visible');
    }
    tipValue.textContent = value;
    tipTime.textContent = (opts.formatTipTime ?? opts.formatTime)(p.t);
    tipPace.textContent = words.pace;
    tipPace.hidden = !words.pace;
    tip.hidden = false;
    // centred on the point, but never past either edge
    const half = (tip.offsetWidth || 140) / 2;
    tip.style.left = `${Math.min(Math.max(px, half), width - half)}px`;
    if (announce) live.textContent = `${(opts.formatTipTime ?? opts.formatTime)(p.t)}: ${value}${words.pace ? `, ${words.pace}` : ''}`;
  };
  const hide = () => {
    at = -1;
    cross.setAttribute('visibility', 'hidden');
    mark.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const nearest = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / (box.width || width)) * width;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.t) - px) < Math.abs(x(points[best]!.t) - px)) best = i;
    });
    return best;
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e.clientX), false));
  hit.addEventListener('pointerdown', (e) => show(nearest(e.clientX), false));
  hit.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(at >= 0 ? at : points.length - 1, true));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: points.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(Math.max(0, Math.min(points.length - 1, next)), true);
  });

  // A redraw (a resize, say) keeps the reader's place when the chart had focus.
  const hadFocus = host.contains(document.activeElement);
  host.replaceChildren(svg, tip, live);
  if (hadFocus) svg.focus();
}
