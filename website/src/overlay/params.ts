/**
 * The overlay's address: whose overlay it is, and any settings that override the ones saved
 * in their repo (config.ts). Usually it's just
 *
 *   /overlay?streamer=dame.is
 *
 * and everything else comes from the streamer's to.atpota.poe.overlay record. Each of these
 * overrides one setting, for this browser source only:
 *
 *   w=card:tl:100,apps:tr:80   the weather widgets: kind, slot (tl tc tr bl bc br) and size
 *                              in percent; w=none for none. Kinds: card, strip, badge,
 *                              apps, forecast, pulse, and Anisota's moon, mark
 *                              and loader (anisota.ts)
 *   poe=left:120               Poe's bottom corner and size; poe=off hides it
 *   chat=off follows=off alerts=off visitors=off
 *   ignore=a.bsky.social,did:plc:...
 *   sound=off   volume=0-100   nap=10 | nap=off   theme=dark
 *   demo                       Poe runs through example lines, for placing things
 *
 * Older addresses still work: show=poe,weather,strip and side=left.
 */

import { actorOf, clampScale, cleanWidgets, DEFAULT_CONFIG, MAX_IGNORED, SLOTS, WIDGET_HOME, type ConfigOverrides, type OverlayConfig, type Slot, type Widget } from './config';

export { actorOf } from './config';

export interface OverlayParams {
  /** A handle or a DID, unchecked beyond its shape: resolved later (index.ts). */
  streamer: string | null;
  demo: boolean;
  overrides: ConfigOverrides;
}

const SLOT_CODES: Record<string, Slot> = { tl: 'top-left', tc: 'top-center', tr: 'top-right', bl: 'bottom-left', bc: 'bottom-center', br: 'bottom-right' };
const CODE_OF = Object.fromEntries(Object.entries(SLOT_CODES).map(([code, slot]) => [slot, code])) as Record<Slot, string>;

const off = (v: string | null) => v !== null && /^(off|no|false|0)$/i.test(v.trim());
const on = (v: string | null) => v !== null && /^(on|yes|true|1)$/i.test(v.trim());

function numberIn(v: string | null, min: number, max: number): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : undefined;
}

/** "card:tl:100,apps:tr:80" as widgets. */
export function readWidgets(raw: string): Widget[] {
  if (/^\s*none\s*$/i.test(raw)) return [];
  return cleanWidgets(
    raw
      .split(',')
      .map((part) => part.trim().toLowerCase().split(':'))
      .map(([kind, slot, scale]) => ({ kind, slot: SLOT_CODES[slot ?? ''] ?? (SLOTS as readonly string[]).find((s) => s === slot), scale: scale ? Number(scale) : 100 })),
  );
}

export function writeWidgets(widgets: Widget[]): string {
  return widgets.length ? widgets.map((w) => `${w.kind}:${CODE_OF[w.slot]}:${w.scale}`).join(',') : 'none';
}

export function readParams(search: string): OverlayParams {
  const q = new URLSearchParams(search);
  const o: ConfigOverrides = {};
  const poe: Partial<OverlayConfig['poe']> = {};

  // the older address: show=poe,weather,strip and side=left
  const show = q.get('show');
  if (show !== null) {
    const asked = show.toLowerCase().split(/[,\s]+/);
    if (asked.some((s) => ['poe', 'weather', 'strip'].includes(s))) {
      poe.show = asked.includes('poe');
      o.widgets = [];
      if (asked.includes('weather')) o.widgets.push({ kind: 'card', slot: WIDGET_HOME.card, scale: 100 });
      if (asked.includes('strip')) o.widgets.push({ kind: 'strip', slot: WIDGET_HOME.strip, scale: 100 });
    }
  }
  const side = q.get('side')?.toLowerCase();
  if (side === 'left' || side === 'right') poe.side = side;

  const w = q.get('w');
  if (w !== null) o.widgets = readWidgets(w);
  const p = q.get('poe');
  if (p !== null) {
    if (off(p)) poe.show = false;
    else {
      const [where, size] = p.toLowerCase().split(':');
      poe.show = true;
      if (where === 'left' || where === 'right') poe.side = where;
      if (size) poe.scale = clampScale(Number(size));
    }
  }
  if (Object.keys(poe).length) o.poe = poe;

  for (const key of ['chat', 'follows', 'alerts', 'visitors'] as const) {
    const v = q.get(key);
    if (off(v)) o[key] = false;
    else if (on(v)) o[key] = true;
  }
  const ignore = q.get('ignore');
  if (ignore !== null) o.ignore = [...new Set(ignore.split(/[,\s]+/).map(actorOf).filter((a): a is string => a !== null))].slice(0, MAX_IGNORED);
  if (off(q.get('sound'))) o.volume = 0;
  else {
    const volume = numberIn(q.get('volume'), 0, 100);
    if (volume !== undefined) o.volume = volume;
  }
  if (off(q.get('nap'))) o.nap = 0;
  else {
    const nap = numberIn(q.get('nap'), 1, 240);
    if (nap !== undefined) o.nap = nap;
  }
  const theme = q.get('theme')?.toLowerCase();
  if (theme === 'dark' || theme === 'light') o.theme = theme;

  return { streamer: actorOf(q.get('streamer') ?? ''), demo: q.has('demo') && !off(q.get('demo')), overrides: o };
}

/** A whole config as an address, leaving out what's at its default (the setup page's preview). */
export function toSearch(c: OverlayConfig, extra: { streamer?: string | null; demo?: boolean } = {}): string {
  const d = DEFAULT_CONFIG;
  const q = new URLSearchParams();
  if (extra.streamer) q.set('streamer', extra.streamer);
  const widgets = writeWidgets(c.widgets);
  if (widgets !== writeWidgets(d.widgets)) q.set('w', widgets);
  if (!c.poe.show) q.set('poe', 'off');
  else if (c.poe.side !== d.poe.side || c.poe.scale !== d.poe.scale) q.set('poe', `${c.poe.side}:${c.poe.scale}`);
  for (const key of ['chat', 'follows', 'alerts', 'visitors'] as const) if (!c[key]) q.set(key, 'off');
  if (c.ignore.length) q.set('ignore', c.ignore.join(','));
  if (c.volume <= 0) q.set('sound', 'off');
  else if (c.volume !== d.volume) q.set('volume', String(c.volume));
  if (c.nap <= 0) q.set('nap', 'off');
  else if (c.nap !== d.nap) q.set('nap', String(c.nap));
  if (c.theme !== d.theme) q.set('theme', c.theme);
  if (extra.demo) q.set('demo', '');
  const s = q.toString().replace(/demo=(&|$)/, 'demo$1').replace(/%2C/g, ',').replace(/%3A/g, ':');
  return s ? `?${s}` : '';
}
