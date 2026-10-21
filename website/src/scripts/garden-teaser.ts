/**
 * The home page's garden tile: a way into atpotato's community garden (/garden/atpota.to).
 * The whole tile is the link. It shows the open patch as it is right now, every plot of it
 * in miniature, and once /api/garden answers, each flower people planted grows into its
 * plot, one after another in no set order, as it looks today (sprout, bud or bloom), then
 * sways a little in its own time. Over it go the patch's name and how many plots are planted.
 *
 * Until the garden answers the tile shows the empty plots, so nothing jumps. When it doesn't
 * load, a few flowers in bloom (six kinds, looks picked fresh each visit) stand in. Without
 * JavaScript the tile is still its words and its link. The patch is decoration (aria-hidden).
 */

import { fetchGarden, flowerVariant, GARDEN_SIZE, SEED, type Flower, type GardenView } from './garden-api';
import { drawFlower, drawSeed, KINDS, stageFor, variantFor, type FlowerKind } from './flowers';

export const COPY = {
  count: (n: number, plots: number) => (n === 0 ? `${plots} empty plots. be the first!` : `${n} of ${plots} plots planted`),
};

/** How long the flowers take to come up, all told, however many there are (ms). */
export const GROW_SPAN_MS = 1800;

const doc = (el: Element): Document => el.ownerDocument;

/** Shuffles a copy of `items` (Fisher–Yates). */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The patch's empty plots, `cols` across. */
export function drawPlots(patch: HTMLElement, cols: number, rows: number): HTMLElement[] {
  patch.style.setProperty('--teaser-cols', String(cols));
  const plots = Array.from({ length: cols * rows }, (_, i) => {
    const plot = doc(patch).createElement('span');
    plot.className = 'home-garden__plot';
    plot.dataset.plot = String(i);
    return plot;
  });
  patch.replaceChildren(...plots);
  return plots;
}

/**
 * Puts each drawing in its plot, coming up in a shuffled order spread over GROW_SPAN_MS
 * (a little sooner or later each, and each swaying at its own pace afterwards).
 */
function plant(plots: HTMLElement[], drawings: { plot: number; svg: SVGSVGElement }[], random: () => number): void {
  const order = shuffled(drawings, random);
  const step = order.length > 1 ? Math.min(140, GROW_SPAN_MS / order.length) : 0;
  order.forEach(({ plot, svg }, i) => {
    const cell = plots[plot];
    if (!cell) return;
    const sway = doc(cell).createElement('span');
    sway.className = 'home-garden__sway';
    sway.style.setProperty('--grow-delay', `${Math.round(i * step + random() * 120)}ms`);
    sway.style.setProperty('--grow-tilt', `${Math.round(random() * 24 - 12)}deg`);
    sway.style.setProperty('--sway-time', `${(3.2 + random() * 2.4).toFixed(2)}s`);
    sway.style.setProperty('--sway-delay', `${(-random() * 4).toFixed(2)}s`);
    sway.append(svg);
    cell.classList.add('home-garden__plot--planted');
    cell.replaceChildren(sway);
  });
}

/** A planted flower as it is now: a seed as far as anyone can tell, or its kind with its look. */
function drawPlanted(d: Document, f: Flower, now: number, open: boolean): SVGSVGElement {
  const stage = stageFor(f.plantedAt, now, open);
  const v = flowerVariant(f);
  return f.kind === SEED ? drawSeed(d, stage, v, f.family) : drawFlower(d, f.kind, stage, v);
}

/** The live patch: its plots, and everyone's flowers growing into theirs. */
export function renderPatch(patchEl: HTMLElement, view: GardenView, now: number = Date.now(), random: () => number = Math.random): void {
  const patch = view.patch;
  if (!patch) return;
  const plots = drawPlots(patchEl, patch.cols, patch.rows);
  const d = doc(patchEl);
  plant(
    plots,
    view.flowers.map((f) => ({ plot: f.plot, svg: drawPlanted(d, f, now, patch.open) })),
    random,
  );
}

/** Six plants of six different kinds in bloom, scattered over the plots, for when the garden doesn't load. */
export function drawStandIns(patchEl: HTMLElement, random: () => number = Math.random): void {
  const plots = [...patchEl.querySelectorAll<HTMLElement>('.home-garden__plot')];
  if (plots.length < 6) return;
  const left = [...KINDS];
  const kinds: FlowerKind[] = [];
  while (kinds.length < 6) kinds.push(left.splice(Math.floor(random() * left.length), 1)[0]!);
  const spots = shuffled(
    plots.map((_, i) => i),
    random,
  ).slice(0, 6);
  plant(
    plots,
    kinds.map((kind, i) => ({ plot: spots[i]!, svg: drawFlower(doc(patchEl), kind, 'bloom', variantFor(kind, Math.floor(random() * 2 ** 32), 1)) })),
    random,
  );
}

export function renderCount(tile: HTMLElement, view: GardenView): void {
  const patch = view.patch;
  if (!patch) return;
  const season = tile.querySelector<HTMLElement>('[data-teaser-season]');
  const count = tile.querySelector<HTMLElement>('[data-teaser-count]');
  if (season) season.textContent = patch.name;
  if (count) count.textContent = COPY.count(view.flowers.length, patch.cols * patch.rows);
  tile.dataset.state = 'ready';
}

/** The flowers wait to come up until the tile is on screen (the module loads a little before). */
function growWhenSeen(tile: HTMLElement): void {
  const win = doc(tile).defaultView;
  if (!win || !('IntersectionObserver' in win)) {
    tile.dataset.seen = 'true';
    return;
  }
  const observer = new win.IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      tile.dataset.seen = 'true';
    },
    { threshold: 0.25 },
  );
  observer.observe(tile);
}

export async function initGardenTeaser(tile: HTMLElement, fetchImpl: typeof fetch = fetch, random: () => number = Math.random, now: () => number = Date.now): Promise<void> {
  if (tile.dataset.teaserBound === 'true') return;
  tile.dataset.teaserBound = 'true';
  const patchEl = tile.querySelector<HTMLElement>('[data-teaser-patch]');
  if (patchEl) drawPlots(patchEl, GARDEN_SIZE.cols, GARDEN_SIZE.rows);
  growWhenSeen(tile);
  const view = await fetchGarden(fetchImpl);
  if (view?.patch) {
    if (patchEl) renderPatch(patchEl, view, now(), random);
    renderCount(tile, view);
  } else {
    if (patchEl) drawStandIns(patchEl, random);
    tile.dataset.state = 'error';
  }
}
