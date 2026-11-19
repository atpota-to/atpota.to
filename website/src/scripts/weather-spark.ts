/**
 * The sparkline under the reading, on the weather report's header (weather-page.ts) and
 * the home page's weather tile (weather.ts): new records a second over the weather
 * station's 60 seconds. A sampled reading has no such window, so the line hides for it.
 * components.css draws it (.weather-spark), in the colour of the text around it.
 */

import { motionOK, ROLL_EASE, ROLL_MS } from './roll';
import { smoothPath } from './weather-chart';
import type { Reading } from './weather';

/** Draws the reading's 60 seconds into `host`, or hides it when the reading has none to draw. */
export function renderSpark(host: HTMLElement, r: Reading): void {
  const series = r.series ?? [];
  const records = series.map((p) => p?.creates ?? null);
  host.hidden = r.source !== 'station' || records.filter((p) => p !== null).length < 2;
  // the second the window ends on, so the next one knows how far to scroll
  const last = series.findLastIndex((p) => p !== null);
  if (!host.hidden) renderSparkline(host, records, last >= 0 ? series[last]!.t + (series.length - 1 - last) : undefined);
}

/**
 * A bare line of the last 60 seconds: decorative (aria-hidden), the reading says it in
 * words. It spans its own lowest to highest second, so a minute that only wobbles around
 * 450 still shows its shape. `end` is the second the window ends on: when the next
 * reading ends a few seconds later, the line scrolls left by that much instead of being
 * redrawn in place, the old line fading as it goes. `projected` says the last value is an
 * estimate for a bucket still filling up (weather-chart.ts projectLast): the line goes out
 * to it dashed.
 */
export function renderSparkline(host: HTMLElement, values: Array<number | null>, end?: number, projected = false): void {
  const w = 240;
  const h = 36;
  const heard = values.filter((v): v is number => v !== null);
  const max = Math.max(...heard);
  const min = Math.min(...heard);
  const span = max - min;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  // one smooth run per stretch of seconds the station heard
  const runs: Array<Array<[number, number]>> = [[]];
  values.forEach((v, i) => {
    if (v === null) runs.push([]);
    else runs[runs.length - 1]!.push([i * step, span > 0 ? h - 3 - ((v - min) / span) * (h - 6) : h / 2]);
  });
  const tail = projected && values[values.length - 1] !== null ? runs[runs.length - 1]!.splice(-1) : [];
  const d = runs.filter((r) => r.length).map(smoothPath).join('');
  let svg = host.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('focusable', 'false');
    host.replaceChildren(svg);
  }
  svg.querySelector('.weather-spark__projected')?.remove();
  const before = svg.querySelector('path:not(.is-leaving)');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  const from = runs[runs.length - 1]?.at(-1);
  if (tail[0] && from) {
    const dash = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    dash.setAttribute('class', 'weather-spark__projected');
    dash.setAttribute('d', `M${from[0].toFixed(1)},${from[1].toFixed(1)}L${tail[0][0].toFixed(1)},${tail[0][1].toFixed(1)}`);
    dash.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(dash);
  }
  const shift = end !== undefined && host.dataset.end ? end - Number(host.dataset.end) : 0;
  if (end !== undefined) host.dataset.end = String(end);
  if (!before) return;
  if (!(shift > 0 && shift < values.length) || !motionOK() || typeof path.animate !== 'function') {
    before.remove();
    return;
  }
  const dx = shift * step;
  before.classList.add('is-leaving');
  path.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: ROLL_MS, easing: ROLL_EASE });
  before
    .animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${-dx}px)`, opacity: 0 }], { duration: ROLL_MS, easing: ROLL_EASE, fill: 'forwards' })
    .finished.then(
      () => before.remove(),
      () => before.remove(),
    );
}
