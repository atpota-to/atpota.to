/**
 * What a garden's card and its page's tags say, in the page's own words
 * (src/scripts/garden-page.ts COPY), and where each flower is at now. Kept apart from the
 * card's drawing (server/og-garden.ts) so the garden page's function (server/garden-page.ts)
 * doesn't load the renderer.
 */

import type { Family, SpeciesId } from '../shared/garden-rules.js';
import { SEED } from '../shared/garden-rules.js';
import { stageFor, type Stage } from '../src/scripts/flowers.js';
import { ATPOTATO_DID } from './blog/config.js';
import type { Garden } from './garden.js';

export interface Plant {
  did: string;
  rkey: string;
  kind: SpeciesId | typeof SEED;
  family: Family | null;
  care: number;
  grew: { wind: number; mix: number; apps: string[] } | null;
}

/**
 * What a garden card says, in the page's own words (src/scripts/garden-page.ts COPY). The
 * lede is the page's description; the card itself only carries the owner's own note, since
 * a link preview prints the description under it anyway. Someone's garden has no chip: the
 * card names its owner beside their avatar instead.
 */
export function gardenWords(g: Garden): { chip: string | null; title: string; lede: string; note: string | null } {
  const who = g.owner.displayName || `@${g.owner.handle}`;
  if (g.owner.did === ATPOTATO_DID) {
    return {
      chip: 'gardens',
      title: 'the community garden',
      lede: "everyone's patch on atpota.to, a fresh one each season. plant one flower, look after it for its first week, and watch it bloom.",
      note: g.patch?.note || null,
    };
  }
  return {
    chip: null,
    title: g.patch?.name || `${who}'s garden`,
    lede: g.patch?.note || (g.patch ? `@${g.owner.handle}'s garden on atpota.to. plant a flower in it, look after it for its first week, and watch it bloom.` : `@${g.owner.handle} hasn't set up a garden yet.`),
    note: g.patch?.note || null,
  };
}

export interface Placed {
  plots: Map<number, { plant: Plant; stage: Stage }>;
  growing: number;
  blooming: number;
}

/** Each flower in its plot at its stage now. */
export function placeFlowers(g: Garden, now: number): Placed {
  const plots = new Map<number, { plant: Plant; stage: Stage }>();
  let blooming = 0;
  const open = g.patch?.open ?? true;
  for (const fl of g.flowers) {
    const stage = stageFor(fl.plantedAt, now, open);
    if (stage === 'bloom') blooming++;
    plots.set(fl.plot, { plant: { did: fl.did, rkey: fl.rkey, kind: fl.kind, family: fl.family, care: fl.care, grew: fl.weather?.grew ?? null }, stage });
  }
  return { plots, growing: g.flowers.length - blooming, blooming };
}

export function statsText(g: Garden, placed: Placed): string {
  const n = g.flowers.length;
  if (!g.patch) return 'no garden yet';
  if (!n) return 'no flowers yet. plant the first one!';
  const flowers = `${n} ${n === 1 ? 'flower' : 'flowers'}`;
  return placed.blooming ? `${flowers} · ${placed.blooming} in bloom` : `${flowers}, all still growing`;
}

/** How a garden's address names its owner: the handle, or the DID when the handle is broken (garden.ts actorOf). */
export function addressOf(owner: { did: string; handle: string }): string {
  return owner.handle && owner.handle !== 'handle.invalid' ? owner.handle : owner.did;
}
