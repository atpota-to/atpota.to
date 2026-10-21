/**
 * What Poe says on stream, and how often: the weather alerts from the report
 * (weather-alerts.ts alertsFor), its answer to "!weather", hellos to chatters, thanks to
 * new followers, and something back when someone pets it or calls its name.
 *
 * Handles are the only names said. A chatter's own words never are.
 */

import type { MascotFace } from '../scripts/mascot';
import type { AlertKind, WeatherAlert } from '../scripts/weather-alerts';
import { CONDITION_TEXT, formatIndex, recordsPerSecond, type Reading } from '../scripts/weather';
import type { OverlayLine } from './poe';

const ALERT_FACE: Record<AlertKind, MascotFace> = { record: 'wow', storm: 'wow', new: 'happy', clear: 'happy', mixed: 'wink', arrival: 'kawaii' };

/** A weather alert, at most once every COOLDOWN_MS per kind (arrivals every ARRIVAL_EVERY_MS). */
export const COOLDOWN_MS = 10 * 60_000;
export const ARRIVAL_EVERY_MS = 3 * 60_000;
/** One person's command, at most this often; anyone's same command, at most COMMAND_ANY_MS. */
export const COMMAND_EACH_MS = 30_000;
export const COMMAND_ANY_MS = 8000;

export const RANK = { follow: 3, alert: 2, command: 2, hello: 1 } as const;

export function alertLine(alert: WeatherAlert): OverlayLine {
  return { label: alert.label, text: alert.text, sub: alert.sub, face: ALERT_FACE[alert.kind], rank: RANK.alert, burst: alert.kind === 'clear' ? 'petals' : undefined };
}

export function weatherLine(r: Reading | null, who: string | null): OverlayLine {
  if (!r) return { label: 'weather report', text: "the sky's hard to read right now. try again in a bit", face: 'scawy', rank: RANK.command };
  const rate = Math.round(recordsPerSecond(r)).toLocaleString('en-US');
  const d = r.diversity;
  return {
    label: who ? `weather report for ${who}` : 'weather report',
    text: CONDITION_TEXT[r.condition],
    sub: `${rate} new records a second, every app${d ? `. diversity index ${formatIndex(d.index)}, ${d.level}` : ''}. atpota.to/weather`,
    face: r.condition === 'stormy' ? 'wow' : 'happy',
    rank: RANK.command,
  };
}

const HELLOS = ['hi {who}! welcome in (◕‿◕)', 'oh hey {who}! pull up a chair', '{who} is here! hello hello', 'welcome, {who}! the weather is lovely in here'];
const POE_LINES = ['hi! i am poe. a potato, mostly', 'did somebody say potato?', "i'm watching the sky for you (◕‿◕)", 'type !weather and i will read you the atmosphere', 'blink twice if you like potatoes'];

const pick = (list: readonly string[], random: () => number) => list[Math.floor(random() * list.length)] ?? list[0]!;
const fill = (s: string, who: string | null) => s.replaceAll('{who}', who ?? 'friend');

export function helloLine(who: string | null, random: () => number = Math.random): OverlayLine {
  return { label: 'in the chat', text: fill(pick(HELLOS, random), who), face: 'happy', wave: true, rank: RANK.hello };
}

export function followLine(who: string | null): OverlayLine {
  return { label: 'new follower', text: `${who ?? 'someone'} just followed! thank you (◕‿◕)`, face: 'kawaii', hop: true, burst: 'leaves', rank: RANK.follow };
}

export function petLine(who: string | null): OverlayLine {
  return { label: 'pets', text: `hehe. thank you ${who ?? 'friend'} (◕ᴗ◕✿)`, face: 'kawaii', hop: true, burst: 'hearts', rank: RANK.command };
}

export function poeLine(random: () => number = Math.random): OverlayLine {
  return { text: pick(POE_LINES, random), face: 'wink', rank: RANK.command };
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
