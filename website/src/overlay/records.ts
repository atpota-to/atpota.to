/**
 * The streamer's own records from around the atmosphere, as widgets: each a
 * <section data-ov-widget="kind"> in overlay/index.html holding every part its styles
 * need (config.ts WIDGET_STYLES), and overlay.css shows the ones its data-style wants.
 *
 *   flushes  im.flushing.right.now, their flushes on flushes.app: the count, the stats
 *            (today, this week, the streak, their favourite emoji) or the latest flush.
 *            Counted from their own repo, as flushes.app's profile counts its headline,
 *            up to FLUSH_MAX
 *   status   is.dame.now and is.dame.state, as dame.is shows them: the latest status
 *            ("dame.is streaming with poe") and the latest vitals (heart rate, what
 *            they're doing, battery, the noise around them, calories)
 *   music    teal.fm: what's playing now (fm.teal.actor.status, until it expires), else
 *            the last play; the last few plays; or plays today and this week with the top
 *            artist and track. Both namespaces, the production one first, deduplicated by
 *            record key, as teal.fm asks of anything reading through its move off alpha
 *
 * They're read publicly from the streamer's PDS (store.ts), only while on screen, every
 * REFRESH_MS and again POKE_MS after Jetstream says one of those collections changed in
 * their repo (chat.ts). Without anyone to read (?demo in the setup page's preview without
 * ?who=), they show examples. Every word is the streamer's and goes in through textContent.
 */

import { readTid } from './tid';
import { getPublic, listPublic, type PublicRecord } from './store';
import type { WidgetKind } from './config';

export const FLUSHES = 'im.flushing.right.now';
export const STATUS = 'is.dame.now';
export const STATE = 'is.dame.state';
/** teal.fm's plays and now-playing status, the production namespace first: it wins a tie. */
export const PLAY_NSIDS = ['fm.teal.feed.play', 'fm.teal.alpha.feed.play'] as const;
export const TEAL_STATUS_NSIDS = ['fm.teal.actor.status', 'fm.teal.alpha.actor.status'] as const;
/** Every collection a record widget reads, for Jetstream to watch (chat.ts). */
export const RECORD_COLLECTIONS = [FLUSHES, STATUS, STATE, ...PLAY_NSIDS, ...TEAL_STATUS_NSIDS] as const;

export const REFRESH_MS = 60_000;
export const POKE_MS = 1500;
/** The most flushes counted, as flushes.app's profile crawl. */
export const FLUSH_MAX = 2000;
/** teal.fm's own fallback: a status without an expiry is current for this long after its time. */
export const STATUS_TTL_MS = 10 * 60_000;
export const HISTORY_SHOWN = 5;
/** Plays read for the stats: enough for a week, mostly. */
export const PLAYS_MAX = 300;
const DAY_MS = 86_400_000;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** One line of someone's words, at most `max` characters. */
export function line(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return [...v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}
/** When a record was made: its createdAt, else its record key as a TID. */
function whenOf(value: Record<string, unknown>, rkey: string, field = 'createdAt'): number {
  const t = typeof value[field] === 'string' ? Date.parse(value[field] as string) : NaN;
  if (Number.isFinite(t)) return t;
  const tid = readTid(rkey);
  return tid ? Math.floor(tid.us / 1000) : NaN;
}
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "just now", "4 min ago", "2 hr ago", "3 days ago". */
export function agoText(t: number, now: number): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} hr ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const numberText = (n: number) => n.toLocaleString('en-US');

// ---------- flushes ----------

export interface Flush {
  emoji: string;
  text: string;
  at: number;
}

export function flushesOf(records: PublicRecord[]): Flush[] {
  return records
    .map((r) => ({ emoji: line(r.value.emoji, 8), text: line(r.value.text, 60), at: whenOf(r.value, r.rkey) }))
    .filter((f) => Number.isFinite(f.at))
    .sort((a, b) => b.at - a.at);
}

export interface FlushStats {
  total: number;
  /** The count stopped at FLUSH_MAX. */
  capped: boolean;
  today: number;
  week: number;
  /** Days in a row with a flush, up to today (or yesterday, when today hasn't one yet). */
  streak: number;
  top: string | null;
  latest: Flush | null;
}

export function flushStats(flushes: Flush[], now: number, capped = false): FlushStats {
  const days = new Set(flushes.map((f) => dayKey(f.at)));
  const today = dayKey(now);
  let streak = 0;
  const day = new Date(now);
  if (!days.has(today)) day.setDate(day.getDate() - 1);
  while (days.has(dayKey(day.getTime()))) {
    streak += 1;
    day.setDate(day.getDate() - 1);
  }
  const counts = new Map<string, number>();
  for (const f of flushes) if (f.emoji) counts.set(f.emoji, (counts.get(f.emoji) ?? 0) + 1);
  let top: string | null = null;
  for (const [e, n] of counts) if (top === null || n > counts.get(top)!) top = e;
  return {
    total: flushes.length,
    capped,
    today: flushes.filter((f) => dayKey(f.at) === today).length,
    week: flushes.filter((f) => now - f.at < 7 * DAY_MS).length,
    streak,
    top,
    latest: flushes[0] ?? null,
  };
}

// ---------- status and vitals ----------

export interface Status {
  text: string;
  at: number;
}

export function statusOf(r: PublicRecord | undefined): Status | null {
  if (!r) return null;
  const text = line(r.value.status, 280);
  return text ? { text, at: whenOf(r.value, r.rkey) } : null;
}

export interface Vitals {
  heartRate: number | null;
  activity: string | null;
  battery: number | null;
  charging: boolean | null;
  sound: number | null;
  calories: number | null;
  at: number;
}

const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n !== 0 ? n : null;
};
const toBool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return ['yes', 'true', '1', 'on', 'charging'].includes(s) ? true : ['no', 'false', '0', 'off'].includes(s) ? false : null;
};

/** The phone's way of saying what someone's doing, in a word (dame.is's lib/activity.js). */
export function activityOf(raw: unknown): string | null {
  const s = line(raw, 40).toLowerCase();
  if (!s || s === 'unknown') return null;
  if (/vehicle|driving|automotive/.test(s)) return 'in a vehicle';
  if (/cycl|bike|bicycl/.test(s)) return 'cycling';
  if (/runn|^run$/.test(s)) return 'running';
  if (/walk|on foot/.test(s)) return 'walking';
  if (/stationary|not moving|standing still|\bstill\b|idle/.test(s)) return 'still';
  return s;
}

/** An is.dame.state record as vitals, coerced hard: a phone Shortcut writes strings, and a 0 is no reading. */
export function vitalsOf(r: PublicRecord | undefined): Vitals | null {
  if (!r) return null;
  const v = r.value;
  const battery = toInt(v.batteryLevel);
  const out: Vitals = {
    heartRate: toInt(v.heartRate),
    activity: activityOf(v.activity ?? v.physicalActivity),
    battery: battery === null ? null : Math.max(0, Math.min(100, battery)),
    charging: toBool(v.charging ?? v.isCharging),
    sound: toInt(v.soundLevel ?? v.environmentSound),
    calories: toInt(v.caloriesBurned),
    at: whenOf(v, r.rkey, typeof v.capturedAt === 'string' ? 'capturedAt' : 'createdAt'),
  };
  return [out.heartRate, out.activity, out.battery, out.sound, out.calories].some((x) => x !== null) ? out : null;
}

// ---------- music ----------

export interface Play {
  rkey: string;
  track: string;
  artist: string;
  release: string;
  /** The release's MusicBrainz id, for its cover. */
  releaseMbId: string | null;
  at: number;
  /** Seconds. */
  duration: number | null;
}

const MBID_RE = /^(?:mbid:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A play record (either namespace, either spelling) as a play, or null without a track. */
export function playOf(value: unknown, rkey = ''): Play | null {
  if (!obj(value)) return null;
  const track = line(value.trackName ?? value.track, 120);
  if (!track) return null;
  const names = Array.isArray(value.artists)
    ? value.artists.map((a) => (obj(a) ? a.artistName : null))
    : Array.isArray(value.artistNames)
      ? value.artistNames
      : [value.artist];
  const mbid = typeof value.releaseMbId === 'string' ? MBID_RE.exec(value.releaseMbId.trim()) : null;
  const duration = typeof value.duration === 'number' && value.duration > 0 && value.duration < 36_000 ? value.duration : null;
  return {
    rkey,
    track,
    artist: line(names.map((n) => line(n, 80)).filter(Boolean).join(', '), 120),
    release: line(value.releaseName, 120),
    releaseMbId: mbid ? mbid[1]!.toLowerCase() : null,
    at: whenOf(value, rkey, typeof value.playedTime === 'string' ? 'playedTime' : 'createdAt'),
    duration,
  };
}

/** Plays from each namespace (production first), one per record key, newest first. */
export function playsFrom(lists: PublicRecord[][]): Play[] {
  const byKey = new Map<string, Play>();
  for (const list of lists) {
    for (const r of list) {
      if (byKey.has(r.rkey)) continue;
      const p = playOf(r.value, r.rkey);
      if (p && Number.isFinite(p.at)) byKey.set(r.rkey, p);
    }
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

/** A play that's on now: since when, and until when its status says so. */
export type Live = Play & { since: number; until: number };

/** What's playing now, from the status records (either namespace): the newest one that hasn't expired. */
export function nowPlaying(statuses: Array<Record<string, unknown> | null | undefined>, now: number): Live | null {
  let best: Live | null = null;
  for (const s of statuses) {
    if (!s || !obj(s.item)) continue;
    const since = Date.parse(String(s.time ?? ''));
    const expiry = Date.parse(String(s.expiry ?? ''));
    const until = Number.isFinite(expiry) ? expiry : Number.isFinite(since) ? since + STATUS_TTL_MS : NaN;
    if (!(now <= until)) continue;
    const play = playOf(s.item);
    const from = Number.isFinite(since) ? since : now;
    if (play && (!best || from > best.since)) best = { ...play, at: from, since: from, until };
  }
  return best;
}

export interface MusicStats {
  today: number;
  week: number;
  topArtist: string | null;
  topTrack: string | null;
}

function most(items: string[]): string | null {
  const counts = new Map<string, number>();
  let top: string | null = null;
  for (const x of items) {
    if (!x) continue;
    counts.set(x, (counts.get(x) ?? 0) + 1);
    if (top === null || counts.get(x)! > counts.get(top)!) top = x;
  }
  return top;
}

export function musicStats(plays: Play[], now: number): MusicStats {
  const week = plays.filter((p) => now - p.at < 7 * DAY_MS);
  return {
    today: plays.filter((p) => dayKey(p.at) === dayKey(now)).length,
    week: week.length,
    topArtist: most(week.map((p) => p.artist.split(', ')[0] ?? '')),
    topTrack: most(week.map((p) => (p.artist ? `${p.track} · ${p.artist.split(', ')[0]}` : p.track))),
  };
}

/** A release's cover from the Cover Art Archive, or null without a MusicBrainz id. */
export function coverUrl(mbid: string | null): string | null {
  return mbid && MBID_RE.test(mbid) ? `https://coverartarchive.org/release/${mbid}/front-250` : null;
}

// ---------- examples, for ?demo ----------

const minutes = (n: number, now: number) => now - n * 60_000;

export function demoFlushes(now: number): FlushStats {
  return { total: 128, capped: false, today: 2, week: 11, streak: 6, top: '🚽', latest: { emoji: '🧻', text: 'reading the atmosphere weather', at: minutes(12, now) } };
}
export const demoStatus = (now: number): { status: Status; vitals: Vitals } => ({
  status: { text: 'streaming with poe (◕‿◕)', at: minutes(25, now) },
  vitals: { heartRate: 72, activity: 'still', battery: 64, charging: true, sound: 48, calories: 410, at: minutes(4, now) },
});
export function demoMusic(now: number): { now: Live | null; plays: Play[] } {
  const p = (track: string, artist: string, ago: number): Play => ({ rkey: track, track, artist, release: '', releaseMbId: null, at: minutes(ago, now), duration: 210 });
  const plays = [p('Good Intentions', 'Magdalena Bay', 1), p('True Blue Interlude', 'Magdalena Bay', 5), p('Cherry Coloured Funk', 'Cocteau Twins', 9), p('Kyoto', 'Phoebe Bridgers', 13), p('Sunday', 'Sylvan Esso', 17)];
  return { now: { ...plays[0]!, since: minutes(1, now), until: now + 3 * 60_000 }, plays };
}

// ---------- on the page ----------

interface Part {
  show(on: boolean): void;
  setWho(did: string | null, handle: string | null, demo: boolean): void;
  poke(): void;
}

/** Keeps a widget read while it's on screen: now, every REFRESH_MS, and POKE_MS after a poke. */
function keepRead(el: HTMLElement, win: Window, read: (did: string) => Promise<boolean>, demo: () => void): Part {
  let did: string | null = null;
  let isDemo = false;
  let shown = false;
  let timer: number | undefined;
  let poked: number | undefined;
  const run = async () => {
    win.clearTimeout(timer);
    if (!shown) return;
    if (!did) {
      if (isDemo) demo();
      else {
        el.dataset.state = 'empty';
      }
      return;
    }
    const at = did;
    const ok = await read(at).catch(() => false);
    if (at !== did) return;
    if (!ok && el.dataset.state !== 'ready') el.dataset.state = 'error';
    if (shown) timer = win.setTimeout(() => void run(), REFRESH_MS);
  };
  return {
    show(on) {
      if (on === shown) return;
      shown = on;
      if (on) void run();
      else win.clearTimeout(timer);
    },
    setWho(next, _handle, demoOn) {
      if (next === did && demoOn === isDemo) return;
      did = next;
      isDemo = demoOn;
      el.dataset.state = 'loading';
      void run();
    },
    poke() {
      win.clearTimeout(poked);
      poked = win.setTimeout(() => void run(), POKE_MS);
    },
  };
}

const text = (root: HTMLElement, sel: string, value: string) => {
  for (const el of root.querySelectorAll<HTMLElement>(sel)) el.textContent = value;
};
const hide = (root: HTMLElement, sel: string, hidden: boolean) => {
  for (const el of root.querySelectorAll<HTMLElement>(sel)) el.hidden = hidden;
};

export function drawFlushes(el: HTMLElement, s: FlushStats, now: number): void {
  const total = `${numberText(s.total)}${s.capped ? '+' : ''}`;
  text(el, '[data-ov-fl-total]', total);
  text(el, '[data-ov-fl-unit]', s.total === 1 ? 'flush' : 'flushes');
  text(el, '[data-ov-fl-today]', numberText(s.today));
  text(el, '[data-ov-fl-week]', numberText(s.week));
  text(el, '[data-ov-fl-streak]', s.streak ? `${numberText(s.streak)} ${s.streak === 1 ? 'day' : 'days'}` : 'none yet');
  text(el, '[data-ov-fl-top]', s.top ?? '–');
  text(el, '[data-ov-fl-line]', `${numberText(s.today)} today · ${s.streak ? `${s.streak}-day streak` : 'no streak yet'}`);
  hide(el, '[data-ov-fl-latest]', !s.latest);
  if (s.latest) {
    text(el, '[data-ov-fl-emoji]', s.latest.emoji || '🚽');
    text(el, '[data-ov-fl-text]', s.latest.text || 'is flushing');
    text(el, '[data-ov-fl-ago]', `${agoText(s.latest.at, now)} · flush no. ${total}`);
  }
  el.dataset.state = s.total ? 'ready' : 'empty';
}

export function drawStatus(el: HTMLElement, who: string, status: Status | null, vitals: Vitals | null, now: number): void {
  hide(el, '[data-ov-st-now]', !status);
  if (status) {
    text(el, '[data-ov-st-who]', who);
    text(el, '[data-ov-st-text]', status.text);
    text(el, '[data-ov-st-ago]', agoText(status.at, now));
  }
  hide(el, '[data-ov-st-vitals]', !vitals);
  if (vitals) {
    const put = (key: string, value: string | null) => {
      hide(el, `[data-ov-vital="${key}"]`, value === null);
      if (value !== null) text(el, `[data-ov-vital="${key}"] dd`, value);
    };
    put('heart', vitals.heartRate === null ? null : `${vitals.heartRate} bpm`);
    put('doing', vitals.activity);
    put('battery', vitals.battery === null ? null : `${vitals.battery}%${vitals.charging ? ', charging' : ''}`);
    put('sound', vitals.sound === null ? null : `${vitals.sound} dB`);
    put('calories', vitals.calories === null ? null : `${numberText(vitals.calories)} cal`);
    text(el, '[data-ov-st-vitals-ago]', `vitals from ${agoText(vitals.at, now)}`);
  }
  el.dataset.state = status || vitals ? 'ready' : 'empty';
}

export function drawMusic(el: HTMLElement, live: Live | null, plays: Play[], now: number): void {
  const doc = el.ownerDocument;
  const current = live ?? plays[0] ?? null;
  el.dataset.live = live ? 'yes' : 'no';
  const style = el.dataset.style;
  text(el, '[data-ov-mu-title]', style === 'history' ? 'recently played' : style === 'stats' ? 'listening' : live ? 'now playing' : 'last played');
  hide(el, '[data-ov-mu-now]', !current);
  if (current) {
    text(el, '[data-ov-mu-track]', current.track);
    text(el, '[data-ov-mu-artist]', current.artist);
    text(el, '[data-ov-mu-when]', live ? (current.release || 'on teal.fm') : agoText(current.at, now));
    text(el, '[data-ov-mu-mini]', current.artist ? `${current.track} — ${current.artist}` : current.track);
    const cover = coverUrl(current.releaseMbId);
    for (const img of el.querySelectorAll<HTMLImageElement>('[data-ov-mu-art]')) {
      if (!cover) {
        img.hidden = true;
        img.removeAttribute('src');
        continue;
      }
      if (img.getAttribute('src') !== cover) {
        img.hidden = true;
        img.onload = () => (img.hidden = false);
        img.onerror = () => (img.hidden = true);
        img.src = cover;
      }
    }
    const bar = el.querySelector<HTMLElement>('[data-ov-mu-progress]');
    if (bar) {
      const share = live && current.duration ? Math.min(1, (now - live.since) / (current.duration * 1000)) : 0;
      bar.style.setProperty('--share', String(share));
      bar.parentElement!.hidden = !(live && current.duration);
    }
  }
  const list = el.querySelector<HTMLElement>('[data-ov-mu-history]');
  list?.replaceChildren(
    ...plays.slice(0, HISTORY_SHOWN).map((p) => {
      const li = doc.createElement('li');
      const track = doc.createElement('span');
      track.className = 'ov-music__h-track';
      track.textContent = p.track;
      const artist = doc.createElement('span');
      artist.className = 'ov-music__h-artist';
      artist.textContent = p.artist;
      const ago = doc.createElement('span');
      ago.className = 'ov-music__h-ago';
      ago.textContent = agoText(p.at, now);
      li.append(track, artist, ago);
      return li;
    }),
  );
  const s = musicStats(plays, now);
  text(el, '[data-ov-mu-today]', numberText(s.today));
  text(el, '[data-ov-mu-week]', numberText(s.week));
  text(el, '[data-ov-mu-artist-top]', s.topArtist ?? '–');
  text(el, '[data-ov-mu-track-top]', s.topTrack ?? '–');
  el.dataset.state = current ? 'ready' : 'empty';
}

export interface RecordWidgets {
  /** Whose records to read (a DID), what to call them, and whether to show examples without anyone. */
  setWho(did: string | null, handle: string | null, demo?: boolean): void;
  /** Jetstream says this collection changed in their repo. */
  changed(collection: string): void;
  /** Only what's on screen is read. */
  showing(kinds: Set<WidgetKind>): void;
}

/** Every record widget on the page, mounted once; layout.ts decides which show. */
export function mountRecords(root: ParentNode, opts: { win?: Window; fetchImpl?: typeof fetch; now?: () => number } = {}): RecordWidgets {
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const find = (kind: WidgetKind) => root.querySelector<HTMLElement>(`[data-ov-widget="${kind}"]`);
  const parts = new Map<WidgetKind, { part: Part; collections: readonly string[] }>();
  let who = '';
  /** The music widget's title follows its style, which can change while it shows. */
  let redrawMusic = () => {};

  const flEl = find('flushes');
  if (flEl) {
    const part = keepRead(
      flEl,
      win,
      async (did) => {
        const recs = await listPublic(did, FLUSHES, FLUSH_MAX, fetchImpl);
        if (!recs) return false;
        drawFlushes(flEl, flushStats(flushesOf(recs), now(), recs.length >= FLUSH_MAX), now());
        return true;
      },
      () => drawFlushes(flEl, demoFlushes(now()), now()),
    );
    parts.set('flushes', { part, collections: [FLUSHES] });
  }

  const stEl = find('status');
  if (stEl) {
    const part = keepRead(
      stEl,
      win,
      async (did) => {
        const [status, state] = await Promise.all([listPublic(did, STATUS, 1, fetchImpl), listPublic(did, STATE, 1, fetchImpl)]);
        if (!status && !state) return false;
        drawStatus(stEl, who, statusOf(status?.[0]), vitalsOf(state?.[0]), now());
        return true;
      },
      () => {
        const d = demoStatus(now());
        drawStatus(stEl, who || "you're", d.status, d.vitals, now());
      },
    );
    parts.set('status', { part, collections: [STATUS, STATE] });
  }

  const muEl = find('music');
  if (muEl) {
    let live: Live | null = null;
    let plays: Play[] = [];
    const weekAgo = () => now() - 7 * DAY_MS;
    const part = keepRead(
      muEl,
      win,
      async (did) => {
        const [statuses, ...lists] = await Promise.all([
          Promise.all(TEAL_STATUS_NSIDS.map((c) => getPublic(did, c, 'self', fetchImpl))),
          ...PLAY_NSIDS.map((c) => listPublic(did, c, PLAYS_MAX, fetchImpl, (got) => got.length > 0 && whenOf(got.at(-1)!.value, got.at(-1)!.rkey, 'playedTime') < weekAgo())),
        ]);
        if (lists.every((l) => l === undefined) && statuses.every((s) => s === undefined)) return false;
        live = nowPlaying(statuses, now());
        plays = playsFrom(lists.map((l) => l ?? []));
        drawMusic(muEl, live, plays, now());
        return true;
      },
      () => {
        const d = demoMusic(now());
        live = d.now;
        plays = d.plays;
        drawMusic(muEl, live, plays, now());
      },
    );
    // the progress bar, and a status that runs out between reads
    win.setInterval(() => {
      if (muEl.hidden || !live) return;
      if (now() > live.until) live = null;
      drawMusic(muEl, live, plays, now());
    }, 1000);
    redrawMusic = () => {
      if (muEl.dataset.state === 'ready') drawMusic(muEl, live, plays, now());
    };
    parts.set('music', { part, collections: [...PLAY_NSIDS, ...TEAL_STATUS_NSIDS] });
  }

  return {
    setWho(did, handle, demo = false) {
      who = handle ?? '';
      for (const { part } of parts.values()) part.setWho(did, handle, demo);
    },
    changed(collection) {
      for (const { part, collections } of parts.values()) if (collections.includes(collection)) part.poke();
    },
    showing(kinds) {
      for (const [kind, { part }] of parts) part.show(kinds.has(kind));
      redrawMusic();
    },
  };
}
