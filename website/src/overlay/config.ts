/**
 * How a streamer's overlay is set up: which weather widgets show, in which slot and how
 * big, which bottom corner Poe sits in and how big, and what Poe reacts to. The same shape
 * three ways:
 *
 *   the record   to.atpota.poe.overlay in the streamer's repo
 *                (lexicons/to/atpota/poe/overlay.json), saved by /overlay/setup and read
 *                by the overlay, which follows it live (store.ts). A streamer can keep
 *                several, each a layout with a name: "self" is the main one, which
 *                /overlay?streamer= shows; &layout=<id> picks another
 *   the URL      settings in /overlay's address (params.ts) override the record, field by
 *                field; the setup page's preview passes the whole draft that way
 *   defaults     DEFAULT_CONFIG, for a streamer with no record and no settings in the URL
 *
 * fromRecord() keeps what checks out of a record (someone may have written it by hand) and
 * fills the rest from the defaults, so the overlay never trusts a field it hasn't checked.
 */

export const OVERLAY_NSID = 'to.atpota.poe.overlay';
/** The main layout's record key, and its id in the studio. */
export const OVERLAY_RKEY = 'self';
export const MAIN_LAYOUT_NAME = 'main layout';
export const LAYOUT_NAME_MAX = 40;
export const MAX_LAYOUTS = 24;
/** A layout's id: its record key and its name in the URL ("self", "coding"). */
const LAYOUT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function isLayoutId(v: unknown): v is string {
  return typeof v === 'string' && LAYOUT_ID_RE.test(v);
}

/** A new layout's id from its name ("Just Chatting" is "just-chatting"), not one of `taken` nor the main one's. */
export function newLayoutId(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken, OVERLAY_RKEY]);
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'layout';
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

/** A layout's name from its record: one line, at most LAYOUT_NAME_MAX characters. */
export function layoutNameOf(value: unknown, id: string): string {
  const raw = obj(value) && typeof value.name === 'string' ? value.name : '';
  const name = [...raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, LAYOUT_NAME_MAX).join('');
  return name || (id === OVERLAY_RKEY ? MAIN_LAYOUT_NAME : id);
}

export const WIDGET_KINDS = ['card', 'strip', 'badge', 'apps', 'forecast', 'pulse', 'moon', 'mark', 'loader', 'tid', 'flushes', 'status', 'music', 'chat'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];
export const SLOTS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export type Slot = (typeof SLOTS)[number];
export type Side = 'left' | 'right';

/**
 * The setup page's groups of widgets: atpotato's weather, Anisota's (anisota.ts), the TID
 * clock (tid.ts), the streamer's own records from around the atmosphere (flushes.ts,
 * status.ts, music.ts), and their stream chat on screen (onscreen.ts).
 */
export const WIDGET_GROUPS: Record<'weather' | 'anisota' | 'clock' | 'records' | 'chat', readonly WidgetKind[]> = {
  weather: ['card', 'strip', 'badge', 'apps', 'forecast', 'pulse'],
  anisota: ['moon', 'mark', 'loader'],
  clock: ['tid'],
  records: ['flushes', 'status', 'music'],
  chat: ['chat'],
};

/**
 * The ways a widget can look, for the kinds that have more than one: each id with its
 * name on the setup page, the first the default. The overlay sets data-style on the widget.
 */
export const WIDGET_STYLES: Partial<Record<WidgetKind, Readonly<Record<string, string>>>> = {
  tid: { ticking: 'ticking', decoded: 'with the time it means', mini: 'a little pill' },
  flushes: { count: 'the count', stats: 'the stats', latest: 'the latest flush' },
  status: { both: 'status and vitals', status: 'just the status', vitals: 'just the vitals' },
  music: { now: 'now playing', history: 'the last few plays', stats: 'listening stats', mini: 'one line' },
  chat: { corner: 'a little corner chat', side: 'a strip down the side', pop: 'messages that pop up and fade' },
};

/** A widget's style, when its kind has styles: `style` if it's one of them, else the default. */
export function styleFor(kind: WidgetKind, style: unknown): string | undefined {
  const styles = WIDGET_STYLES[kind];
  if (!styles) return undefined;
  return typeof style === 'string' && Object.hasOwn(styles, style) ? style : Object.keys(styles)[0];
}

/** What each widget is, for the setup page. */
export const WIDGET_NAMES: Record<WidgetKind, string> = {
  card: 'the weather card',
  strip: 'the weather strip',
  badge: 'a little badge',
  apps: 'busiest apps',
  forecast: 'the forecast',
  pulse: 'the pulse',
  moon: "anisota's moon",
  mark: 'the anisota mark',
  loader: 'the anisota loader',
  tid: 'the TID clock',
  flushes: 'your flushes',
  status: 'your status',
  music: 'your music',
  chat: 'stream chat',
};
export const WIDGET_HINTS: Record<WidgetKind, string> = {
  card: 'records a second, the sky, bluesky numbers and the diversity index',
  strip: 'all of it in one slim bar, along the top or bottom',
  badge: 'just the sun, records a second and the sky in words',
  apps: 'the five busiest apps outside bluesky, with bars',
  forecast: 'the next six hours of the atmosphere',
  pulse: 'the last minute of the firehose as a big line',
  moon: "tonight's moon as anisota draws it, with its phase",
  mark: "anisota's brand mark, its moon at tonight's phase",
  loader: "anisota's brand mark, its moon running through its phases",
  tid: 'the time right now as an atproto record key, ticking, as anisota shows it',
  flushes: 'how many times you have flushed on flushes.app, your streak, your latest',
  status: 'your latest is.dame.now status and is.dame.state vitals, as on dame.is',
  music: 'what you are scrobbling to teal.fm: now playing, the last few, your stats',
  chat: 'your stream.place chat on screen',
};
/** Where a new widget goes first. */
export const WIDGET_HOME: Record<WidgetKind, Slot> = {
  card: 'top-left',
  strip: 'bottom-center',
  badge: 'top-right',
  apps: 'top-right',
  forecast: 'top-left',
  pulse: 'top-center',
  moon: 'top-right',
  mark: 'bottom-left',
  loader: 'bottom-left',
  tid: 'top-center',
  flushes: 'top-left',
  status: 'top-left',
  music: 'bottom-left',
  chat: 'top-right',
};

export const MIN_SCALE = 50;
export const MAX_SCALE = 200;

export interface Widget {
  kind: WidgetKind;
  slot: Slot;
  /** Percent of its usual size. */
  scale: number;
  /** How it looks, for a kind with WIDGET_STYLES; absent for the rest. */
  style?: string;
}

export interface OverlayConfig {
  poe: { show: boolean; side: Side; scale: number };
  widgets: Widget[];
  chat: boolean;
  follows: boolean;
  alerts: boolean;
  visitors: boolean;
  /** Handles and DIDs Poe ignores. */
  ignore: string[];
  /** 0 is silent. */
  volume: number;
  /** Minutes of quiet before a nap; 0 never. */
  nap: number;
  theme: 'light' | 'dark';
}

export const DEFAULT_CONFIG: OverlayConfig = Object.freeze({
  poe: Object.freeze({ show: true, side: 'right', scale: 100 }),
  widgets: Object.freeze([Object.freeze({ kind: 'card', slot: 'top-left', scale: 100 })]),
  chat: true,
  follows: true,
  alerts: true,
  visitors: true,
  ignore: Object.freeze([]),
  volume: 40,
  nap: 5,
  theme: 'light',
}) as unknown as OverlayConfig;

export const MAX_IGNORED = 50;
/** A handle (dame.is) or a DID (did:plc:..., did:web:...). */
const ACTOR_RE = /^(did:[a-z]+:[a-zA-Z0-9._:%-]{1,2000}|[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}\.[a-zA-Z]{2,63})$/;

/** A handle or a DID as the overlay keeps it ("@Dame.is" is "dame.is"), or null. */
export function actorOf(raw: string): string | null {
  const s = raw.trim().replace(/^@/, '');
  return ACTOR_RE.test(s) ? s.toLowerCase() : null;
}

export function copyConfig(c: OverlayConfig): OverlayConfig {
  return { ...c, poe: { ...c.poe }, widgets: c.widgets.map((w) => ({ ...w })), ignore: [...c.ignore] };
}

const isKind = (v: unknown): v is WidgetKind => typeof v === 'string' && (WIDGET_KINDS as readonly string[]).includes(v);
const isSlot = (v: unknown): v is Slot => typeof v === 'string' && (SLOTS as readonly string[]).includes(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function clampScale(n: unknown, fallback = 100): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, n))) : fallback;
}

/**
 * The strip runs along an edge: any top slot is the top, any bottom slot the bottom. The
 * chat's side strip runs down a side, the right unless its slot is on the left.
 */
export function slotFor(kind: WidgetKind, slot: Slot, style?: string): Slot {
  if (kind === 'chat' && style === 'side') return slot.endsWith('left') ? 'top-left' : 'top-right';
  if (kind !== 'strip') return slot;
  return slot.startsWith('top') ? 'top-center' : 'bottom-center';
}

/** How many widgets a layout can have: one of each kind. */
export const MAX_WIDGETS = 16;

/** Widgets as the overlay draws them: known kinds, each once (the first wins), in a slot that suits it. */
export function cleanWidgets(list: unknown): Widget[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<WidgetKind>();
  const out: Widget[] = [];
  for (const w of list.slice(0, MAX_WIDGETS)) {
    if (!obj(w) || !isKind(w.kind) || seen.has(w.kind)) continue;
    seen.add(w.kind);
    const slot = isSlot(w.slot) ? w.slot : WIDGET_HOME[w.kind];
    const style = styleFor(w.kind, w.style);
    out.push({ kind: w.kind, slot: slotFor(w.kind, slot, style), scale: clampScale(w.scale), ...(style ? { style } : {}) });
  }
  return out;
}

function cleanIgnore(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === 'string').map(actorOf).filter((a): a is string => a !== null))].slice(0, MAX_IGNORED);
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const intIn = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/** A record's value as a config: what checks out, and the defaults for the rest. */
export function fromRecord(value: unknown): OverlayConfig {
  const d = DEFAULT_CONFIG;
  if (!obj(value)) return copyConfig(d);
  const poe = obj(value.poe) ? value.poe : {};
  return {
    poe: { show: bool(poe.show, d.poe.show), side: poe.side === 'left' ? 'left' : poe.side === 'right' ? 'right' : d.poe.side, scale: clampScale(poe.scale, d.poe.scale) },
    widgets: Array.isArray(value.widgets) ? cleanWidgets(value.widgets) : d.widgets.map((w) => ({ ...w })),
    chat: bool(value.chat, d.chat),
    follows: bool(value.follows, d.follows),
    alerts: bool(value.alerts, d.alerts),
    visitors: bool(value.visitors, d.visitors),
    ignore: cleanIgnore(value.ignore),
    volume: intIn(value.volume, 0, 100, d.volume),
    nap: intIn(value.nap, 0, 240, d.nap),
    theme: value.theme === 'dark' ? 'dark' : 'light',
  };
}

/** The record to save, keeping when it was first made. */
export function toRecord(c: OverlayConfig, createdAt: string, now: Date, name?: string): Record<string, unknown> {
  return {
    $type: OVERLAY_NSID,
    ...(name ? { name: layoutNameOf({ name }, '') } : {}),
    poe: { ...c.poe, scale: clampScale(c.poe.scale) },
    widgets: cleanWidgets(c.widgets),
    chat: c.chat,
    follows: c.follows,
    alerts: c.alerts,
    visitors: c.visitors,
    ignore: cleanIgnore(c.ignore),
    volume: Math.round(Math.max(0, Math.min(100, c.volume))),
    nap: Math.round(Math.max(0, Math.min(240, c.nap))),
    theme: c.theme,
    createdAt,
    updatedAt: now.toISOString(),
  };
}

/** Settings that override others, field by field (params.ts reads them from the URL). */
export type ConfigOverrides = Partial<Omit<OverlayConfig, 'poe'>> & { poe?: Partial<OverlayConfig['poe']> };

export function withOverrides(base: OverlayConfig, o: ConfigOverrides): OverlayConfig {
  const out = copyConfig(base);
  const { poe, ...rest } = o;
  Object.assign(out, rest);
  if (poe) out.poe = { ...out.poe, ...poe };
  if (o.widgets) out.widgets = cleanWidgets(o.widgets);
  if (o.ignore) out.ignore = [...o.ignore];
  return out;
}
