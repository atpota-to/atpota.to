/**
 * The overlay's settings, read from its URL (/overlay?...), so each OBS browser source
 * can ask for its own piece:
 *
 *   show=poe,weather   what to draw (default both): "poe" alone or "weather" alone gives
 *                      one piece per browser source, to place and crop separately
 *   streamer=dame.is   whose stream.place chat Poe watches (a handle or a DID); without
 *                      it Poe only talks about the weather
 *   chat=off           don't greet chatters or answer chat commands
 *   follows=off        don't cheer new followers
 *   alerts=off         don't say weather alerts (storms, apps blowing in, ...)
 *   side=left          Poe in the bottom-left corner instead of the bottom-right
 *   theme=dark         the dark theme's colours on the weather card
 *   demo               Poe runs through some example lines, for placing things in OBS
 *
 * Anything it doesn't know is left at its default.
 */

export type Piece = 'poe' | 'weather';

export interface OverlayParams {
  show: Set<Piece>;
  /** A handle or a DID, unchecked beyond its shape: resolved later (index.ts). */
  streamer: string | null;
  chat: boolean;
  follows: boolean;
  alerts: boolean;
  side: 'left' | 'right';
  theme: 'light' | 'dark';
  demo: boolean;
}

const PIECES: readonly Piece[] = ['poe', 'weather'];
/** A handle (dame.is) or a DID (did:plc:..., did:web:...). */
const ACTOR_RE = /^(did:[a-z]+:[a-zA-Z0-9._:%-]{1,2000}|[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}\.[a-zA-Z]{2,63})$/;

const off = (v: string | null) => v !== null && /^(off|no|false|0)$/i.test(v.trim());

export function readParams(search: string): OverlayParams {
  const q = new URLSearchParams(search);
  const asked = (q.get('show') ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Piece => (PIECES as readonly string[]).includes(s));
  const raw = (q.get('streamer') ?? '').trim().replace(/^@/, '');
  return {
    show: new Set(asked.length > 0 ? asked : PIECES),
    streamer: ACTOR_RE.test(raw) ? raw.toLowerCase() : null,
    chat: !off(q.get('chat')),
    follows: !off(q.get('follows')),
    alerts: !off(q.get('alerts')),
    side: q.get('side')?.toLowerCase() === 'left' ? 'left' : 'right',
    theme: q.get('theme')?.toLowerCase() === 'dark' ? 'dark' : 'light',
    demo: q.has('demo') && !off(q.get('demo')),
  };
}
