/**
 * The overlay's settings, read from its URL (/overlay?...), so each OBS browser source
 * can ask for its own piece. /overlay/setup builds the URL with a preview.
 *
 *   show=poe,weather   what to draw (default both): "poe", "weather" (the card) and
 *                      "strip" (the weather as one slim bar along the bottom), in any mix;
 *                      one piece per browser source lets each be placed and cropped alone
 *   streamer=dame.is   whose stream.place chat Poe watches (a handle or a DID); without
 *                      it Poe only talks about the weather
 *   chat=off           don't greet chatters or answer chat commands
 *   follows=off        don't cheer new followers
 *   alerts=off         don't say weather alerts (storms, apps blowing in, ...)
 *   ignore=a.bsky.social,did:plc:...
 *                      people Poe never greets, thanks or answers (bots, say)
 *   sound=off          no noises; volume=0-100 how loud they are (default 40)
 *   nap=10             minutes of quiet before Poe dozes off (default 5); nap=off never
 *   side=left          Poe in the bottom-left corner instead of the bottom-right
 *   theme=dark         the dark theme's colours on the weather
 *   demo               Poe runs through some example lines, for placing things in OBS
 *
 * Anything it doesn't know is left at its default.
 */

export type Piece = 'poe' | 'weather' | 'strip';

export interface OverlayParams {
  show: Set<Piece>;
  /** A handle or a DID, unchecked beyond its shape: resolved later (index.ts). */
  streamer: string | null;
  chat: boolean;
  follows: boolean;
  alerts: boolean;
  /** Handles and DIDs, resolved later like the streamer. */
  ignore: string[];
  /** 0 is silent. */
  volume: number;
  /** Minutes of quiet before a nap; 0 never. */
  nap: number;
  side: 'left' | 'right';
  theme: 'light' | 'dark';
  demo: boolean;
}

export const PIECES: readonly Piece[] = ['poe', 'weather', 'strip'];
export const DEFAULT_PIECES: readonly Piece[] = ['poe', 'weather'];
export const DEFAULT_VOLUME = 40;
export const DEFAULT_NAP = 5;
export const MAX_IGNORED = 50;
/** A handle (dame.is) or a DID (did:plc:..., did:web:...). */
const ACTOR_RE = /^(did:[a-z]+:[a-zA-Z0-9._:%-]{1,2000}|[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}\.[a-zA-Z]{2,63})$/;

const off = (v: string | null) => v !== null && /^(off|no|false|0)$/i.test(v.trim());

/** A handle or a DID as the overlay keeps it ("@Dame.is" is "dame.is"), or null. */
export function actorOf(raw: string): string | null {
  const s = raw.trim().replace(/^@/, '');
  return ACTOR_RE.test(s) ? s.toLowerCase() : null;
}

function numberIn(v: string | null, min: number, max: number, fallback: number): number {
  if (v === null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function readParams(search: string): OverlayParams {
  const q = new URLSearchParams(search);
  const asked = (q.get('show') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Piece => (PIECES as readonly string[]).includes(s));
  const ignore = [...new Set((q.get('ignore') ?? '').split(/[,\s]+/).map(actorOf).filter((a): a is string => a !== null))].slice(0, MAX_IGNORED);
  return {
    show: new Set(asked.length > 0 ? asked : DEFAULT_PIECES),
    streamer: actorOf(q.get('streamer') ?? ''),
    chat: !off(q.get('chat')),
    follows: !off(q.get('follows')),
    alerts: !off(q.get('alerts')),
    ignore,
    volume: off(q.get('sound')) ? 0 : numberIn(q.get('volume'), 0, 100, DEFAULT_VOLUME),
    nap: off(q.get('nap')) ? 0 : numberIn(q.get('nap'), 1, 240, DEFAULT_NAP),
    side: q.get('side')?.toLowerCase() === 'left' ? 'left' : 'right',
    theme: q.get('theme')?.toLowerCase() === 'dark' ? 'dark' : 'light',
    demo: q.has('demo') && !off(q.get('demo')),
  };
}

/** The settings as a URL query, leaving out anything at its default (the setup page). */
export function toSearch(p: OverlayParams): string {
  const q = new URLSearchParams();
  const pieces = PIECES.filter((x) => p.show.has(x));
  if (pieces.join() !== DEFAULT_PIECES.join()) q.set('show', pieces.join(','));
  if (p.streamer) q.set('streamer', p.streamer);
  if (!p.chat) q.set('chat', 'off');
  if (!p.follows) q.set('follows', 'off');
  if (!p.alerts) q.set('alerts', 'off');
  if (p.ignore.length) q.set('ignore', p.ignore.join(','));
  if (p.volume <= 0) q.set('sound', 'off');
  else if (p.volume !== DEFAULT_VOLUME) q.set('volume', String(Math.round(p.volume)));
  if (p.nap <= 0) q.set('nap', 'off');
  else if (p.nap !== DEFAULT_NAP) q.set('nap', String(p.nap));
  if (p.side !== 'right') q.set('side', p.side);
  if (p.theme !== 'light') q.set('theme', p.theme);
  if (p.demo) q.set('demo', '');
  const s = q.toString().replace(/demo=(&|$)/, 'demo$1').replace(/%2C/g, ',').replace(/%3A/g, ':');
  return s ? `?${s}` : '';
}
