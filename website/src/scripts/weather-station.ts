/**
 * How the weather station is doing, as a line under the report's title: whether what's on
 * the page is the station's live minute, and whether it's still filling in minutes it
 * missed (atmosphere/src/repair.js hears them again from Jetstream's lookback; the trends
 * show them as gaps until then). A tap opens the line to say more.
 */

import type { Reading } from './weather';
import { formatCount } from './weather';

/** ok: live and whole. mending: live, filling in minutes it missed. behind: live but not keeping up. sample: the station isn't answering. down: no reading at all. */
export type StationLevel = 'ok' | 'mending' | 'behind' | 'sample' | 'down';

export interface StationStatus {
  level: StationLevel;
  label: string;
  detail: string;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const time = (iso: string) => TIME.format(new Date(iso)).toLowerCase();
const minutes = (n: number) => `${formatCount(n)} minute${n === 1 ? '' : 's'}`;

export function stationStatus(r: Reading | null): StationStatus {
  if (!r) return { level: 'down', label: 'station unreachable', detail: "i can't reach the firehose right now, so nothing up here is live. i'll keep trying." };
  if (r.source === 'sample') {
    return {
      level: 'sample',
      label: 'station offline',
      detail: "my weather station isn't answering, so this is a quick few-second sample of the firehose instead. the trends will have a gap until it's back, and it fills in what it can once it is.",
    };
  }
  const h = r.health;
  if (!h) return { level: 'ok', label: 'station live', detail: 'my weather station is listening to the whole firehose, live.' };
  const lost = h.lost ? ` ${minutes(h.lost)} from the last day or so are gone for good: the firehose doesn't remember back that far.` : '';
  if (!h.ok) {
    const lag = h.lagSeconds !== null && h.lagSeconds >= 10 ? `, ${formatCount(Math.round(h.lagSeconds))} seconds behind` : '';
    return {
      level: 'behind',
      label: 'station catching up',
      detail: `my weather station is struggling to keep up (it heard ${h.covered60} of the last 60 seconds${lag}), so the numbers may read low for a bit. it only saves minutes it heard whole, and hears the rest again once it's caught up.`,
    };
  }
  const missing = h.missing ?? 0;
  if (h.repairing || missing > 0) {
    const now = h.repairing ? ` right now it's on ${time(h.repairing.from)} to ${time(h.repairing.to)}.` : '';
    return {
      level: 'mending',
      label: missing > 0 ? `filling in ${minutes(missing)}` : 'filling in missed minutes',
      detail: `my weather station is live, and it's hearing again the minutes it missed earlier, from the firehose's memory.${now} the trends show them as gaps until it's done.${lost}`,
    };
  }
  return { level: 'ok', label: 'station healthy', detail: `my weather station is live and heard every second of the last minute.${lost}` };
}

/** Fills the line ([data-station]): its level, its label and what it says when opened. */
export function renderStation(root: ParentNode, r: Reading | null): void {
  const el = root.querySelector<HTMLElement>('[data-station]');
  if (!el) return;
  const s = stationStatus(r);
  el.dataset.level = s.level;
  el.hidden = false;
  const label = el.querySelector('[data-station-label]');
  if (label) label.textContent = s.label;
  const detail = el.querySelector('[data-station-detail]');
  if (detail) detail.textContent = s.detail;
}
