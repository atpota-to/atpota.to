/**
 * Weather alerts on the weather report (/weather): Poe pipes up from its corner, in a chat
 * bubble by the potato (src/poe/say.ts), when something happens in the sky:
 *
 *   arrival  an app this visit hasn't heard at all blows in with at least ARRIVAL_MIN
 *            records in the live 60 seconds ("techne.app just blew in"). Apps with a
 *            record or two drift through the top ten every few seconds, and apps already
 *            about rise and fall; neither is news.
 *   new      the station hears an app for the very first time (the almanac's
 *            "new in the atmosphere", once the station has warmed up)
 *   storm    new records a second climb into "stormy"
 *   mixed    the diversity index climbs a level
 *
 * The first reading of a visit only sets the scene; alerts come from what changes after
 * it. Poe says one at a time, at least GAP_MS apart, each for ALERT_MS (held while it's
 * hovered or focused). A storm or a more mixed sky alerts at most once every COOLDOWN_MS,
 * so a sky sitting on a line doesn't keep on about it. A small queue keeps the most
 * important ones and waits while Poe is busy (its panel open, its nudge up) or the tab is
 * hidden, and lets go of any older than STALE_MS: by then it isn't news. The reader can
 * hush them, and that sticks in this browser (localStorage ALERTS_KEY).
 *
 * Poe reads them out politely to screen readers. App and collection names are other
 * people's text and only reach the page through textContent (say.ts).
 */

import { say, type PoeLine, type PoeSpeech } from '../poe/say';
import type { MascotFace } from './mascot';
import { diversityText, formatIndex, ratioText, recordsPerSecond, type DiversityLevel, type Reading } from './weather';

/** How long Poe's bubble stays up. */
export const ALERT_MS = 9000;
/** From one alert to the next, at least. */
export const GAP_MS = 60_000;
/** Records in the last minute before an app this visit hasn't heard counts as blowing in. */
export const ARRIVAL_MIN = 5;
/** A storm, or a more mixed sky, alerts at most this often. */
export const COOLDOWN_MS = 10 * 60_000;
/** A queued alert older than this is old news. */
export const STALE_MS = 90_000;
/** How soon to ask again while Poe is busy or the tab is hidden. */
export const RETRY_MS = 5000;
export const MAX_QUEUE = 2;
export const ALERTS_KEY = 'weather:alerts';

export type AlertKind = 'arrival' | 'new' | 'storm' | 'mixed';

export interface WeatherAlert {
  kind: AlertKind;
  label: string;
  text: string;
  sub: string;
}

/** Which alert wins a place in a full queue. */
const RANK: Record<AlertKind, number> = { storm: 3, new: 2, mixed: 1, arrival: 0 };
/** Poe's face while it says each one. */
const FACE: Record<AlertKind, MascotFace> = { storm: 'wow', new: 'happy', mixed: 'wink', arrival: 'kawaii' };
const COOLS_DOWN: ReadonlySet<AlertKind> = new Set(['storm', 'mixed']);
const LEVELS: DiversityLevel[] = ['low', 'moderate', 'high', 'very high', 'extreme'];

// ---------- what's worth an alert ----------

export interface Watch {
  /** Apps this visit has already seen in the live readings. */
  seen: Set<string>;
  condition: Reading['condition'];
  level: DiversityLevel | null;
}

/**
 * What changed between the last reading and this one, as alerts, busiest first, and the
 * state to compare the next reading with. `prev` null is the visit's first reading.
 */
export function alertsFor(prev: Watch | null, r: Reading): { watch: Watch; alerts: WeatherAlert[] } {
  const apps = r.source === 'station' ? (r.apps ?? []) : [];
  const watch: Watch = { seen: new Set(prev?.seen), condition: r.condition, level: r.diversity?.level ?? null };
  const fresh = apps.filter((a) => !watch.seen.has(a.domain) && a.count >= ARRIVAL_MIN);
  for (const a of apps) watch.seen.add(a.domain);
  if (!prev) return { watch, alerts: [] };
  const alerts: WeatherAlert[] = [];
  if (r.condition === 'stormy' && prev.condition !== 'stormy') {
    alerts.push({ kind: 'storm', label: 'storm warning', text: 'whoa, a storm just rolled in', sub: `${Math.round(recordsPerSecond(r))} new records a second. somebody said something.` });
  }
  const level = r.diversity?.level;
  if (level && prev.level && LEVELS.indexOf(level) > LEVELS.indexOf(prev.level) && r.records) {
    const d = r.diversity!;
    const why = d.share !== undefined && d.spread !== undefined ? diversityText({ share: d.share, spread: d.spread }) : ratioText(r.records);
    alerts.push({ kind: 'mixed', label: 'weather alert', text: `the sky's getting mixed: ${level}`, sub: `diversity index ${formatIndex(d.index)}. ${why}.` });
  }
  const app = fresh[0];
  if (app) {
    const records = `${app.count.toLocaleString('en-US')} records in the last minute`;
    alerts.push({ kind: 'arrival', label: 'weather alert', text: `${app.domain} just blew in`, sub: app.collections[0] ? `${records}: ${app.collections[0]}` : records });
  }
  return { watch, alerts };
}

/** An alert for an app the station has just heard for the very first time. */
export function newAppAlert(domain: string, at: string): WeatherAlert {
  return { kind: 'new', label: 'new in the atmosphere', text: `${domain} is brand new here (◕‿◕)`, sub: `the station heard it for the first time at ${at}.` };
}

// ---------- hushing ----------

export function alertsHushed(win: Window = window): boolean {
  try {
    return win.localStorage.getItem(ALERTS_KEY) === 'off';
  } catch {
    return false;
  }
}

export function setAlertsHushed(hushed: boolean, win: Window = window): void {
  try {
    if (hushed) win.localStorage.setItem(ALERTS_KEY, 'off');
    else win.localStorage.removeItem(ALERTS_KEY);
  } catch {
    // a private window: the hush lasts for this page only
  }
}

// ---------- Poe says them ----------

export interface AlertDesk {
  push(alert: WeatherAlert): void;
  /** True once the reader has hushed alerts. */
  readonly hushed: boolean;
  hush(): void;
  unhush(): void;
  /** Called with the new state whenever it changes (the hush button follows it). */
  onHushChange(fn: (hushed: boolean) => void): void;
}

interface Queued {
  alert: WeatherAlert;
  /** When it was pushed, and in what order. */
  at: number;
  n: number;
}

/** The alerts, said by Poe. `speak` and `now` are for tests. */
export function createAlertDesk(win: Window = window, speak: (line: PoeLine) => PoeSpeech | null = say, now: () => number = () => Date.now()): AlertDesk {
  let hushed = alertsHushed(win);
  let queue: Queued[] = [];
  let pushed = 0;
  let speech: PoeSpeech | null = null;
  let lastShown = -Infinity;
  const lastOfKind = new Map<AlertKind, number>();
  let wait: number | undefined;
  const listeners: Array<(hushed: boolean) => void> = [];

  const later = (ms: number) => {
    wait = win.setTimeout(next, ms);
  };

  function next(): void {
    win.clearTimeout(wait);
    wait = undefined;
    if (speech || hushed) return;
    const t = now();
    queue = queue.filter((q) => t - q.at < STALE_MS);
    const first = queue[0];
    if (!first) return;
    if (lastShown + GAP_MS > t) return later(lastShown + GAP_MS - t);
    if (win.document.visibilityState === 'hidden') return later(RETRY_MS);
    const { alert } = first;
    const line: PoeLine = {
      label: alert.label,
      text: alert.text,
      sub: alert.sub,
      face: FACE[alert.kind],
      ms: ALERT_MS,
      action: { label: 'hush alerts', run: () => desk.hush() },
      onGone: () => {
        speech = null;
        next();
      },
    };
    if (alert.kind === 'new') line.burst = 'leaves';
    const said = speak(line);
    // Poe's busy: its panel is open, or its nudge is up.
    if (!said) return later(RETRY_MS);
    queue.shift();
    speech = said;
    lastShown = t;
  }

  const desk: AlertDesk = {
    push(alert) {
      if (hushed) return;
      const t = now();
      if (COOLS_DOWN.has(alert.kind)) {
        const last = lastOfKind.get(alert.kind);
        if (last !== undefined && t - last < COOLDOWN_MS) return;
        lastOfKind.set(alert.kind, t);
      }
      queue.push({ alert, at: t, n: pushed++ });
      // Keep the most important ones; among equals, the newest. Say them most important first.
      queue = queue
        .sort((x, y) => RANK[y.alert.kind] - RANK[x.alert.kind] || y.n - x.n)
        .slice(0, MAX_QUEUE)
        .sort((x, y) => RANK[y.alert.kind] - RANK[x.alert.kind] || x.n - y.n);
      next();
    },
    get hushed() {
      return hushed;
    },
    hush() {
      hushed = true;
      setAlertsHushed(true, win);
      queue = [];
      win.clearTimeout(wait);
      const showing = speech;
      speech = null;
      showing?.close();
      listeners.forEach((fn) => fn(true));
    },
    unhush() {
      hushed = false;
      setAlertsHushed(false, win);
      listeners.forEach((fn) => fn(false));
    },
    onHushChange(fn) {
      listeners.push(fn);
    },
  };
  return desk;
}
