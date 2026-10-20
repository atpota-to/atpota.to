/**
 * A small line chart for the weather report's trends (weather-page.ts): one series, one
 * axis, drawn as SVG at the host's own width. A smooth 2px line over a 10% wash, three
 * hairline gridlines from zero, and a gap wherever the station missed a step (it doesn't
 * join across missing time, which would read as a quiet stretch).
 *
 * The curve is monotone (smoothPath): it bends between points but never overshoots
 * them, so a smooth line never shows a peak or a dip that isn't in the data.
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
  const yMax = niceMax(Math.max(0, ...known.map((p) => p.v)));
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

  const svg = el('svg', { class: 'weather-chart__svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, tabindex: 0, role: 'img' });
  svg.setAttribute('aria-label', `${opts.label}: a chart. use the arrow keys to read each point.`);
  svg.style.setProperty('--chart-color', opts.color);

  // gridlines and their labels: zero, half, the top
  for (const v of [0, yMax / 2, yMax]) {
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

  for (const run of segments(points, opts.stepMs)) {
    const line = smoothPath(run.map((p) => [x(p.t), y(p.v!)] as const));
    if (run.length === 1) {
      svg.append(el('circle', { class: 'weather-chart__dot', cx: x(run[0]!.t), cy: y(run[0]!.v!), r: 4 }));
      continue;
    }
    const area = `${line}L${x(run[run.length - 1]!.t).toFixed(1)},${y(0)}L${x(run[0]!.t).toFixed(1)},${y(0)}Z`;
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
  tip.append(tipValue, tipTime);

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
    const value = p.v === null ? 'no reading' : opts.format(p.v);
    if (p.v === null) mark.setAttribute('visibility', 'hidden');
    else {
      mark.setAttribute('cx', String(px));
      mark.setAttribute('cy', String(y(p.v)));
      mark.setAttribute('visibility', 'visible');
    }
    tipValue.textContent = value;
    tipTime.textContent = (opts.formatTipTime ?? opts.formatTime)(p.t);
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(px, 70), width - 70)}px`;
    if (announce) live.textContent = `${(opts.formatTipTime ?? opts.formatTime)(p.t)}: ${value}`;
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
