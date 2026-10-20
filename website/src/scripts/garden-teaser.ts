/**
 * The home page's garden tile: a way into atpotato's community garden (/garden/atpota.to),
 * not the garden itself. The whole tile is the link. It shows a row of flowers, one of
 * each kind in bloom with a look picked fresh each visit, and once /api/garden answers,
 * the open patch's name and how many of its plots are planted.
 *
 * Without JavaScript, or when the garden doesn't load, the tile is still its words and its
 * link. The row is decoration (aria-hidden).
 */

import { fetchGarden, type GardenView } from './garden-api';
import { drawFlower, FLOWER_KINDS, variantFor } from './flowers';

export const COPY = {
  count: (n: number, plots: number) => (n === 0 ? `${plots} empty plots. be the first!` : `${n} of ${plots} plots planted`),
};

/** Six flowers, one of each kind, in bloom and as well tended as they come. */
export function drawRow(row: HTMLElement, random: () => number = Math.random): void {
  const doc = row.ownerDocument;
  row.replaceChildren(
    ...FLOWER_KINDS.map((kind) => {
      const mound = doc.createElement('span');
      mound.className = 'home-garden__mound';
      mound.append(drawFlower(doc, kind, 'bloom', variantFor(kind, Math.floor(random() * 2 ** 32), 1)));
      return mound;
    }),
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

export async function initGardenTeaser(tile: HTMLElement, fetchImpl: typeof fetch = fetch, random: () => number = Math.random): Promise<void> {
  if (tile.dataset.teaserBound === 'true') return;
  tile.dataset.teaserBound = 'true';
  const row = tile.querySelector<HTMLElement>('[data-teaser-row]');
  if (row) drawRow(row, random);
  const view = await fetchGarden(fetchImpl);
  if (view?.patch) renderCount(tile, view);
  else tile.dataset.state = 'error';
}
