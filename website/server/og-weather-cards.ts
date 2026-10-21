/**
 * The weather report's Open Graph cards (server/og-weather.ts draws them): four ways to show
 * the sky on a 1200x630 card, from the same numbers /weather shows, and a quiet card for when
 * there are no numbers to show.
 *
 *   forecast  the report's header as a card: new records a second, the condition, a sky
 *             that clouds over with the diversity index, and Poe on its hill saying how mixed
 *             the sky is
 *   trend     the last 24 hours of new records a second as a chart, with the busiest and
 *             quietest hours marked
 *   mix       who else is in the sky: the diversity index on its scale, and the busiest apps
 *             outside Bluesky over the last 24 hours
 *   today     the almanac: the last hour against usual on the barometer, today's range with
 *             the last hour on it, and today's totals
 *
 * Each card is a satori element tree, built here from plain objects (no React). A card that
 * can't be drawn from what was read (its numbers didn't come) is null, and the caller draws
 * the quiet card. Words follow the page (src/scripts/weather.ts, weather-almanac.ts);
 * tests/og-weather.test.ts checks the copies against it. App names are other people's text:
 * they arrive checked against DOMAIN_RE and only ever become text, which satori draws as paths.
 */

import { conditionFor, diversityLevel, type Condition, type DiversityLevel, type Reading } from './atmosphere.js';
import { NEW_APPS, type NewApps, type Normal, type Today } from './weather-almanac.js';
import type { Accounts } from './weather-accounts.js';
import type { App as HistoryApp, Point } from './weather-history.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export const CARDS = ['forecast', 'trend', 'mix', 'today'] as const;
export type CardName = (typeof CARDS)[number];
/** The card /og/weather.png draws without ?card=. */
export const DEFAULT_CARD: CardName = 'forecast';

export function isCard(name: string | null): name is CardName {
  return name !== null && (CARDS as readonly string[]).includes(name);
}

// ---------- what a card is drawn from ----------

/** /api/weather-history?range=day, as its handler answers it. */
export interface DayHistory {
  points: Point[];
  apps?: HistoryApp[];
  accounts?: Accounts;
}

/** /api/weather-almanac?tz=UTC, as its handler answers it. */
export interface AlmanacData {
  today?: Today;
  normal?: Normal;
  newApps?: NewApps;
}

export interface CardData {
  /** When the card is drawn (ms). */
  at: number;
  /** The weather station's last 60 seconds. */
  now: Reading | null;
  day: DayHistory | null;
  almanac: AlmanacData | null;
}

export type MascotFace = 'happy' | 'sleepy' | 'wow' | 'scawy' | 'kawaii' | 'wink';

/** The pictures the cards use, as data: URIs (server/og-weather.ts reads them from src/assets). */
export interface Art {
  /** The atpotato wordmark, in a colour. */
  wordmark(color: string): string;
  mascot(face: MascotFace): string;
}

// ---------- the page's words (src/scripts/weather.ts, weather-almanac.ts) ----------

export const CONDITION_TEXT: Record<Condition, string> = {
  calm: 'calm. a quiet moment in the atmosphere',
  light: 'a light breeze. a quiet spell',
  breezy: 'breezy. a usual day in the atmosphere',
  gusty: 'gusty. lots going on out there',
  stormy: 'stormy. somebody said something',
};

export const LEVEL_TEXT: Record<DiversityLevel, string> = {
  low: 'mostly bluesky out there',
  moderate: 'a good mix of apps in the air',
  high: 'lots of other apps about',
  'very high': 'the atmosphere is really mixing it up',
  extreme: 'bluesky is barely the weather today',
};

/** Where each diversity level starts (weather.ts DIVERSITY_SCALE). */
export const DIVERSITY_SCALE: ReadonlyArray<readonly [DiversityLevel, number]> = [
  ['low', 0],
  ['moderate', 3],
  ['high', 6],
  ['very high', 8],
  ['extreme', 11],
];
/** Where the scale's last band ends on the card. */
const SCALE_TOP = 14;

/** Where "much quieter" ... "much busier" than usual meet (weather-almanac.ts USUAL_EDGES). */
export const USUAL_EDGES = [0.8, 0.93, 1.08, 1.25] as const;

/** Clouds in the sky for a diversity index (weather-sky.ts cloudCount). */
export const MAX_CLOUDS = 8;
export function cloudCount(index: number): number {
  if (!(index > 0)) return 0;
  return Math.max(1, Math.round(MAX_CLOUDS * Math.sqrt(Math.min(index, 11) / 11)));
}

/** "1.6 million", "171,986" (weather-almanac.ts bigNumber). */
export function bigNumber(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} billion`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
  return Math.round(v).toLocaleString('en-US');
}

/** "+18%", "−7%", "±0%" (weather-almanac.ts changeText). */
export function changeText(ratio: number): string {
  const pct = Math.round((ratio - 1) * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : '±0%';
}

/** The diversity index as the page writes it (weather.ts formatIndex). */
export function formatIndex(index: number): string {
  return index < 1 ? index.toFixed(2) : index < 10 ? index.toFixed(1) : String(Math.round(index));
}

const int = (n: number) => Math.round(n).toLocaleString('en-US');

// ---------- what the numbers say ----------

export interface Usual {
  /** The last hour's records a second over usual's. */
  ratio: number;
  /** "busier than usual" */
  how: string;
  /** "for this time of the week" */
  when: string;
  rate: number;
  usual: number;
}

/**
 * The last hour against usual (weather-almanac.ts usualText), without a time zone: a card is
 * for everyone, so "for this time of the week" rather than "for a tuesday afternoon". Null
 * while the station is still learning what usual looks like.
 */
export function usualOf(normal: Normal | undefined): Usual | null {
  if (!normal) return null;
  const basis = normal.weeks.windows > 0 ? 'weeks' : normal.days.windows > 0 ? 'days' : null;
  if (!basis || normal.now.seconds < 1800) return null;
  const base = normal[basis];
  if (!(base.seconds > 0)) return null;
  const rate = normal.now.creates / normal.now.seconds;
  const usual = base.creates / base.seconds;
  const ratio = usual > 0 ? rate / usual : 1;
  const [muchQuieter, quieter, busier, muchBusier] = USUAL_EDGES;
  const how =
    ratio >= muchBusier
      ? 'much busier than usual'
      : ratio >= busier
        ? 'busier than usual'
        : ratio <= muchQuieter
          ? 'much quieter than usual'
          : ratio <= quieter
            ? 'quieter than usual'
            : 'about as busy as usual';
  return { ratio, how, when: basis === 'weeks' ? 'for this time of the week' : 'for this time of day', rate, usual };
}

export interface Hour {
  t: number;
  /** New records a second over the hour (all apps). */
  rate: number;
}

/** The last 24 hours, an hour a point, as rates; hours the station barely heard are left out. */
export function hoursOf(day: DayHistory | null): Hour[] {
  return (day?.points ?? []).filter((p) => p.seconds >= 120).map((p) => ({ t: Date.parse(p.t), rate: p.creates / p.seconds }));
}

/** New records a second right now: the station's 60 seconds, else the newest hour. */
function recordsNow(d: CardData): { rate: number; live: boolean } | null {
  if (d.now) return { rate: d.now.records.perSecond, live: true };
  const last = hoursOf(d.day).at(-1);
  return last && d.at - last.t < 2 * 3600_000 ? { rate: last.rate, live: false } : null;
}

interface Mix {
  index: number;
  level: DiversityLevel;
  share: number;
  spread: number;
  /** Active accounts, when known. */
  active: number | null;
  /** "just now" (the station's minute) or "over the last 24 hours". */
  span: string;
}

/** The diversity index: the station's minute, else the last 24 hours' accounts. */
function mixOf(d: CardData): Mix | null {
  const div = d.now?.diversity;
  if (div && div.share !== undefined && div.spread !== undefined) {
    return { index: div.index, level: div.level, share: div.share, spread: div.spread, active: d.now?.accounts?.active ?? null, span: 'just now' };
  }
  const total = d.day?.accounts?.total;
  if (total) return { index: total.index, level: diversityLevel(total.index), share: total.share, spread: total.spread, active: total.active, span: 'over the last 24 hours' };
  return null;
}

const FACE: Record<Condition, MascotFace> = { calm: 'sleepy', light: 'happy', breezy: 'happy', gusty: 'wow', stormy: 'scawy' };

/** "wed 21 oct, 12:11 utc" */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '').toLowerCase();
  const time = d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  return `${day}, ${time} utc`;
}

// ---------- drawing ----------

export type Style = Record<string, string | number>;
export interface El {
  type: string;
  props: { style?: Style; children?: Kid | Kid[]; src?: string; width?: number; height?: number };
}
type Kid = El | string;

const C = {
  bg: '#F4EEDF',
  paper: '#FFFDF7',
  card: '#FFFFFF',
  ink: '#3D2F1B',
  soft: '#5E4D33',
  muted: '#6B5A3E',
  brown: '#725B36',
  brownOnSky: '#5A4527',
  skin: '#A58650',
  line: '#EFE4C8',
  lineStrong: '#E6D9B6',
  sky: '#B3DDF0',
  skyText: '#2C3A3E',
  skyMono: '#34505B',
  cloud: 'rgba(255, 255, 255, 0.72)',
  sun: '#FFD978',
  sunRing: '#F2AE3A',
  sunShine: 'rgba(255, 253, 247, 0.85)',
  leaf: '#006837',
  vine: '#39B54A',
  sage: '#C5E3B0',
  leafTint: '#E2F0D6',
  bsky: '#1A73C9',
} as const;

function h(style: Style, ...kids: Array<Kid | null | false | undefined>): El {
  const children = kids.filter((k): k is Kid => k !== null && k !== false && k !== undefined && k !== '');
  return { type: 'div', props: { style: { display: 'flex', ...style }, children } };
}

function img(src: string, width: number, height: number, style: Style = {}): El {
  return { type: 'img', props: { src, width, height, style } };
}

/** An SVG of our own (shapes and numbers only, never text) as a picture. */
export function svgImage(svg: string, width: number, height: number, style: Style = {}): El {
  return img(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width, height, style);
}

/** The card itself: the site's paper-coloured page with the tiles on it. */
function page(...kids: Array<El | null | false>): El {
  return h({ width: CARD_WIDTH, height: CARD_HEIGHT, padding: 28, gap: 16, background: C.bg, fontFamily: 'signika', color: C.ink }, ...kids);
}

function tile(style: Style, ...kids: Array<Kid | null | false | undefined>): El {
  return h({ position: 'relative', flexDirection: 'column', borderRadius: 40, overflow: 'hidden', ...style }, ...kids);
}

function wordmark(art: Art, color: string = C.brown, height = 38): El {
  return img(art.wordmark(color), Math.round((height * 874) / 218), height);
}

function chip(text: string, style: Style = {}): El {
  return h(
    { alignItems: 'center', height: 44, padding: '0 20px', borderRadius: 999, background: C.card, color: C.soft, fontSize: 22, fontWeight: 600, ...style },
    text,
  );
}

/** The top of every card: the wordmark and what the card is. */
function masthead(art: Art, label: string, color: string = C.brown, chipStyle: Style = {}): El {
  return h({ alignItems: 'center', gap: 18 }, wordmark(art, color), chip(label, chipStyle));
}

/** The bottom line: where to look, and when the numbers are from. */
function footer(d: CardData, color: string = C.muted): El {
  return h(
    { alignItems: 'center', gap: 12, fontSize: 22, color },
    h({ fontWeight: 700, color: C.leaf }, 'atpota.to/weather'),
    h({}, '·'),
    h({}, `as of ${stamp(d.at)}`),
  );
}

function big(text: string, size: number, style: Style = {}): El {
  return h({ fontSize: size, fontWeight: 700, lineHeight: 0.9, letterSpacing: '-0.03em', ...style }, text);
}

/** A labelled number in a little box. */
function stat(label: string, value: string, sub: string | null, style: Style = {}): El {
  return h(
    { flexDirection: 'column', padding: '16px 22px', borderRadius: 24, background: C.paper, minWidth: 0, ...style },
    h({ fontSize: 20, color: C.muted }, label),
    h({ fontSize: 40, fontWeight: 700, marginTop: 4, letterSpacing: '-0.02em' }, value),
    sub ? h({ fontSize: 20, color: C.muted, marginTop: 2 }, sub) : null,
  );
}

// ---------- the sky: sun, clouds, Poe on its hill ----------

const SUN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  `<g fill="none" stroke="${C.sunRing}" stroke-linecap="round"><path stroke-width="7" d="M50 6 V15 M50 85 V94 M6 50 H15 M85 50 H94"/>` +
  '<path stroke-width="6" d="M21.7 21.7 L25.3 25.3 M74.7 74.7 L78.3 78.3 M78.3 21.7 L74.7 25.3 M21.7 78.3 L25.3 74.7"/></g>' +
  `<path fill="${C.sun}" stroke="${C.sunRing}" stroke-width="5" stroke-linejoin="round" d="M51 26.5 C64.5 27 74 37 73.5 50.5 C73 64 63.5 73.5 49.5 73.5 C36 73 26.5 63.5 26.5 49.5 C27 36 37.5 26 51 26.5 Z"/>` +
  `<path fill="none" stroke="${C.sunShine}" stroke-width="4" stroke-linecap="round" d="M36 47 C37 41 41 37 46.5 35.5"/>` +
  `<circle fill="${C.sunShine}" cx="35.5" cy="53" r="2.2"/></svg>`;

function sun(size: number, style: Style = {}): El {
  return svgImage(SUN_SVG, size, size, style);
}

/**
 * Where the clouds sit (the middle of each, as fractions of the sky, and their size), filled
 * in this order. Like the page's slots (weather-sky.ts), but kept off the big number, so it
 * reads at the size a feed shows the card.
 */
const CLOUD_SLOTS: ReadonlyArray<{ x: number; y: number; s: number }> = [
  { x: 0.88, y: 0.05, s: 0.9 },
  { x: 0.5, y: 0.22, s: 0.7 },
  { x: 0.87, y: 0.4, s: 0.65 },
  { x: 0.62, y: 0.6, s: 0.6 },
  { x: 0.66, y: 0.06, s: 0.5 },
  { x: 0.99, y: 0.58, s: 0.6 },
  { x: 0.02, y: 0.3, s: 0.55 },
  { x: 0.42, y: 0.66, s: 0.5 },
];

/** `count` clouds over a sky of width x height, like the page's (a pill with two puffs on top). */
export function cloudsSvg(count: number, width: number, height: number, scale = 1.6): string {
  const clouds = CLOUD_SLOTS.slice(0, Math.max(0, Math.min(MAX_CLOUDS, count)))
    .map(({ x, y, s }) => {
      const k = s * scale;
      const w = 110 * k;
      const cx = x * width - w / 2;
      const cy = y * height + 22 * k;
      return (
        `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${k.toFixed(3)})">` +
        '<rect x="0" y="0" width="110" height="32" rx="16"/><circle cx="41" cy="1" r="23"/><circle cx="71" cy="3" r="17"/></g>'
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><g fill="${C.cloud}">${clouds}</g></svg>`;
}

/** Poe on a dirt hill in the corner of a tile, with something to say. */
function poeOnHill(art: Art, face: MascotFace, says: string | null, width: number): Array<El | null> {
  const potato = 320;
  return [
    h({ position: 'absolute', left: width - 560, width: 760, bottom: -70, height: 190, borderRadius: '50%', background: C.skin }),
    img(art.mascot(face), potato, Math.round((potato * 419) / 515), { position: 'absolute', right: 14, bottom: 46 }),
    says
      ? h(
          {
            position: 'absolute',
            right: 214,
            bottom: 262,
            maxWidth: 360,
            padding: '14px 20px',
            borderRadius: '22px 22px 6px 22px',
            background: C.card,
            color: C.soft,
            fontSize: 23,
            fontWeight: 700,
            lineHeight: 1.25,
          },
          says,
        )
      : null,
  ];
}

// ---------- the cards ----------

function forecast(d: CardData, art: Art): El | null {
  const now = recordsNow(d);
  if (!now) return null;
  const condition = d.now?.condition ?? conditionFor(now.rate);
  const mix = mixOf(d);
  const usual = usualOf(d.almanac?.normal);
  const sky = { w: CARD_WIDTH - 56, h: CARD_HEIGHT - 56 };
  const [word, rest] = CONDITION_TEXT[condition].split('. ');
  const number = int(now.rate);
  const onSky: Style = { background: 'rgba(255, 255, 255, 0.8)', color: C.skyText, whiteSpace: 'nowrap' };
  return page(
    tile(
      { width: sky.w, height: sky.h, background: C.sky, color: C.skyText, padding: '46px 54px' },
      svgImage(cloudsSvg(cloudCount(mix?.index ?? 0), sky.w, sky.h), sky.w, sky.h, { position: 'absolute', left: 0, top: 0 }),
      sun(190, { position: 'absolute', right: 330, top: 26 }),
      ...poeOnHill(art, FACE[condition], mix ? LEVEL_TEXT[mix.level] : null, sky.w),
      masthead(art, 'the atmosphere weather report', C.brownOnSky, { background: 'rgba(255, 255, 255, 0.8)', color: C.skyText }),
      h(
        { flexDirection: 'column', marginTop: 'auto', width: 640 },
        h(
          { alignItems: 'flex-end', gap: 14 },
          big(number, number.length <= 3 ? 176 : number.length <= 5 ? 138 : 112, { color: C.ink }),
          h({ fontSize: 42, fontWeight: 700, color: C.ink, paddingBottom: 14 }, 'rec/sec'),
        ),
        h({ fontSize: 44, fontWeight: 700, marginTop: 18, color: C.ink }, `${word}.`),
        // The measured comparison when there is one: the condition's stock phrase ("a quiet
        // spell") can read against it, a light breeze that is still busier than usual.
        h({ fontSize: 30, marginTop: 4 }, usual
          ? `${now.live ? '' : 'over the last hour, '}${usualChip(usual)} ${usual.when}`
          : now.live ? `${rest}, right now` : `${rest}, over the last hour`),
        h(
          { flexWrap: 'wrap', gap: 12, marginTop: 26 },
          mix ? chip(`diversity index ${formatIndex(mix.index)} · ${mix.level}`, onSky) : null,
        ),
        h({ marginTop: 22 }, footer(d, C.skyMono)),
      ),
    ),
  );
}

/** "+20% busier than usual", "−9% quieter than usual", "about as busy as usual": the number says how much. */
export function usualChip(usual: Usual): string {
  if (usual.how.startsWith('about')) return usual.how;
  return `${changeText(usual.ratio)} ${usual.how.replace('much ', '')}`;
}

/** A 24-hour area chart of `hours` in a box of width x height, and where each hour landed. */
export function trendChart(hours: Hour[], from: number, to: number, width: number, height: number, top: number) {
  const pad = { l: 4, r: 4, t: 10, b: 4 };
  const x = (t: number) => pad.l + ((t - from) / (to - from)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const pts = hours.map((p) => ({ x: x(p.t), y: y(p.rate), p }));
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ');
  const base = y(0).toFixed(1);
  const area = pts.length ? `${line} L${pts.at(-1)!.x.toFixed(1)} ${base} L${pts[0]!.x.toFixed(1)} ${base} Z` : '';
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="0" x2="${width}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}" stroke="${C.lineStrong}" stroke-width="2" stroke-dasharray="${f ? '6 8' : ''}"/>`)
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${grid}` +
    `<path d="${area}" fill="${C.bsky}" fill-opacity="0.14"/>` +
    `<path d="${line}" fill="none" stroke="${C.bsky}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return { svg, pts, y };
}

/** A round number at or above the busiest hour, for the chart's top. */
export function chartTop(max: number): number {
  const step = max > 1000 ? 250 : 100;
  return Math.max(step, Math.ceil((max * 1.08) / step) * step);
}

function dot(cx: number, cy: number, color: string, size = 22): El {
  return h({ position: 'absolute', left: cx - size / 2, top: cy - size / 2, width: size, height: size, borderRadius: 999, background: C.card, border: `6px solid ${color}` });
}

function trend(d: CardData, art: Art): El | null {
  const hours = hoursOf(d.day);
  if (hours.length < 6) return null;
  const now = recordsNow(d);
  const busiest = hours.reduce((a, b) => (b.rate > a.rate ? b : a));
  const quietest = hours.reduce((a, b) => (b.rate < a.rate ? b : a));
  const W = 1144 - 100;
  const H = 300;
  const top = chartTop(busiest.rate);
  const chart = trendChart(hours, d.at - 24 * 3600_000, d.at, W, H, top);
  const at = (p: Hour) => chart.pts.find((q) => q.p === p)!;
  const hi = at(busiest);
  const lo = at(quietest);
  const last = chart.pts.at(-1)!;
  const mix = mixOf(d);
  const label = (q: { x: number; y: number }, text: string, above: boolean, color: string) =>
    h(
      {
        position: 'absolute',
        left: Math.min(W - 230, Math.max(0, q.x - 115)),
        top: above ? q.y - 64 : q.y + 22,
        width: 230,
        justifyContent: 'center',
        fontSize: 24,
        fontWeight: 700,
        color,
      },
      text,
    );
  return page(
    tile(
      { width: 1144, height: 574, background: C.paper, padding: '42px 50px 36px' },
      h(
        { justifyContent: 'space-between', alignItems: 'flex-start' },
        h(
          { flexDirection: 'column' },
          masthead(art, 'the last 24 hours', C.brown, { background: C.bg }),
          h({ fontSize: 46, fontWeight: 700, marginTop: 22, letterSpacing: '-0.02em' }, 'new records a second, every app'),
        ),
        now
          ? h(
              { flexDirection: 'column', alignItems: 'flex-end' },
              h({ alignItems: 'flex-end', gap: 10 }, big(int(now.rate), 104, { color: C.bsky }), h({ fontSize: 30, fontWeight: 700, color: C.bsky, paddingBottom: 8 }, 'rec/sec')),
              h({ fontSize: 26, color: C.soft, marginTop: 8 }, `${now.live ? 'right now' : 'the last hour'}: ${CONDITION_TEXT[d.now?.condition ?? conditionFor(now.rate)].split('.')[0]}`),
            )
          : null,
      ),
      h(
        { position: 'relative', width: W, height: H, marginTop: 'auto' },
        svgImage(chart.svg, W, H, { position: 'absolute', left: 0, top: 0 }),
        h({ position: 'absolute', left: 8, top: chart.y(top) + 4, fontSize: 20, color: C.muted }, int(top)),
        h({ position: 'absolute', left: 8, top: chart.y(top / 2) + 4, fontSize: 20, color: C.muted }, int(top / 2)),
        dot(hi.x, hi.y, C.bsky),
        label(hi, `busiest hour ${int(busiest.rate)}`, true, C.bsky),
        quietest !== busiest ? dot(lo.x, lo.y, C.skin) : null,
        quietest !== busiest ? label(lo, `quietest ${int(quietest.rate)}`, lo.y < H - 70 ? false : true, C.brown) : null,
        busiest !== hours.at(-1) && quietest !== hours.at(-1) ? dot(last.x, last.y, C.ink, 18) : null,
      ),
      h(
        { justifyContent: 'space-between', marginTop: 14, fontSize: 21, color: C.muted },
        h({}, '24 hours ago'),
        h({}, '12 hours ago'),
        h({}, 'now'),
      ),
      h(
        { justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
        footer(d),
        mix ? h({ fontSize: 22, color: C.soft }, `diversity index ${formatIndex(mix.index)} · ${mix.level}`) : null,
      ),
    ),
  );
}

/** The diversity scale's five bands, with a marker at `index`. */
function scale(index: number, width: number): El {
  const bands = DIVERSITY_SCALE.map(([name, from], i) => {
    const to = DIVERSITY_SCALE[i + 1]?.[1] ?? SCALE_TOP;
    return { name, w: ((to - from) / SCALE_TOP) * width, o: [0.25, 0.45, 0.65, 0.85, 1][i]! };
  });
  const at = Math.min(1, Math.max(0, index / SCALE_TOP)) * width;
  return h(
    { flexDirection: 'column', width },
    h(
      { position: 'relative', height: 30, gap: 4, alignItems: 'center' },
      ...bands.map((b) => h({ width: b.w - 4, height: 18, borderRadius: 9, background: C.leaf, opacity: b.o })),
      h({ position: 'absolute', left: Math.min(width - 10, Math.max(0, at - 5)), top: 0, width: 10, height: 30, borderRadius: 5, background: C.ink, border: `2px solid ${C.card}` }),
    ),
    h({ marginTop: 8, fontSize: 18, color: C.muted }, ...bands.map((b) => h({ width: b.w }, b.name))),
  );
}

function mixCard(d: CardData, art: Art): El | null {
  const mix = mixOf(d);
  if (!mix) return null;
  const daily = (d.day?.apps ?? []).filter((a) => a.creates > 0).slice(0, 5);
  const live = (d.now?.apps ?? []).filter((a) => a.count > 0).slice(0, 5);
  const apps = daily.length >= 3 ? daily.map((a) => ({ domain: a.domain, n: a.creates })) : live.map((a) => ({ domain: a.domain, n: a.count }));
  const appsSpan = daily.length >= 3 ? 'the last 24 hours' : 'the last minute';
  const top = Math.max(1, ...apps.map((a) => a.n));
  const who =
    mix.active !== null
      ? `${mix.share.toFixed(2)}% of the ${int(mix.active)} accounts active ${mix.span} wrote with other apps, spread across about ${Math.round(mix.spread)} apps' worth.`
      : `${mix.share.toFixed(2)}% of active accounts wrote with other apps ${mix.span}, spread across about ${Math.round(mix.spread)} apps' worth.`;
  const left = apps.length ? 600 : 1144;
  return page(
    tile(
      { width: left, height: 574, background: C.paper, padding: '42px 50px 36px' },
      masthead(art, 'who else is in the sky', C.brown, { background: C.bg }),
      h({ fontSize: 30, fontWeight: 700, marginTop: 'auto' }, 'diversity index'),
      h(
        { alignItems: 'center', gap: 22, marginTop: 4 },
        big(formatIndex(mix.index), 150, { color: C.leaf }),
        h({ flexDirection: 'column' }, h({ fontSize: 40, fontWeight: 700 }, mix.level), h({ fontSize: 24, color: C.soft, marginTop: 4, maxWidth: 260 }, LEVEL_TEXT[mix.level])),
      ),
      h({ marginTop: 20 }, scale(mix.index, left - 100)),
      h({ fontSize: 22, color: C.soft, marginTop: 18, lineHeight: 1.35 }, who),
      h({ marginTop: 18 }, footer(d)),
    ),
    apps.length
      ? tile(
          { width: 1144 - left - 16, height: 574, background: C.leafTint, padding: '40px 40px 36px' },
          h({ fontSize: 30, fontWeight: 700, color: C.leaf }, 'busiest elsewhere'),
          h({ fontSize: 22, color: C.soft, marginTop: 4 }, `new records, ${appsSpan}`),
          h(
            { flexDirection: 'column', gap: 18, marginTop: 'auto' },
            ...apps.map((a) =>
              h(
                { flexDirection: 'column' },
                h(
                  { justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
                  h({ fontSize: 27, fontWeight: 700, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 330 }, a.domain),
                  h({ fontSize: 23, color: C.soft }, bigNumber(a.n)),
                ),
                h(
                  { height: 14, marginTop: 6, borderRadius: 7, background: 'rgba(0, 104, 55, 0.14)' },
                  h({ width: `${Math.max(3, (a.n / top) * 100).toFixed(1)}%`, height: 14, borderRadius: 7, background: C.leaf }),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

/** The barometer (weather-almanac.ts renderGauge): five zones and a needle at `ratio`. */
export function gaugeSvg(ratio: number | null): string {
  const cx = 60;
  const cy = 58;
  const r = 46;
  const at = (t: number) => {
    const a = Math.PI * (1 - t);
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy - r * Math.sin(a)).toFixed(2)}`;
  };
  const edges = [0, ...USUAL_EDGES.map(gaugeAt), 1];
  const zones = [0.16, 0.34, 0.54, 0.76, 1]
    .map((mixIn, i) => {
      const color = mixColor(C.bsky, C.card, mixIn);
      return `<path d="M${at(edges[i]! + 0.012)}A${r} ${r} 0 0 1 ${at(edges[i + 1]! - 0.012)}" fill="none" stroke="${color}" stroke-width="12"/>`;
    })
    .join('');
  const needle =
    ratio === null
      ? ''
      : (() => {
          const t = gaugeAt(ratio);
          const a = Math.PI * (1 - t);
          const tip = `${(cx + (r - 4) * Math.cos(a)).toFixed(2)} ${(cy - (r - 4) * Math.sin(a)).toFixed(2)}`;
          return `<path d="M${cx} ${cy} L${tip}" stroke="${C.ink}" stroke-width="3.5" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="5" fill="${C.ink}"/>`;
        })();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 66">${zones}${needle}</svg>`;
}

/** Where a ratio to usual sits on the barometer, 0 to 1 (weather-almanac.ts gaugeAt). */
export function gaugeAt(ratio: number): number {
  return ratio > 0 ? Math.min(1, Math.max(0, Math.log2(ratio) + 0.5)) : 0;
}

/** CSS color-mix(in srgb, a p, b) for two #rrggbb colours. */
function mixColor(a: string, b: string, p: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p))).join(', ')})`;
}

/** "07:44", a minute's time of day in UTC. */
function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** One line of "today in numbers": what it is on the left, the number on the right. */
function todayRow(label: string, value: string, first = false): El {
  return h(
    { justifyContent: 'space-between', alignItems: 'baseline', padding: '13px 0', borderTop: first ? 'none' : `2px solid ${TODAY_RULE}` },
    h({ fontSize: 24, color: C.soft }, label),
    h({ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }, value),
  );
}

const TODAY_TINT = mixColor(C.bsky, C.card, 0.1);
const TODAY_RULE = 'rgba(26, 115, 201, 0.16)';

/**
 * The almanac, in two panels like the mix card: on the left the last hour against usual
 * (the barometer and how far off), on the right today in numbers (its range, how much was
 * written, how much of it elsewhere, and how many apps were new).
 */
function today(d: CardData, art: Art): El | null {
  const usual = usualOf(d.almanac?.normal);
  const t = d.almanac?.today;
  if (!usual && !t) return null;
  const fresh = d.almanac?.newApps && !d.almanac.newApps.warmingUp ? d.almanac.newApps.apps.length : null;
  const range = t?.high && t.low ? { low: t.low, high: t.high } : null;
  const rows: Array<[string, string]> = [];
  if (t) rows.push(['new records', bigNumber(t.creates)]);
  if (t && t.creates > 0) rows.push(['from other apps', `${((100 * t.elsewhere) / t.creates).toFixed(2)}%`]);
  // The almanac lists at most NEW_APPS, from the last 24 hours: a full list is "20+".
  if (fresh) rows.push(['new apps, last 24 hours', fresh >= NEW_APPS ? `${NEW_APPS}+` : String(fresh)]);
  const right = range || rows.length;
  const left = right ? 600 : 1144;
  return page(
    tile(
      { width: left, height: 574, background: C.paper, padding: '42px 50px 36px' },
      masthead(art, 'today so far', C.brown, { background: C.bg }),
      h({ fontSize: 24, color: C.muted, marginTop: 'auto' }, 'the last hour'),
      h(
        { fontSize: usual ? 56 : 40, fontWeight: 700, lineHeight: 1.02, letterSpacing: '-0.02em', marginTop: 4 },
        usual ? usual.how : 'still learning what usual looks like',
      ),
      h(
        { alignItems: 'center', gap: 26, marginTop: 22 },
        svgImage(gaugeSvg(usual?.ratio ?? null), 220, 121),
        usual ? big(changeText(usual.ratio), 76, { color: C.bsky }) : null,
      ),
      usual
        ? h(
            { fontSize: 24, color: C.soft, marginTop: 18, lineHeight: 1.35 },
            `${int(usual.rate)} new records a second, against about ${int(usual.usual)} ${usual.when.replace('for ', 'at ')}.`,
          )
        : null,
      h({ marginTop: 20 }, footer(d)),
    ),
    right
      ? tile(
          { width: 1144 - left - 16, height: 574, background: TODAY_TINT, padding: '40px 40px 30px' },
          h({ fontSize: 30, fontWeight: 700, color: C.bsky }, 'today in numbers'),
          h({ fontSize: 22, color: C.soft, marginTop: 4 }, 'since midnight utc'),
          range
            ? h(
                { flexDirection: 'column', marginTop: 'auto' },
                h({ fontSize: 22, color: C.soft }, 'quietest to busiest minute, rec/sec'),
                h(
                  { alignItems: 'center', gap: 14, marginTop: 10 },
                  h({ fontSize: 30, fontWeight: 700 }, int(range.low.perSecond)),
                  h({ flex: 1, height: 16, borderRadius: 8, backgroundImage: `linear-gradient(90deg, ${mixColor(C.bsky, C.card, 0.2)}, ${C.bsky})` }),
                  h({ fontSize: 30, fontWeight: 700 }, int(range.high.perSecond)),
                ),
                h({ justifyContent: 'space-between', fontSize: 20, color: C.muted, marginTop: 6 }, h({}, utcClock(range.low.minute)), h({}, utcClock(range.high.minute))),
              )
            : null,
          rows.length
            ? h({ flexDirection: 'column', marginTop: range ? 22 : 'auto' }, ...rows.map(([label, value], i) => todayRow(label, value, i === 0)))
            : null,
        )
      : null,
  );
}

/** No numbers: what the report is, Poe dozing on its hill. */
export function drawQuiet(d: CardData, art: Art): El {
  const sky = { w: CARD_WIDTH - 56, h: CARD_HEIGHT - 56 };
  return page(
    tile(
      { width: sky.w, height: sky.h, background: C.sky, color: C.skyText, padding: '46px 54px' },
      svgImage(cloudsSvg(2, sky.w, sky.h), sky.w, sky.h, { position: 'absolute', left: 0, top: 0 }),
      sun(190, { position: 'absolute', right: 330, top: 26 }),
      ...poeOnHill(art, 'sleepy', 'come see how the sky is doing', sky.w),
      wordmark(art, C.brownOnSky),
      h(
        { flexDirection: 'column', marginTop: 'auto', width: 600 },
        h({ fontSize: 78, fontWeight: 700, lineHeight: 0.98, letterSpacing: '-0.03em', color: C.ink }, 'the atmosphere weather report'),
        h({ fontSize: 30, marginTop: 22, lineHeight: 1.3 }, 'how busy bluesky is, how much of the sky belongs to other apps, and who they are. live from the firehose.'),
        h({ marginTop: 26, fontSize: 24, fontWeight: 700, color: C.leaf }, 'atpota.to/weather'),
      ),
    ),
  );
}

const DRAW: Record<CardName, (d: CardData, art: Art) => El | null> = { forecast, trend, mix: mixCard, today };

/** The card, or null when what it shows didn't come. */
export function drawCard(name: CardName, d: CardData, art: Art): El | null {
  return DRAW[name](d, art);
}
