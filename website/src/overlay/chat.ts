/**
 * What's happening on the stream, from Jetstream: messages in the streamer's stream.place
 * chat (place.stream.chat.message records whose `streamer` is them), new follows of the
 * streamer (app.bsky.graph.follow records whose `subject` is them), and the streamer's own
 * place.stream.livestream records: a new one is a stream going live, and one updated with
 * an `endedAt` is that stream over. All of them are public records in people's own repos,
 * so the overlay needs no sign-in and no stream.place API.
 *
 * Jetstream only filters by collection, so the follows come for the whole network (tens a
 * second, a few KB) and are picked out here. With follows off it asks for chat alone.
 *
 * Chat text is other people's words and never reaches the screen: Poe only reacts to it
 * (a greeting, a command) and names people by their handle, through textContent.
 */

export const CHAT = 'place.stream.chat.message';
export const FOLLOW = 'app.bsky.graph.follow';
export const LIVESTREAM = 'place.stream.livestream';

/** Bluesky's us-east hosts share one address, so the fallback is in us-west (as server/atmosphere.ts). */
export const JETSTREAMS = ['wss://jetstream2.us-east.bsky.network/subscribe', 'wss://jetstream1.us-west.bsky.network/subscribe'] as const;

/** Reconnects back off from this to RETRY_MAX_MS. */
export const RETRY_MS = 2000;
export const RETRY_MAX_MS = 60_000;
/** Picks up where it left off if it was gone less than this, so nobody's hello is missed. */
const REWIND_MAX_US = 5 * 60 * 1_000_000;

export type Command = 'weather' | 'forecast' | 'apps' | 'pet' | 'poe';

export type StreamEvent =
  | { kind: 'chat'; did: string; command: Command | null }
  | { kind: 'follow'; did: string }
  /** The streamer's stream: `rkey` tells one stream from the next; the title is theirs. */
  | { kind: 'live'; rkey: string; title: string | null }
  | { kind: 'ended'; rkey: string };

const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** "!weather", "!forecast", "!apps", "!pet", "!poe" at the start of a message (any case); anything else is chat. */
export function commandOf(text: string): Command | null {
  const m = /^\s*!(weather|forecast|apps|pet|poe)\b/i.exec(text);
  return m ? (m[1]!.toLowerCase() as Command) : null;
}

/** A Jetstream message as a stream event for `streamer`, or null when it's about someone else. */
export function eventFor(message: unknown, streamer: string): StreamEvent | null {
  if (!obj(message) || message.kind !== 'commit' || typeof message.did !== 'string') return null;
  const commit = message.commit;
  if (!obj(commit) || !obj(commit.record)) return null;
  const record = commit.record;
  if (commit.collection === LIVESTREAM && message.did === streamer && typeof commit.rkey === 'string') {
    if (commit.operation === 'create' && record.endedAt === undefined) return { kind: 'live', rkey: commit.rkey, title: typeof record.title === 'string' && record.title.trim() ? record.title.trim().slice(0, 140) : null };
    if (commit.operation === 'update' && typeof record.endedAt === 'string') return { kind: 'ended', rkey: commit.rkey };
    return null;
  }
  if (commit.operation !== 'create') return null;
  if (commit.collection === CHAT && record.streamer === streamer && typeof record.text === 'string') {
    return { kind: 'chat', did: message.did, command: commandOf(record.text) };
  }
  if (commit.collection === FOLLOW && record.subject === streamer && message.did !== streamer) {
    return { kind: 'follow', did: message.did };
  }
  return null;
}

export function jetstreamUrl(host: string, follows: boolean, cursor?: number): string {
  const url = new URL(host);
  url.searchParams.append('wantedCollections', CHAT);
  url.searchParams.append('wantedCollections', LIVESTREAM);
  if (follows) url.searchParams.append('wantedCollections', FOLLOW);
  if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));
  return url.toString();
}

export interface Listener {
  stop(): void;
}

type SocketCtor = new (url: string) => WebSocket;

/** Listens until stopped, reconnecting (and switching hosts) whenever the connection drops. */
export function listen(streamer: string, follows: boolean, onEvent: (e: StreamEvent) => void, Socket: SocketCtor = WebSocket, win: Window = window): Listener {
  let socket: WebSocket | null = null;
  let stopped = false;
  let tries = 0;
  let host = 0;
  let lastUs: number | undefined;
  let lastAt = 0;
  let timer: number | undefined;

  const connect = () => {
    if (stopped) return;
    const rewind = lastUs !== undefined && Date.now() - lastAt < REWIND_MAX_US / 1000 ? lastUs : undefined;
    const ws = new Socket(jetstreamUrl(JETSTREAMS[host % JETSTREAMS.length]!, follows, rewind));
    socket = ws;
    ws.onopen = () => {
      tries = 0;
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      let data: unknown;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (obj(data) && typeof data.time_us === 'number') {
        lastUs = data.time_us;
        lastAt = Date.now();
      }
      const event = eventFor(data, streamer);
      if (event) onEvent(event);
    };
    ws.onclose = () => {
      if (stopped || socket !== ws) return;
      socket = null;
      host += 1;
      const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** tries);
      tries += 1;
      timer = win.setTimeout(connect, wait);
    };
    ws.onerror = () => ws.close();
  };

  connect();
  return {
    stop() {
      stopped = true;
      win.clearTimeout(timer);
      socket?.close();
    },
  };
}

// ---------- who's who ----------

const APPVIEW = 'https://public.api.bsky.app/xrpc';
const HANDLE_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
/** Long handles are cut short on screen. */
export const HANDLE_MAX = 32;

/** "@dame.is", cut to HANDLE_MAX, or null for an account without a working handle. */
export function atHandle(handle: unknown): string | null {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle) || handle === 'handle.invalid') return null;
  return `@${handle.length > HANDLE_MAX ? `${handle.slice(0, HANDLE_MAX - 1)}…` : handle}`;
}

/** A DID for a handle or DID, or null if it can't be found. */
export async function resolveActor(actor: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (actor.startsWith('did:')) return actor;
  try {
    const res = await fetchImpl(`${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return obj(body) && typeof body.did === 'string' && body.did.startsWith('did:') ? body.did : null;
  } catch {
    return null;
  }
}

/** An avatar from Bluesky's image CDN, or null: nothing else is put on stream. */
export function avatarUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 1000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'cdn.bsky.app' ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface Who {
  /** "@handle", or null for an account without a working one. */
  handle: string | null;
  avatar: string | null;
}

export const NOBODY: Who = Object.freeze({ handle: null, avatar: null });

/** Looks up handles and avatars, remembering each one for the visit. */
export function createNames(fetchImpl: typeof fetch = fetch): (did: string) => Promise<Who> {
  const known = new Map<string, Promise<Who>>();
  return (did) => {
    let who = known.get(did);
    if (!who) {
      who = fetchImpl(`${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: unknown) => (obj(body) ? { handle: atHandle(body.handle), avatar: avatarUrl(body.avatar) } : NOBODY))
        .catch(() => NOBODY);
      known.set(did, who);
    }
    return who;
  };
}
