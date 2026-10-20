/**
 * Poe's hill: the scene on the home page's sunburst tile ([data-scene], index.html).
 *
 * The tile is a stack of layers, each picked on its own and kept as a data attribute on the
 * tile, so home.css can paint it:
 *
 *   data-time     dawn | day | golden | night   the reader's clock; the dark theme is always night
 *   data-season   plain | spring | summer | autumn | winter   the month (north of the equator);
 *                 plain is the bare hill, for a preview or when nothing else applies
 *   data-weather  calm | gusty | rain | snow    the weather station's reading (weather.ts):
 *                 calm, light and breezy are calm, gusty is gusty, stormy rains (snows in winter)
 *   data-ground   meadow | deeper               meadow unless a preview asks for deeper soil
 *   data-visitor  none | butterfly | worm | moth   a roll on each visit (VISITOR_ODDS), from
 *                 the visitors that fit the scene
 *   data-place    hill | cloud | moon           a rarer roll (AWAY_ODDS): a cloud by day, the
 *                 moon at night
 *
 * Time, season and place change the whole tile, so the inline script at the top of the tile
 * in index.html picks them before first paint, with the same rules as timeOfDay, seasonOf
 * and pickPlace here (tests/home-scene.test.ts runs it to keep the two in step). initScene()
 * picks the rest once the page has loaded: it reads the weather, rolls a visitor, draws the
 * moving parts (rain, snow, leaves, petals, the visitor) and gives Poe a face that fits.
 * Seasons and weather only change Poe's surroundings; nothing is put on Poe.
 *
 * ?scene=night,winter,snow,moon previews any combination: each word names one layer's value
 * and wins over the picker (the words are unique across layers).
 *
 * Everything here is decoration ([aria-hidden] layers). Under reduced motion the scene still
 * changes between visits; only the movement stops (home.css).
 */

import { setMascotRest, type MascotFace } from './mascot';
import { getTheme, type Theme } from './theme';
import { readAtmosphere, type Condition } from './weather';

export const TIMES = ['dawn', 'day', 'golden', 'night'] as const;
export const SEASONS = ['plain', 'spring', 'summer', 'autumn', 'winter'] as const;
export const WEATHERS = ['calm', 'gusty', 'rain', 'snow'] as const;
export const GROUNDS = ['meadow', 'deeper'] as const;
export const VISITORS = ['none', 'butterfly', 'worm', 'moth'] as const;
export const PLACES = ['hill', 'cloud', 'moon'] as const;

export type TimeOfDay = (typeof TIMES)[number];
export type Season = (typeof SEASONS)[number];
export type SceneWeather = (typeof WEATHERS)[number];
export type Ground = (typeof GROUNDS)[number];
export type Visitor = (typeof VISITORS)[number];
export type Place = (typeof PLACES)[number];

export interface Scene {
  time: TimeOfDay;
  season: Season;
  weather: SceneWeather;
  ground: Ground;
  visitor: Visitor;
  place: Place;
}

/** About one visit in six gets a visitor, from those that fit. */
export const VISITOR_ODDS = 1 / 6;
/** About one visit in forty is an away day. */
export const AWAY_ODDS = 1 / 40;
/** A visitor waits this long for the weather before it picks without it. */
export const WEATHER_WAIT_MS = 4000;
export const SCENE_PARAM = 'scene';

/** dawn 5–8, day 8–17, golden hour 17–19:30, night after that; the dark theme is always night. */
export function timeOfDay(date: Date, theme: Theme = 'light'): TimeOfDay {
  if (theme === 'dark') return 'night';
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 19.5) return 'golden';
  return 'night';
}

const MONTH_SEASONS: readonly Season[] = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

/** Meteorological seasons, north of the equator. */
export function seasonOf(date: Date): Season {
  return MONTH_SEASONS[date.getMonth()] ?? 'plain';
}

/** Mostly the hill; now and then a cloud by day, or the moon at night. */
export function pickPlace(time: TimeOfDay, random: () => number = Math.random): Place {
  if (random() >= AWAY_ODDS) return 'hill';
  return time === 'night' ? 'moon' : 'cloud';
}

/** The network's weather, as the tile shows it. No reading is calm. */
export function weatherFor(condition: Condition | null | undefined, season: Season): SceneWeather {
  if (condition === 'gusty') return 'gusty';
  if (condition === 'stormy') return season === 'winter' ? 'snow' : 'rain';
  return 'calm';
}

/** Visitors that make sense in this scene: none away from the hill. */
export function visitorsThatFit(scene: Pick<Scene, 'time' | 'season' | 'weather' | 'place'>): Visitor[] {
  if (scene.place !== 'hill') return [];
  const wet = scene.weather === 'rain' || scene.weather === 'snow';
  const out: Visitor[] = [];
  if ((scene.season === 'spring' || scene.season === 'summer') && scene.time !== 'night' && !wet) out.push('butterfly');
  if (scene.weather === 'rain') out.push('worm');
  if (scene.time === 'night' && !wet) out.push('moth');
  return out;
}

export function pickVisitor(scene: Pick<Scene, 'time' | 'season' | 'weather' | 'place'>, random: () => number = Math.random): Visitor {
  const fits = visitorsThatFit(scene);
  if (fits.length === 0 || random() >= VISITOR_ODDS) return 'none';
  return fits[Math.floor(random() * fits.length)] ?? 'none';
}

/** Poe's resting face for the scene, or undefined for the usual one. */
export function restFace(scene: Scene): MascotFace | undefined {
  if (scene.place === 'moon') return 'wow';
  if (scene.visitor === 'butterfly' || scene.visitor === 'moth') return 'wow';
  if (scene.visitor === 'worm') return 'happy';
  if (scene.time === 'night') return 'sleepy';
  return undefined;
}

const LAYERS = [
  ['time', TIMES],
  ['season', SEASONS],
  ['weather', WEATHERS],
  ['ground', GROUNDS],
  ['visitor', VISITORS],
  ['place', PLACES],
] as const;

/**
 * "?scene=night,winter,moon" -> { time: 'night', season: 'winter', place: 'moon' }. Unknown words
 * are ignored; two words for one layer resolve to the one listed first in that layer's values,
 * as the inline script does.
 */
export function parseScene(search: string): Partial<Scene> {
  const words = new Set((new URLSearchParams(search).get(SCENE_PARAM) ?? '').toLowerCase().split(/[\s,]+/));
  const out: Partial<Record<keyof Scene, string>> = {};
  for (const [layer, values] of LAYERS) {
    const hit = values.find((value) => words.has(value));
    if (hit) out[layer] = hit;
  }
  return out as Partial<Scene>;
}

function valid<T extends string>(value: string | undefined, values: readonly T[]): T | undefined {
  return (values as readonly string[]).includes(value ?? '') ? (value as T) : undefined;
}

/* ---------- the moving parts ---------- */

const jitter = (random: () => number, min: number, max: number) => min + random() * (max - min);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const LEAF_COLOURS = ['#E07B39', '#C9542E', '#F2B33D', '#B5652A'];
const GREEN_LEAVES = ['#39B54A', '#006837', '#7FC86A'];
const PETALS = ['#F7C6D3', '#FFFFFF', '#E6D2F5'];

function span(className: string, style: Record<string, string>): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  for (const [key, value] of Object.entries(style)) el.style.setProperty(key, value);
  return el;
}

/** Rain, snow, falling or blowing leaves and petals, scattered with their own speeds. */
export function particles(scene: Scene, random: () => number = Math.random): HTMLSpanElement[] {
  const out: HTMLSpanElement[] = [];
  if (scene.place === 'moon') return out;
  const add = (kind: string, n: number, dur: [number, number], colours?: readonly string[]) => {
    for (let i = 0; i < n; i++) {
      const d = jitter(random, dur[0], dur[1]);
      const style: Record<string, string> = {
        '--x': pct(random()),
        '--y': pct(random()),
        '--dur': `${d.toFixed(2)}s`,
        '--at': `${(-random() * d).toFixed(2)}s`,
        '--turn': `${Math.round(random() * 360)}deg`,
        '--size': (0.7 + random() * 0.6).toFixed(2),
      };
      if (colours) style['--c'] = colours[i % colours.length]!;
      out.push(span(`home-sun__bit home-sun__bit--${kind}`, style));
    }
  };
  if (scene.weather === 'rain') add('rain', 44, [0.5, 0.85]);
  if (scene.weather === 'snow') add('snow', 46, [7, 13]);
  if (scene.place !== 'hill') return out;
  const gusty = scene.weather === 'gusty';
  if (scene.season === 'autumn') add(gusty ? 'gust' : 'leaf', gusty ? 14 : 9, gusty ? [3, 6] : [7, 13], LEAF_COLOURS);
  else if (gusty) add('gust', 6, [3, 6], GREEN_LEAVES);
  if (scene.season === 'spring' && scene.weather === 'calm') add('petal', 8, [9, 15], PETALS);
  return out;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const BUTTERFLY_WING = 'M0,-1 C4,-14 18,-22 23,-15 C27,-9 21,1 8,2 C18,4 19,15 11,17 C5,18 2,9 0,3Z';
const MOTH_WING = 'M0,-2 C6,-12 20,-12 22,-4 C24,4 14,8 4,4 C12,10 10,16 4,14 C1,13 0,8 0,3Z';

function svg(viewBox: string, inner: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('focusable', 'false');
  el.innerHTML = inner;
  return el;
}

function wings(path: string, fill: string, extra = ''): string {
  return `<g class="home-sun__wings"><path d="${path}" fill="${fill}"/><path d="${path}" fill="${fill}" transform="scale(-1 1)"/>${extra}</g>`;
}

/** The visitor's markup: a blue butterfly, a worm in its hole, or a moth. Static strings only. */
export function visitorElement(visitor: Visitor): HTMLElement | null {
  if (visitor === 'none') return null;
  const el = document.createElement('span');
  el.className = `home-sun__visitor home-sun__visitor--${visitor}`;
  if (visitor === 'butterfly') {
    el.appendChild(svg('-26 -24 52 44', `${wings(BUTTERFLY_WING, '#1185FE')}<path d="M0,-8 V9" stroke="#123E73" stroke-width="2.6" stroke-linecap="round"/>`));
  } else if (visitor === 'moth') {
    el.appendChild(
      svg(
        '-26 -20 52 38',
        `${wings(MOTH_WING, '#E3D3B0', '<circle cx="9" cy="-4" r="2.6" fill="#A88F63"/><circle cx="-9" cy="-4" r="2.6" fill="#A88F63"/>')}<path d="M0,-7 V8" stroke="#8C7454" stroke-width="3" stroke-linecap="round"/><path d="M0,-7 l-4,-6 M0,-7 l4,-6" stroke="#8C7454" stroke-width="1.4" fill="none"/>`,
      ),
    );
  } else {
    // The hole, then a window cut off at the hole's middle, so the worm comes up out of it.
    const hole = document.createElement('span');
    hole.className = 'home-sun__hole';
    const burrow = document.createElement('span');
    burrow.className = 'home-sun__burrow';
    const worm = document.createElement('span');
    worm.className = 'home-sun__worm';
    worm.appendChild(
      svg(
        '-10 -40 20 48',
        '<path d="M-7,8 V-30 a7,7 0 0 1 14,0 V8Z" fill="#E98D9E"/><path d="M-7,-14 h14 M-7,-6 h14 M-7,2 h14" stroke="#D07082" stroke-width="2"/><g class="home-sun__worm-face"><circle cx="-3" cy="-30" r="1.8" fill="#3D2F1B"/><circle cx="3" cy="-30" r="1.8" fill="#3D2F1B"/><path d="M-3,-25 q3,2.5 6,0" stroke="#3D2F1B" stroke-width="1.4" fill="none" stroke-linecap="round"/></g>',
      ),
    );
    burrow.appendChild(worm);
    el.append(hole, burrow);
  }
  return el;
}

/* ---------- putting it on the tile ---------- */

/** Sets the tile's attributes and redraws only the moving parts whose layers changed. */
export function applyScene(tile: HTMLElement, scene: Scene, random: () => number = Math.random): void {
  for (const [layer] of LAYERS) tile.dataset[layer] = scene[layer];
  const life = tile.querySelector<HTMLElement>('[data-scene-life]');
  const key = `${scene.weather} ${scene.season} ${scene.place}`;
  if (life && life.dataset.drawn !== key) {
    life.dataset.drawn = key;
    life.replaceChildren(...particles(scene, random));
  }
  const host = tile.querySelector<HTMLElement>('[data-scene-visitor]');
  if (host && host.dataset.drawn !== scene.visitor) {
    host.dataset.drawn = scene.visitor;
    const visitor = visitorElement(scene.visitor);
    host.replaceChildren(...(visitor ? [visitor] : []));
  }
  const img = tile.querySelector<HTMLImageElement>('img[data-mascot]');
  if (img) setMascotRest(img, restFace(scene));
}

export interface SceneOptions {
  fetchImpl?: typeof fetch;
  random?: () => number;
  now?: () => Date;
  search?: string;
}

export function initScene(root: ParentNode = document, opts: SceneOptions = {}): void {
  const tile = root.querySelector<HTMLElement>('[data-scene]');
  if (!tile || tile.dataset.sceneBound === 'true') return;
  tile.dataset.sceneBound = 'true';
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => new Date());
  const preview = parseScene(opts.search ?? window.location.search);

  // The inline script already picked time, season and place; pick them here if it didn't run.
  const time = valid(tile.dataset.time, TIMES) ?? preview.time ?? timeOfDay(now(), getTheme());
  const scene: Scene = {
    time,
    season: valid(tile.dataset.season, SEASONS) ?? preview.season ?? seasonOf(now()),
    place: valid(tile.dataset.place, PLACES) ?? preview.place ?? pickPlace(time, random),
    ground: preview.ground ?? valid(tile.dataset.ground, GROUNDS) ?? 'meadow',
    weather: preview.weather ?? 'calm',
    visitor: 'none',
  };
  applyScene(tile, scene, random);

  let settled = false;
  const settle = (condition?: Condition | null) => {
    if (settled) return;
    settled = true;
    if (!preview.weather) scene.weather = weatherFor(condition, scene.season);
    scene.visitor = preview.visitor ?? pickVisitor(scene, random);
    applyScene(tile, scene, random);
  };
  if (preview.weather) settle();
  else {
    window.setTimeout(() => settle(), WEATHER_WAIT_MS);
    void readAtmosphere(opts.fetchImpl).then((reading) => settle(reading?.condition));
  }

  // The dark theme is night; back in the light, the clock decides again.
  window.addEventListener('theme:change', () => {
    scene.time = getTheme() === 'dark' ? 'night' : (preview.time ?? timeOfDay(now(), 'light'));
    if (scene.visitor !== 'none' && !visitorsThatFit(scene).includes(scene.visitor)) scene.visitor = 'none';
    applyScene(tile, scene, random);
  });
}
