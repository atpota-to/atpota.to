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
 *   data-event    none | halloween | newyear | dispatch   special days: halloween from oct 24
 *                 at night and all of oct 31, new year's eve from dec 31 at night until 5am,
 *                 and dispatch day for a day after poe's weekly dispatch goes out (home.ts
 *                 reads it from the latest feed). halloween and new year's eve are night scenes.
 *   data-visitor  none | butterfly | worm | moth | snail | bird   a roll on each visit
 *                 (VISITOR_ODDS), from the visitors that fit the scene
 *   data-place    hill | cloud | moon | beach   a rarer roll (AWAY_ODDS): the moon at night, a
 *                 cloud by day, or now and then the beach on a summer day. never on a special day.
 *
 * Some visitors, special days and away days come in a few takes (TAKES), picked at random,
 * and birds come in a few kinds (BIRDS): data-visitor-take, data-event-take, data-place-take
 * and data-bird. Takes that would sit in the same spot never come together.
 *
 * Time, season, special days set by the calendar, and place change the whole tile, so the
 * inline script at the top of the tile in index.html picks them before first paint, with the
 * same rules as clockScene, seasonOf and pickPlace here (tests/home-scene.test.ts runs it to
 * keep the two in step). initScene() picks the rest once the page has loaded: it reads the
 * weather and the dispatch, rolls a visitor and the takes, draws the moving and drawn parts
 * (rain and leaves here; the rest in scene-art.ts) and gives Poe a face that fits. Seasons and
 * weather only change Poe's surroundings; nothing is put on Poe for them.
 *
 * ?scene=night,winter,snow,moon previews any combination: each word names one layer's value
 * and wins over the picker (the words are unique across layers). A take is the value and a
 * letter (snail-b, dispatch-c, halloween-a, newyear-b, beach-a), and a bird's kind is its own
 * word (bird-b,bluetit).
 *
 * Everything here is decoration ([aria-hidden] layers). Under reduced motion the scene still
 * changes between visits; only the movement stops (home.css).
 */

import { setMascotRest, type MascotFace } from './mascot';
import { BIRD_COLOURS, drawStage, type BirdType, type Box, type Geometry } from './scene-art';
import { SEASONS, seasonOf, TIMES, timeOfDay, type Season, type TimeOfDay } from './sky-clock';
import { getTheme, type Theme } from './theme';
import { readAtmosphere, type Condition } from './weather';

// The reader's clock lives in sky-clock.ts, so the weather report's header can share it.
export { SEASONS, seasonOf, TIMES, timeOfDay, type Season, type TimeOfDay };
export const WEATHERS = ['calm', 'gusty', 'rain', 'snow'] as const;
export const GROUNDS = ['meadow', 'deeper'] as const;
export const EVENTS = ['none', 'halloween', 'newyear', 'dispatch'] as const;
export const VISITORS = ['none', 'butterfly', 'worm', 'moth', 'snail', 'bird'] as const;
export const PLACES = ['hill', 'cloud', 'moon', 'beach'] as const;
export const BIRDS = Object.keys(BIRD_COLOURS) as BirdType[];
/** The takes of each thing that has them; the first is the default. */
export const TAKES = {
  snail: ['a', 'b', 'c'],
  bird: ['a', 'b', 'c'],
  dispatch: ['a', 'b', 'c'],
  newyear: ['a', 'b'],
  halloween: ['a', 'c'],
  beach: ['a', 'b'],
} as const;

export type SceneWeather = (typeof WEATHERS)[number];
export type Ground = (typeof GROUNDS)[number];
export type SceneEvent = (typeof EVENTS)[number];
export type Visitor = (typeof VISITORS)[number];
export type Place = (typeof PLACES)[number];
export type Taken = keyof typeof TAKES;

export interface Scene {
  time: TimeOfDay;
  season: Season;
  weather: SceneWeather;
  ground: Ground;
  event: SceneEvent;
  visitor: Visitor;
  place: Place;
  /** The take of the visitor, special day and away day ('' when that one has no takes). */
  visitorTake: string;
  eventTake: string;
  placeTake: string;
  bird: BirdType;
}

/** About one visit in six gets a visitor, from those that fit. */
export const VISITOR_ODDS = 1 / 6;
/** About one visit in forty is an away day. */
export const AWAY_ODDS = 1 / 40;
/** On a summer day, an away day is the beach this often (a cloud otherwise). */
export const BEACH_ODDS = 1 / 2;
/** Dispatch day lasts this long after an issue goes out. */
export const DISPATCH_DAY_MS = 24 * 60 * 60 * 1000;
/** A visitor waits this long for the weather and the dispatch before it picks without them. */
export const WEATHER_WAIT_MS = 4000;
export const SCENE_PARAM = 'scene';

/** The calendar's special days: halloween week at night and all of oct 31; new year's eve night. */
export function eventOn(date: Date, time: TimeOfDay): SceneEvent {
  const month = date.getMonth();
  const day = date.getDate();
  if (month === 9 && (day === 31 || (day >= 24 && time === 'night'))) return 'halloween';
  if ((month === 11 && day === 31 && time === 'night') || (month === 0 && day === 1 && date.getHours() < 5)) return 'newyear';
  return 'none';
}

const NIGHT_EVENTS: readonly SceneEvent[] = ['halloween', 'newyear'];

/** Time of day and the calendar's special day, with a preview's words first. Halloween and new year's eve are night scenes. */
export function clockScene(date: Date, theme: Theme, preview: Partial<Scene> = {}): { time: TimeOfDay; event: SceneEvent } {
  const clock = preview.time ?? timeOfDay(date, theme);
  const event = preview.event ?? eventOn(date, clock);
  return { time: preview.time ?? (NIGHT_EVENTS.includes(event) ? 'night' : clock), event };
}

/** Mostly the hill; now and then the moon at night, or by day a cloud (the beach, some summer days). */
export function pickPlace(time: TimeOfDay, season: Season, event: SceneEvent, random: () => number = Math.random): Place {
  if (event !== 'none' || random() >= AWAY_ODDS) return 'hill';
  if (time === 'night') return 'moon';
  return season === 'summer' && random() < BEACH_ODDS ? 'beach' : 'cloud';
}

/** The network's weather, as the tile shows it. No reading is calm. */
export function weatherFor(condition: Condition | null | undefined, season: Season): SceneWeather {
  if (condition === 'gusty') return 'gusty';
  if (condition === 'stormy') return season === 'winter' ? 'snow' : 'rain';
  return 'calm';
}

/** Whether poe's newest dispatch (ms since the epoch) went out within the last day. */
export function isDispatchDay(publishedAt: number | null | undefined, now: number): boolean {
  return typeof publishedAt === 'number' && now >= publishedAt && now - publishedAt < DISPATCH_DAY_MS;
}

/** Visitors that make sense in this scene: none away from the hill, only moths on a festive night. */
export function visitorsThatFit(scene: Pick<Scene, 'time' | 'season' | 'weather' | 'place'> & Partial<Pick<Scene, 'event'>>): Visitor[] {
  if (scene.place !== 'hill') return [];
  const wet = scene.weather === 'rain' || scene.weather === 'snow';
  const night = scene.time === 'night';
  const festive = NIGHT_EVENTS.includes(scene.event ?? 'none');
  const out: Visitor[] = [];
  if ((scene.season === 'spring' || scene.season === 'summer') && !night && !wet && !festive) out.push('butterfly');
  if (scene.weather === 'rain') out.push('worm');
  if (night && !wet) out.push('moth');
  if (scene.season !== 'winter' && scene.weather !== 'snow') out.push('snail');
  if (!night && scene.weather !== 'rain' && !festive) out.push('bird');
  return out;
}

export function pickVisitor(scene: Pick<Scene, 'time' | 'season' | 'weather' | 'place'> & Partial<Pick<Scene, 'event'>>, random: () => number = Math.random): Visitor {
  const fits = visitorsThatFit(scene);
  if (fits.length === 0 || random() >= VISITOR_ODDS) return 'none';
  return fits[Math.floor(random() * fits.length)] ?? 'none';
}

/** Whether the special day already has something in the spot right of Poe (where a sprout stands). */
function rightTakenBy(scene: Pick<Scene, 'event' | 'eventTake'>): boolean {
  return scene.event === 'halloween' || (scene.event === 'dispatch' && scene.eventTake !== 'c');
}

/** Whether anything stands right of Poe, so the sprout there steps aside. */
export function rightProp(scene: Scene): boolean {
  return rightTakenBy(scene) || ((scene.visitor === 'snail' || scene.visitor === 'bird') && scene.visitorTake === 'c');
}

/** A take for a thing with takes, never one that would share a spot with the special day. */
export function pickTake(kind: Taken, scene: Pick<Scene, 'event' | 'eventTake'>, random: () => number = Math.random): string {
  let options: readonly string[] = TAKES[kind];
  if ((kind === 'snail' || kind === 'bird') && rightTakenBy(scene)) options = options.filter((t) => t !== 'c');
  // the dispatch's letter in Poe's leaf leaves no room for a bird there
  if (kind === 'bird' && scene.event === 'dispatch' && scene.eventTake === 'c') options = options.filter((t) => t !== 'a');
  return options[Math.floor(random() * options.length)] ?? options[0] ?? '';
}

export function pickBird(random: () => number = Math.random): BirdType {
  return BIRDS[Math.floor(random() * BIRDS.length)] ?? 'robin';
}

/** Poe's resting face for the scene, or undefined for the usual one. */
export function restFace(scene: Scene): MascotFace | undefined {
  if (scene.place === 'moon') return 'wow';
  if (scene.place === 'beach') return 'happy';
  if (scene.event === 'halloween') return scene.eventTake === 'c' ? 'kawaii' : 'wow';
  if (scene.event === 'newyear') return scene.eventTake === 'b' ? 'happy' : 'wow';
  if (scene.event === 'dispatch') return scene.eventTake === 'a' ? 'wink' : 'happy';
  if (scene.visitor === 'butterfly' || scene.visitor === 'moth') return 'wow';
  if (scene.visitor === 'worm') return 'happy';
  if (scene.visitor === 'snail' && scene.visitorTake === 'b') return 'wow';
  if (scene.visitor === 'bird' && scene.visitorTake !== 'c') return scene.visitorTake === 'b' ? 'wow' : 'happy';
  if (scene.time === 'night') return 'sleepy';
  return undefined;
}

const LAYERS = [
  ['time', TIMES],
  ['season', SEASONS],
  ['weather', WEATHERS],
  ['ground', GROUNDS],
  ['event', EVENTS],
  ['visitor', VISITORS],
  ['place', PLACES],
] as const;

/**
 * "?scene=night,winter,moon" -> { time: 'night', season: 'winter', place: 'moon' }. Unknown words
 * are ignored; two words for one layer resolve to the one listed first in that layer's values,
 * as the inline script does. "snail-b" also picks that take, and a bird's kind is its own word.
 */
export function parseScene(search: string): Partial<Scene> {
  const raw = (new URLSearchParams(search).get(SCENE_PARAM) ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const words = new Set<string>();
  const takes = new Map<string, string>();
  for (const word of raw) {
    const [value = '', take] = word.split('-');
    words.add(value);
    if (take && (TAKES[value as Taken] as readonly string[] | undefined)?.includes(take)) takes.set(value, take);
  }
  const out: Partial<Record<keyof Scene, string>> = {};
  for (const [layer, values] of LAYERS) {
    // 'none' belongs to the visitor; a special day is only ever named
    const hit = values.find((value) => words.has(value) && !(layer === 'event' && value === 'none'));
    if (hit) out[layer] = hit;
  }
  if (out.visitor && takes.has(out.visitor)) out.visitorTake = takes.get(out.visitor);
  if (out.event && takes.has(out.event)) out.eventTake = takes.get(out.event);
  if (out.place && takes.has(out.place)) out.placeTake = takes.get(out.place);
  const kind = BIRDS.find((b) => words.has(b));
  if (kind) out.bird = kind;
  return out as Partial<Scene>;
}

function valid<T extends string>(value: string | undefined, values: readonly T[]): T | undefined {
  return (values as readonly string[]).includes(value ?? '') ? (value as T) : undefined;
}

/* ---------- the moving parts drawn here: rain, snow, leaves, petals, butterflies, worms, moths ---------- */

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

/** The markup of the visitors drawn with CSS: a blue butterfly, a worm in its hole, or a moth. Static strings only. */
export function visitorElement(visitor: Visitor): HTMLElement | null {
  if (visitor !== 'butterfly' && visitor !== 'moth' && visitor !== 'worm') return null;
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

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function relativeBox(el: Element | null, to: DOMRect): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left - to.left, top: r.top - to.top, width: r.width, height: r.height };
}

/** Where Poe and the hill are on the tile, measured without Poe's lean or petting. */
export function measure(tile: HTMLElement): Geometry {
  const box = tile.getBoundingClientRect();
  const img = tile.querySelector<HTMLImageElement>('img[data-mascot]');
  // offset* ignore transforms, so a pet in progress doesn't move the drawings
  const poe: Box = img ? { left: img.offsetLeft, top: img.offsetTop, width: img.offsetWidth, height: img.offsetHeight } : { left: 0, top: 0, width: 0, height: 0 };
  const mound = relativeBox(tile.querySelector('.home-sun__mound'), box);
  return { w: box.width, h: box.height, poe, mound: mound && mound.width > 0 ? mound : null };
}

const LAYER_ATTRS = [...LAYERS.map(([layer]) => layer), 'visitorTake', 'eventTake', 'placeTake', 'bird'] as const;

/** Sets the tile's attributes and redraws only the parts whose layers changed. */
export function applyScene(tile: HTMLElement, scene: Scene, random: () => number = Math.random): void {
  for (const key of LAYER_ATTRS) tile.dataset[key] = scene[key];
  tile.toggleAttribute('data-right-prop', rightProp(scene));
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
  drawArt(tile, scene, random);
  const img = tile.querySelector<HTMLImageElement>('img[data-mascot]');
  if (img) setMascotRest(img, restFace(scene));
}

/** The drawn layers (scene-art.ts), redrawn when the scene or the tile's size changes. */
function drawArt(tile: HTMLElement, scene: Scene, random: () => number, force = false): void {
  const geo = measure(tile);
  const key = [...LAYER_ATTRS.map((k) => scene[k]), Math.round(geo.w / 4), Math.round(geo.h / 4), Math.round(geo.poe.width / 4)].join(' ');
  if (!force && tile.dataset.artDrawn === key) return;
  tile.dataset.artDrawn = key;
  const stage = drawStage(scene, geo, { random, reducedMotion: reducedMotion() });
  const fill = (selector: string, content: string, viewBox?: string) => {
    const el = tile.querySelector<SVGSVGElement>(selector);
    if (!el) return;
    if (viewBox) el.setAttribute('viewBox', viewBox);
    el.innerHTML = content;
  };
  const size = `0 0 ${Math.max(1, Math.round(geo.w))} ${Math.max(1, Math.round(geo.h))}`;
  fill('[data-scene-stage="back"]', stage.back, size);
  fill('[data-scene-stage="front"]', stage.front, size);
  fill('[data-scene-worn="back"]', stage.wornBack);
  fill('[data-scene-worn="front"]', stage.wornFront);
}

/**
 * The worn overlays sit on Poe's image and copy its classes and style, so anything Poe holds
 * or wears hops, wobbles, flips and leans with it.
 */
export function mirrorPoe(img: HTMLImageElement, overlays: Element[]): void {
  const copyClasses = () => {
    const states = [...img.classList].filter((c) => c.startsWith('is-'));
    for (const el of overlays) {
      const base = [...el.classList].filter((c) => !c.startsWith('is-'));
      // drop the motion first, so a pet that replays the same one restarts in step with Poe
      el.setAttribute('class', base.join(' '));
      void el.getBoundingClientRect();
      el.setAttribute('class', [...base, ...states].join(' '));
    }
  };
  const copyStyle = () => {
    for (const el of overlays) el.setAttribute('style', img.getAttribute('style') ?? '');
  };
  copyClasses();
  copyStyle();
  if (typeof MutationObserver !== 'function') return;
  new MutationObserver((records) => {
    if (records.some((r) => r.attributeName === 'class')) copyClasses();
    if (records.some((r) => r.attributeName === 'style')) copyStyle();
  }).observe(img, { attributes: true, attributeFilter: ['class', 'style'] });
}

export interface SceneOptions {
  fetchImpl?: typeof fetch;
  /** When poe's newest dispatch went out (ms since the epoch), or null (home.ts). */
  dispatchedAt?: () => Promise<number | null>;
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

  // The inline script already picked time, season, the calendar's day and place; pick them here if it didn't run.
  const clock = clockScene(now(), getTheme(), preview);
  const time = valid(tile.dataset.time, TIMES) ?? clock.time;
  const season = valid(tile.dataset.season, SEASONS) ?? preview.season ?? seasonOf(now());
  const event = valid(tile.dataset.event, EVENTS) ?? clock.event;
  const scene: Scene = {
    time,
    season,
    event,
    place: valid(tile.dataset.place, PLACES) ?? preview.place ?? pickPlace(time, season, event, random),
    ground: preview.ground ?? valid(tile.dataset.ground, GROUNDS) ?? 'meadow',
    weather: preview.weather ?? 'calm',
    visitor: 'none',
    visitorTake: '',
    eventTake: '',
    placeTake: '',
    bird: preview.bird ?? pickBird(random),
  };
  const takeFor = (kind: string, asked: string | undefined) => (kind in TAKES ? (asked ?? pickTake(kind as Taken, scene, random)) : '');
  scene.eventTake = takeFor(scene.event, preview.eventTake);
  scene.placeTake = takeFor(scene.place, preview.placeTake);
  applyScene(tile, scene, random);

  const img = tile.querySelector<HTMLImageElement>('img[data-mascot]');
  if (img) mirrorPoe(img, [...tile.querySelectorAll('[data-scene-worn]')]);

  let settled = false;
  const settle = (condition?: Condition | null, dispatched?: number | null) => {
    if (settled) return;
    settled = true;
    if (!preview.weather) scene.weather = weatherFor(condition, scene.season);
    if (scene.event === 'none' && scene.place === 'hill' && isDispatchDay(dispatched, now().getTime())) {
      scene.event = 'dispatch';
      scene.eventTake = preview.eventTake ?? pickTake('dispatch', scene, random);
    }
    scene.visitor = preview.visitor ?? pickVisitor(scene, random);
    scene.visitorTake = takeFor(scene.visitor, preview.visitorTake);
    applyScene(tile, scene, random);
  };
  window.setTimeout(() => settle(), WEATHER_WAIT_MS);
  void Promise.all([
    preview.weather ? null : readAtmosphere(opts.fetchImpl).then((r) => r?.condition ?? null),
    preview.event || !opts.dispatchedAt ? null : opts.dispatchedAt().catch(() => null),
  ]).then(([condition, dispatched]) => settle(condition, dispatched));

  // The dark theme is night; back in the light, the clock decides again.
  window.addEventListener('theme:change', () => {
    const next = clockScene(now(), getTheme(), preview);
    scene.time = next.time;
    if (scene.event !== 'dispatch' || next.event !== 'none') {
      if (next.event !== scene.event) scene.eventTake = takeFor(next.event, preview.eventTake);
      scene.event = next.event;
    }
    if (scene.visitor !== 'none' && !visitorsThatFit(scene).includes(scene.visitor)) scene.visitor = 'none';
    applyScene(tile, scene, random);
  });

  // Redraw the drawn layers when the tile changes size (a rotated phone, a wider window).
  if (typeof ResizeObserver === 'function') {
    let frame = 0;
    new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => drawArt(tile, scene, random));
    }).observe(tile);
  }
}
