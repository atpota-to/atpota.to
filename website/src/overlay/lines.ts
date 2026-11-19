/**
 * What Poe says on stream, and how often: the weather alerts from the report
 * (weather-alerts.ts alertsFor), its answers to "!weather", "!forecast" and "!apps", hellos
 * (and welcome-backs) to chatters, thanks to new followers, a cheer when the stream goes
 * live and a goodbye when it ends, and something back when someone pets it or calls its
 * name.
 *
 * Handles are the only names said. A chatter's own words never are.
 */

import type { MascotFace } from '../scripts/mascot';
import type { AlertKind, WeatherAlert } from '../scripts/weather-alerts';
import { forecastWords, type Forecast } from '../scripts/weather-forecast';
import { CONDITION_TEXT, formatIndex, formatRate, recordsPerSecond, type Reading } from '../scripts/weather';
import type { Who } from './chat';
import type { OverlayLine } from './poe';

const ALERT_FACE: Record<AlertKind, MascotFace> = { record: 'wow', storm: 'wow', new: 'happy', newhost: 'happy', clear: 'happy', mixed: 'wink', moving: 'wink', host: 'kawaii', arrival: 'kawaii' };

/** A weather alert, at most once every COOLDOWN_MS per kind (arrivals every ARRIVAL_EVERY_MS). */
export const COOLDOWN_MS = 10 * 60_000;
export const ARRIVAL_EVERY_MS = 3 * 60_000;
/** One person's command, at most this often; anyone's same command, at most COMMAND_ANY_MS. */
export const COMMAND_EACH_MS = 30_000;
export const COMMAND_ANY_MS = 8000;
/** How many apps "!apps" names. */
export const APPS_SAID = 3;

/** dame.is: "!pet" in this chat counts on the garden's pets leaderboard (garden/src/records.js PETS_STREAMER). */
export const PETS_STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';

export const RANK = { live: 4, follow: 3, alert: 2, command: 2, hello: 1 } as const;

export function alertLine(alert: WeatherAlert): OverlayLine {
  const line: OverlayLine = { label: alert.label, text: alert.text, sub: alert.sub, face: ALERT_FACE[alert.kind], rank: RANK.alert, sound: 'alert' };
  if (alert.kind === 'clear') line.burst = 'petals';
  return line;
}

const reportFor = (who: Who) => (who.handle ? `weather report for ${who.handle}` : 'weather report');
const hardToRead = (label: string): OverlayLine => ({ label, text: "the sky's hard to read right now. try again in a bit", face: 'scawy', rank: RANK.command });

export function weatherLine(r: Reading | null, who: Who): OverlayLine {
  if (!r) return hardToRead(reportFor(who));
  const rate = Math.round(recordsPerSecond(r)).toLocaleString('en-US');
  const d = r.diversity;
  return {
    label: reportFor(who),
    text: CONDITION_TEXT[r.condition],
    sub: `${rate} new records a second, every app${d ? `. diversity index ${formatIndex(d.index)}, ${d.level}` : ''}. atpota.to/weather`,
    face: r.condition === 'stormy' ? 'wow' : 'happy',
    avatar: who.avatar,
    rank: RANK.command,
  };
}

export function forecastLine(f: Forecast | null, who: Who): OverlayLine {
  const label = who.handle ? `forecast for ${who.handle}` : 'forecast';
  if (!f) return hardToRead(label);
  if (f.learning || f.hours.length === 0) return { label, text: "i'm still learning the sky's habits. ask me again tomorrow", face: 'sleepy', avatar: who.avatar, rank: RANK.command };
  return { label, text: forecastWords(f.hours), sub: 'the next few hours of the atmosphere. atpota.to/weather', face: 'kawaii', avatar: who.avatar, rank: RANK.command };
}

export function appsLine(r: Reading | null, who: Who): OverlayLine {
  const label = who.handle ? `apps for ${who.handle}` : 'busy outside bluesky';
  if (!r) return hardToRead(label);
  const apps = (r.apps ?? []).slice(0, APPS_SAID);
  if (apps.length === 0) return { label, text: "it's all bluesky out there right now", face: 'wink', avatar: who.avatar, rank: RANK.command };
  const names = apps.map((a) => a.domain);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return {
    label,
    text: `busiest outside bluesky: ${list}`,
    sub: apps.map((a) => `${a.domain} ${formatRate(a.perSecond)}/sec`).join(' · '),
    face: 'happy',
    avatar: who.avatar,
    rank: RANK.command,
  };
}

const HELLOS = ['hi {who}! welcome in (◕‿◕)', 'oh hey {who}! pull up a chair', '{who} is here! hello hello', 'welcome, {who}! the weather is lovely in here'];
const WELCOME_BACKS = ['welcome back, {who}! (◕‿◕)', '{who}! good to see you again', 'look who it is! hi again {who}'];
const POE_LINES = ['hi! i am poe. a potato, mostly', 'did somebody say potato?', "i'm watching the sky for you (◕‿◕)", 'try !weather, !forecast or !apps and i will read you the atmosphere', 'blink twice if you like potatoes'];

const pick = (list: readonly string[], random: () => number) => list[Math.floor(random() * list.length)] ?? list[0]!;
const fill = (s: string, who: Who) => s.replaceAll('{who}', who.handle ?? 'friend');

export function helloLine(who: Who, again = false, random: () => number = Math.random): OverlayLine {
  return { label: 'in the chat', text: fill(pick(again ? WELCOME_BACKS : HELLOS, random), who), face: 'happy', avatar: who.avatar, wave: true, sound: 'hello', rank: RANK.hello };
}

export function followLine(who: Who): OverlayLine {
  return { label: 'new follower', text: `${who.handle ?? 'someone'} just followed! thank you (◕‿◕)`, face: 'kawaii', avatar: who.avatar, hop: true, burst: 'leaves', sound: 'follow', rank: RANK.follow };
}

/** `counts`: the pet also counts on atpota.to's pets leaderboard (the garden index counts !pet in dame.is's chat). */
export function petLine(who: Who, counts = false): OverlayLine {
  const line: OverlayLine = { label: 'pets', text: `hehe. thank you ${who.handle ?? 'friend'} (◕ᴗ◕✿)`, face: 'kawaii', avatar: who.avatar, hop: true, burst: 'hearts', sound: 'pet', rank: RANK.command };
  if (counts) line.sub = 'one pet an hour counts on the pets leaderboard at atpota.to/garden';
  return line;
}

export function poeLine(random: () => number = Math.random): OverlayLine {
  return { text: pick(POE_LINES, random), face: 'wink', rank: RANK.command };
}

export function liveLine(title: string | null): OverlayLine {
  const line: OverlayLine = { label: "we're live", text: "we're live! hi everyone (◕‿◕)", face: 'happy', wave: true, burst: 'leaves', sound: 'live', rank: RANK.live, ms: 9000 };
  if (title) line.sub = title;
  return line;
}

export function endedLine(): OverlayLine {
  return { label: "that's a wrap", text: 'thanks for watching! see you next time', face: 'happy', wave: true, sound: 'hello', rank: RANK.live, ms: 9000 };
}

/** Says yes to something at most once every `ms` per key. */
export function createGate(now: () => number = () => Date.now()): (key: string, ms: number) => boolean {
  const last = new Map<string, number>();
  return (key, ms) => {
    const t = now();
    const at = last.get(key);
    if (at !== undefined && t - at < ms) return false;
    last.set(key, t);
    return true;
  };
}
