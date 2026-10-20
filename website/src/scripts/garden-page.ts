/**
 * Garden pages (garden/index.html): everyone's garden on atpota.to.
 *
 *   /garden                  the community garden (atpotato's page, as /garden/atpota.to),
 *                            for everyone: where the nav goes. Signed in, a button there goes
 *                            to your own page
 *   /garden/dame.is          someone's page, by handle or DID: their garden, where anyone can
 *                            plant a flower (the "garden" level)
 *   /garden/dame.is/flowers  every flower they've planted, in any garden: the one that needs
 *                            them most up close, all of them with quick tending, and their
 *                            numbers, connections and field guide (the "flowers" level)
 *
 * A garden is a to.atpota.garden.patch record in its keeper's own repo (record key "self");
 * signed in on your own page you can set one up or change it, including whether visitors
 * plant one flower each (the default) or as many as they like. atpota.to's seasonal patches
 * are the same thing in atpotato's repo, so /garden/atpota.to is the community garden on the
 * home page, one flower each. Planting, the season tabs and a flower's card are the home
 * tile's own code (initGarden in garden.ts), pointed at this person's garden.
 *
 * Data: /api/gardener (server/gardener.ts) for the person and their flowers, /api/garden
 * (server/garden.ts) for their garden. Tending writes a to.atpota.garden.tend record in the
 * reader's repo; the care shown after it is worked out here (careFrom, the server's rule)
 * until the next load. Signing in is the blog's: a "tend" pending action brings the reader
 * back to this page.
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { RepoError } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me } from '../blog/signin';
import { clearPending, localStoreFor, readPending, safeReturnTo, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { bloomsAt, DAY_MS, drawFlower, FLOWER_KINDS, GROW_DAYS, rarityOdds, sampleVariant, stageFor, type FlowerKind, type Stage, type Variant } from './flowers';
import {
  actorOf,
  COPY as PATCH_COPY,
  dayOf,
  describeBloom,
  fetchGardener,
  flowerVariant,
  GARDEN_SIZES,
  GARDEN_SUBJECT,
  gardenPath,
  gardenRecord,
  initGarden,
  markWatered,
  NAME_MAX,
  NOTE_MAX,
  OWN_PATCH_RKEY,
  PLANTING,
  saveGarden,
  tend,
  TEND_KEY,
  thirstyDays,
  wateredToday,
  type GardenController,
  type GardenerFlower,
  type GardenerView,
  type GardenView,
  type Patch,
  type Planting,
  type TendAction,
} from './garden';
import { rememberReader } from './reader';

export { actorOf, gardenPath } from './garden';

/** localStorage: the blooms this reader has already seen open ({ uris }). */
export const SEEN_KEY = 'garden:seen';
/** Neighbours who help count towards a flower's care, up to this many (server/garden.ts). */
const MAX_HELPERS = 3;

export type Level = 'garden' | 'flowers';
export type Filter = 'all' | 'growing' | 'bloom' | 'pressed';
type Size = keyof typeof GARDEN_SIZES;

export const COPY = {
  docTitle: (who: string | null) => (who ? `${who}'s garden · atpotato` : 'your garden · atpotato'),
  community: {
    eyebrow: 'gardens',
    title: 'the community garden',
    lede: "everyone's patch on atpota.to, a fresh one each season. plant one flower, look after it for its first week, and watch it bloom.",
    docTitle: 'the community garden · atpotato',
    yours: 'go to your garden',
    visit: 'visit the community garden',
  },
  otherHost: 'gardens work on atpota.to.',
  missing: { title: 'no garden here', lede: (actor: string) => `we couldn't find ${actor.startsWith('did:') ? actor : `@${actor}`} on bluesky.` },
  loadFailed: "this garden didn't load just now. try again in a moment?",
  eyebrow: (owner: boolean) => (owner ? 'your garden' : 'a garden on atpota.to'),
  lede: (handle: string, owner: boolean) =>
    owner ? `@${handle} · your page: your garden, and every flower you've planted.` : `@${handle} · their garden, and every flower they've planted.`,
  copyLink: "copy your garden's link",
  copied: 'copied! send it to someone who likes flowers.',
  yourGarden: 'your garden',
  signInToTend: 'sign in to plant and water',
  stats: {
    planted: (n: number) => (n === 1 ? 'flower planted' : 'flowers planted'),
    gardens: (n: number) => (n === 1 ? 'garden' : 'gardens'),
    visitors: (n: number) => (n === 1 ? 'visitor' : 'visitors'),
    tended: (n: number) => (n === 1 ? 'time tending' : 'times tending'),
    rare: (n: number) => (n === 1 ? 'rare find' : 'rare finds'),
  },
  levels: { garden: 'garden', flowers: 'flowers' } satisfies Record<Level, string>,
  setup: {
    name: (handle: string) => `${handle.split('.')[0]}'s garden`.slice(0, NAME_MAX),
    planting: 'planting…',
    done: 'your garden is ready! share the link and see who plants first (◕‿◕)',
    saved: 'saved.',
  },
  none: (handle: string) => `@${handle} hasn't set up a garden yet. their flowers are under "flowers".`,
  visitors: (n: number) => `who's planted here · ${n}`,
  // the flower up close
  place: (patch: { name: string; owner: { did: string } }) => (patch.owner.did === GARDEN_SUBJECT ? `the ${patch.name} patch` : patch.name),
  featuredEyebrow: (place: string, plot: number) => `${place} · plot ${plot}`,
  growing: (whose: string, kind: FlowerKind, stage: Stage) => `${whose} ${kind}, ${stage === 'sprout' ? 'just planted' : 'budding'}`,
  growingLede: (day: number, weekday: string) =>
    `day ${day} of ${GROW_DAYS}. it blooms on ${weekday}, and the better it's looked after this week, the better it'll grow.`,
  visitingLede: (day: number, weekday: string) => `day ${day} of ${GROW_DAYS}. it blooms on ${weekday}. a little water from you counts towards its care.`,
  waiting: `day ${GROW_DAYS}. something's happening…`,
  waitingLede: 'this flower has finished growing. come and see what it turned into.',
  takeALook: 'take a look',
  bloomLede: (since: string, care: number) => `in bloom since ${since}. cared for ${care} of ${GROW_DAYS} days.`,
  pressedLede: (place: string, care: number) => `pressed when ${place} closed. cared for ${care} of ${GROW_DAYS} days.`,
  thirsty: (whose: string, kind: FlowerKind) => `${whose} ${kind} looks thirsty`,
  thirstyLede: (days: number) => `nobody's watered it for ${days} ${days === 1 ? 'day' : 'days'}. a drink will perk it right up.`,
  ribbon: { double: 'a second ring!', twoTone: 'two-tone!', ladybug: 'a ladybug moved in!', plain: 'in full bloom!' },
  bloomed: (kind: FlowerKind, bloom: string) => `your ${kind} bloomed: ${bloom}.`,
  visit: 'visit its garden',
  care: (n: number) => `care so far: ${n} of ${GROW_DAYS}`,
  odds: { twoTone: 'two-tone', double: 'second ring', ladybug: 'ladybug' },
  tended: {
    water: 'watered! it drank the lot. see you tomorrow.',
    sun: 'it soaked up the sun. see you tomorrow.',
    talk: 'you told it about your day. it leaned in. see you tomorrow.',
  } satisfies Record<TendAction, string>,
  visitorWatered: 'watered! thanks for helping it along.',
  tendLede: 'sign in with your bluesky or atmosphere account to look after flowers. each one is a small record in your own repo.',
  tendLabel: (action: TendAction, whose: string, kind: FlowerKind) => `${{ water: 'water', sun: 'give sun to', talk: 'talk to' }[action]} ${whose} ${kind}`,
  day: (n: number, how: string) => `day ${n}: ${how}`,
  dayHow: { tended: 'looked after', today: 'today', missed: 'not looked after', ahead: 'still to come' },
  bloomDay: 'bloom',
  // all their flowers
  flowersTitle: (owner: boolean, n: number) => `${owner ? 'your' : 'their'} flowers · ${n}`,
  filters: { all: 'all', growing: 'growing', bloom: 'in bloom', pressed: 'pressed' } satisfies Record<Filter, string>,
  filterLabel: (f: Filter, n: number) => `${COPY.filters[f]} ${n}`,
  meta: {
    growing: (place: string, day: number) => `${place} · day ${day} of ${GROW_DAYS}`,
    bloom: (place: string) => `${place} · in bloom`,
    thirsty: (place: string) => `${place} · thirsty`,
    pressed: (place: string) => `${place} · pressed`,
  },
  somethingBlooming: "something's blooming…",
  noFlowers: (owner: boolean, handle: string) =>
    owner ? "you haven't planted anything yet. plant in atpotato's garden on the home page, or in a friend's garden." : `@${handle} hasn't planted anything yet.`,
  nothingHere: 'nothing here yet.',
  waterAll: (n: number) => `water them all (${n})`,
  wateringAll: (done: number, n: number) => `watering ${done} of ${n}…`,
  wateredAll: (n: number) => `watered ${n} ${n === 1 ? 'flower' : 'flowers'} (◕‿◕)`,
  careBars: (n: number) => `cared for ${n} of ${GROW_DAYS} days`,
  // numbers, people, guide
  numbers: {
    planted: 'flowers planted',
    growing: 'growing now',
    bloom: 'in bloom',
    pressed: 'pressed',
    rare: 'rare finds',
    care: 'days of care',
    tended: 'times tending',
    helped: 'people helped',
    helpers: 'helpers',
    visitors: 'visitors',
  },
  people: {
    gardens: (owner: boolean) => (owner ? "gardens you've planted in" : "gardens they've planted in"),
    visitors: (owner: boolean) => (owner ? 'planted in your garden' : 'planted in their garden'),
    helpers: (owner: boolean) => (owner ? "who's helped you" : "who's helped them"),
    helped: (owner: boolean) => (owner ? "who you've helped" : "who they've helped"),
    none: 'no connections yet. plant somewhere, or water someone else\'s flower.',
  },
  guideCount: (found: number, total: number) => `${found} of ${total} found`,
  looks: ['plain', 'two-tone', 'double', 'ladybug'] as const,
  guideCell: (kind: FlowerKind, look: string, state: 'found' | 'missing' | 'impossible') =>
    `${kind}, ${look}: ${state === 'found' ? 'found' : state === 'missing' ? 'not found yet' : "doesn't grow"}`,
  today: 'today',
  yesterday: 'yesterday',
} as const;

/* ---------- small helpers ---------- */

const HANDLE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/;

/** Which page and level an address is: null when it isn't a garden address. */
export function parseGardenPath(pathname: string): { actor: string | null; level: Level } | null {
  const m = /^\/garden(?:\/([^/]+)(\/flowers)?)?\/?$/.exec(pathname);
  if (!m) return null;
  if (!m[1]) return { actor: null, level: 'garden' };
  let actor: string;
  try {
    actor = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (actor === 'index.html') return { actor: null, level: 'garden' };
  if (!HANDLE_RE.test(actor) && !DID_RE.test(actor)) return null;
  return { actor: actor.startsWith('did:') ? actor : actor.toLowerCase(), level: m[2] ? 'flowers' : 'garden' };
}

/** True once the reader has seen this flower's bloom open. */
export function seenBloom(local: KeyValueStore, uri: string): boolean {
  try {
    const v = JSON.parse(local.get(SEEN_KEY) ?? 'null') as { uris?: unknown } | null;
    return Array.isArray(v?.uris) && v.uris.includes(uri);
  } catch {
    return false;
  }
}

export function markSeen(local: KeyValueStore, uri: string): void {
  let uris: string[] = [];
  try {
    const v = JSON.parse(local.get(SEEN_KEY) ?? 'null') as { uris?: unknown } | null;
    if (Array.isArray(v?.uris)) uris = v.uris.filter((u): u is string => typeof u === 'string');
  } catch {
    // start a fresh list
  }
  if (!uris.includes(uri)) uris.push(uri);
  local.set(SEEN_KEY, JSON.stringify({ uris: uris.slice(-100) }));
}

/**
 * A flower's care from its tends, as the server counts it: days its owner tended it while it
 * grew, plus up to three neighbours who helped, out of seven.
 */
export function careFrom(f: Pick<GardenerFlower, 'did' | 'plantedAt' | 'tends'>): number {
  const planted = Date.parse(f.plantedAt);
  const days = new Set<number>();
  const helpers = new Set<string>();
  for (const t of f.tends) {
    const age = Date.parse(t.at) - planted;
    if (!(age >= 0 && age < GROW_DAYS * DAY_MS)) continue;
    if (t.did === f.did) days.add(Math.floor(age / DAY_MS));
    else helpers.add(t.did);
  }
  return Math.round((Math.min(GROW_DAYS, days.size + Math.min(MAX_HELPERS, helpers.size)) / GROW_DAYS) * 100) / 100;
}

export interface Numbers {
  planted: number;
  growing: number;
  bloom: number;
  pressed: number;
  rare: number;
  care: number;
  gardens: number;
  helpers: number;
}

/** What someone's flowers add up to (rare finds count bloomed flowers with any rare look). */
export function numbersFor(person: Pick<GardenerView, 'did' | 'flowers'>, now: number): Numbers {
  const n: Numbers = { planted: person.flowers.length, growing: 0, bloom: 0, pressed: 0, rare: 0, care: 0, gardens: 0, helpers: 0 };
  const gardens = new Set<string>();
  const helpers = new Set<string>();
  for (const f of person.flowers) {
    const stage = stageFor(f.plantedAt, now, f.patch.open);
    if (!f.patch.open) n.pressed++;
    else if (stage === 'bloom') n.bloom++;
    else n.growing++;
    if (stage === 'bloom') {
      const v = flowerVariant(f);
      if (v.twoTone || v.double || v.ladybug) n.rare++;
    }
    n.care += Math.round(f.care * GROW_DAYS);
    gardens.add(f.patch.owner.did);
    for (const t of f.tends) if (t.did !== person.did) helpers.add(t.did);
  }
  n.gardens = gardens.size;
  n.helpers = helpers.size;
  return n;
}

/** Which flower to show up close: one waiting to be seen, then one that needs tending, then the newest. */
export function featuredFlower(flowers: readonly GardenerFlower[], opts: { owner: boolean; now: number; seen: (uri: string) => boolean; tendedToday: (f: GardenerFlower) => boolean }): GardenerFlower | null {
  const open = flowers.filter((f) => f.patch.open);
  const stage = (f: GardenerFlower) => stageFor(f.plantedAt, opts.now, f.patch.open);
  if (opts.owner) {
    const waiting = open.find((f) => stage(f) === 'bloom' && !opts.seen(f.uri));
    if (waiting) return waiting;
  }
  return (
    open.find((f) => stage(f) !== 'bloom' && !opts.tendedToday(f)) ??
    open.find((f) => f.thirsty) ??
    open.find((f) => stage(f) !== 'bloom') ??
    open[0] ??
    flowers[0] ??
    null
  );
}

/** "today", "yesterday", "tuesday", or "oct 3". */
function whenText(iso: string, now: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  };
  const ago = day(now) - day(Date.parse(iso));
  if (ago <= 0) return COPY.today;
  if (ago === 1) return COPY.yesterday;
  const d = new Date(iso);
  if (ago < 7) return d.toLocaleDateString('en', { weekday: 'long' }).toLowerCase();
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase();
}

const weekday = (t: number) => new Date(t).toLocaleDateString('en', { weekday: 'long' }).toLowerCase();
const shortDay = (t: number) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase();

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Record<TendAction, Array<[string, Record<string, string>]>> = {
  water: [['path', { d: 'M12 3c3.5 4.2 6 7.4 6 10.5A6 6 0 0 1 6 13.5C6 10.4 8.5 7.2 12 3z' }]],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }],
  ],
  talk: [['path', { d: 'M4 5h16v10H10l-6 4z' }]],
};

function icon(doc: Document, action: TendAction): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[action]) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

const TINTS = ['#C5E3B0', '#B3DDF0', '#FFD978', '#F3E7C4', '#F6CBD9', '#E6DCFA'];

/** A round face for someone: their avatar, or their initial on a tint picked from their DID. */
function face(doc: Document, p: { did: string; handle: string; avatar?: string | null }, cls: string): HTMLElement {
  const span = el(doc, 'span', { class: cls, 'aria-hidden': 'true' });
  if (p.avatar && /^https:\/\//.test(p.avatar)) {
    span.append(el(doc, 'img', { src: p.avatar, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }));
  } else {
    let h = 0;
    for (const c of p.did) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    span.style.background = TINTS[h % TINTS.length]!;
    span.textContent = (p.handle.replace(/^did:.*/, '?')[0] ?? '?').toLowerCase();
  }
  return span;
}

/** Makes an Auth whose start() runs once, however many parts of the page ask. */
function startOnce(auth: Auth | null): Auth | null {
  if (!auth) return null;
  let started: ReturnType<Auth['start']> | null = null;
  return { ...auth, start: () => (started ??= auth.start()) };
}

/* ---------- the page ---------- */

export interface GardenPageOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to createAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
  random?: () => number;
}

export async function initGardenPage(opts: GardenPageOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const page = doc.querySelector<HTMLElement>('[data-garden-page]');
  if (!page || page.dataset.gardenBound === 'true') return;
  page.dataset.gardenBound = 'true';
  const root: HTMLElement = page;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const setText = (node: HTMLElement | null, text: string) => {
    if (node) node.textContent = text;
  };
  const auth = startOnce(opts.auth === undefined ? createAuth(win) : opts.auth);

  // header
  const headAvatar = q('[data-head-avatar]');
  const headEyebrow = q('[data-head-eyebrow]');
  const headTitle = q('[data-head-title]');
  const headLede = q('[data-head-lede]');
  const headStats = q('[data-head-stats]');
  const headActions = q('[data-head-actions]');
  const headStatus = q('[data-head-status]');
  const levelsNav = q('[data-levels]');
  const how = q('[data-how]');

  let session: Session | null = null;
  let me: Me | null = null;
  let person: GardenerView | null = null;
  let owner = false;
  let actor = '';
  let level: Level = 'garden';
  let gardenView: GardenView | null = null;
  let controller: GardenController | null = null;
  let featured: GardenerFlower | null = null;
  let revealing = false;
  let filter: Filter = 'all';

  /* ---------- signing in, shared with the garden's own planting ---------- */

  let leaving: () => void = () => savePending(store, { kind: 'tend', returnTo: safeReturnTo(win.location.pathname) ?? '/garden', at: now() });
  const tendLeave = leaving;
  const signIn = auth
    ? mountSignIn({
        doc,
        win,
        dialog: doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin]'),
        auth,
        fetchImpl,
        local,
        now,
        beforeLeave: () => leaving(),
      })
    : null;
  const openSignIn = (lede: string, beforeLeave: () => void = tendLeave) => {
    leaving = beforeLeave;
    signIn?.open(lede);
  };

  function failed(error: unknown, say: (text: string) => void): void {
    const code = error instanceof RepoError ? error.status : 0;
    const authTrouble = code === 401 || ['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'].includes((error as Error)?.name ?? '');
    if (authTrouble || code === 403) {
      session = null;
      me = null;
      say(authTrouble ? PATCH_COPY.expired : PATCH_COPY.consent);
      openSignIn(authTrouble ? COPY.tendLede : PATCH_COPY.consent);
      return;
    }
    say(PATCH_COPY.failed);
  }

  /* ---------- levels ---------- */

  function showLevel(next: Level, focus = false): void {
    level = next;
    for (const panel of root.querySelectorAll<HTMLElement>('[data-level]')) panel.hidden = panel.dataset.level !== next;
    for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-level-link]')) {
      const which = a.dataset.levelLink as Level;
      a.href = gardenPath(actor, which);
      if (which === next) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (focus) headTitle?.focus();
  }

  levelsNav?.addEventListener('click', (event) => {
    const a = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('[data-level-link]') : null;
    const e = event as MouseEvent;
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return;
    event.preventDefault();
    const next = a.dataset.levelLink as Level;
    if (next === level) return;
    win.history.pushState({ level: next }, '', gardenPath(actor, next));
    showLevel(next);
  });
  win.addEventListener('popstate', () => {
    const route = parseGardenPath(win.location.pathname);
    if (route && person) showLevel(route.level);
  });

  /* ---------- the header ---------- */

  function renderStats(): void {
    if (!headStats || !person) return;
    const n = numbersFor(person, now());
    const visitors = visitorList().length;
    const chips: Array<[number, string]> = [
      [n.planted, COPY.stats.planted(n.planted)],
      [n.gardens, COPY.stats.gardens(n.gardens)],
    ];
    if (person.garden) chips.push([visitors, COPY.stats.visitors(visitors)]);
    chips.push([person.given.total, COPY.stats.tended(person.given.total)], [n.rare, COPY.stats.rare(n.rare)]);
    headStats.replaceChildren(
      ...chips.map(([value, label]) => {
        const li = el(doc, 'li', { class: 'garden-stats__item' });
        li.append(el(doc, 'strong', { class: 'garden-stats__value' }, String(value)), el(doc, 'span', { class: 'garden-stats__label' }, label));
        return li;
      }),
    );
    headStats.hidden = false;
  }

  function renderHead(): void {
    if (!person) return;
    // atpotato's page is the community garden, unless atpotato itself is reading.
    const community = person.did === GARDEN_SUBJECT && !owner;
    headAvatar?.replaceWith(face(doc, person, 'garden-head__avatar'));
    setText(headEyebrow, community ? COPY.community.eyebrow : COPY.eyebrow(owner));
    setText(headTitle, community ? COPY.community.title : person.displayName || `@${person.handle}`);
    setText(headLede, community ? COPY.community.lede : COPY.lede(person.handle, owner));
    renderStats();
    headActions?.replaceChildren();
    if (owner) {
      const copy = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm', 'data-copy-link': '' }, COPY.copyLink);
      copy.addEventListener('click', async () => {
        try {
          await win.navigator.clipboard.writeText(`${win.location.origin}${gardenPath(actorOf(person!))}`);
          setText(headStatus, COPY.copied);
        } catch {
          setText(headStatus, `${win.location.origin}${gardenPath(actorOf(person!))}`);
        }
      });
      headActions?.append(copy);
    } else if (me) {
      // From the community garden, your own is one tap away.
      headActions?.append(el(doc, 'a', { class: `btn ${community ? 'btn--primary' : 'btn--outline'} btn--sm`, href: gardenPath(actorOf(me)), 'data-your-garden': '' }, community ? COPY.community.yours : COPY.yourGarden));
    } else if (auth) {
      const b = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm' }, COPY.signInToTend);
      b.addEventListener('click', () => openSignIn(COPY.tendLede));
      headActions?.append(b);
    }
    doc.title = owner ? COPY.docTitle(null) : community ? COPY.community.docTitle : COPY.docTitle(person.displayName || `@${person.handle}`);
  }

  /* ---------- the garden level ---------- */

  const patchTile = q('[data-garden]');
  const setup = q('[data-setup]');
  const settings = q<HTMLDetailsElement>('[data-settings]');
  const visitorsCard = q('[data-visitors]');
  const none = q('[data-none]');

  /** People who planted in this person's garden (not them), newest first. */
  function visitorList(): Array<{ did: string; handle: string; kind: FlowerKind }> {
    if (!gardenView || !person) return [];
    const seen = new Set<string>();
    const out: Array<{ did: string; handle: string; kind: FlowerKind }> = [];
    for (const f of [...gardenView.flowers].reverse()) {
      if (f.did === person.did || seen.has(f.did)) continue;
      seen.add(f.did);
      out.push({ did: f.did, handle: f.handle, kind: f.kind });
    }
    return out;
  }

  function chip(p: { did: string; handle: string; avatar?: string | null }, extra?: string): HTMLLIElement {
    const li = el(doc, 'li');
    const a = el(doc, 'a', { class: 'garden-chip', href: gardenPath(actorOf(p)) });
    a.append(face(doc, p, 'garden-chip__face'), el(doc, 'span', { class: 'garden-chip__name' }, `@${p.handle}`));
    if (extra) a.append(el(doc, 'span', { class: 'garden-chip__extra' }, extra));
    li.append(a);
    return li;
  }

  function renderVisitors(): void {
    const list = visitorsCard?.querySelector('[data-visitors-list]');
    if (!visitorsCard || !list) return;
    const people = visitorList();
    visitorsCard.hidden = people.length === 0;
    setText(visitorsCard.querySelector<HTMLElement>('[data-visitors-title]'), COPY.visitors(people.length));
    list.replaceChildren(...people.map((p) => chip(p, p.kind)));
  }

  function sizeOf(patch: Pick<Patch, 'cols' | 'rows'>): Size | null {
    return (Object.keys(GARDEN_SIZES) as Size[]).find((k) => GARDEN_SIZES[k].cols === patch.cols && GARDEN_SIZES[k].rows === patch.rows) ?? null;
  }

  function fillForm(form: HTMLFormElement, values: { name: string; note: string; size: Size | null; open?: boolean; planting: Planting }): void {
    const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T | null;
    const name = field<HTMLInputElement>('name');
    const note = field<HTMLTextAreaElement>('note');
    if (name) name.value = values.name;
    if (note) note.value = values.note;
    for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="size"]')) radio.checked = radio.value === values.size;
    const open = field<HTMLInputElement>('open');
    if (open && values.open !== undefined) open.checked = values.open;
    const many = field<HTMLInputElement>('many');
    if (many) many.checked = values.planting === 'many';
  }

  function readForm(form: HTMLFormElement, fallback: { cols: number; rows: number }): { name: string; note: string; cols: number; rows: number; open: boolean; many: boolean } {
    const data = new FormData(form);
    const size = data.get('size');
    const dims = typeof size === 'string' && size in GARDEN_SIZES ? GARDEN_SIZES[size as Size] : fallback;
    return {
      name: String(data.get('name') ?? '').trim().slice(0, NAME_MAX * 4),
      note: String(data.get('note') ?? '').trim().slice(0, NOTE_MAX * 4),
      cols: dims.cols,
      rows: dims.rows,
      open: form.elements.namedItem('open') ? data.get('open') !== null : true,
      many: data.get('many') !== null,
    };
  }

  /** Saves the garden from a form; the saved version's CID, or null when it didn't save. */
  async function writeGarden(form: HTMLFormElement, status: HTMLElement | null, button: HTMLButtonElement | null, done: string, base: Patch | null): Promise<string | null> {
    if (!session || !me || !owner) {
      openSignIn(COPY.tendLede);
      return null;
    }
    if (button && isBusy(button)) return null;
    const v = readForm(form, base ?? GARDEN_SIZES.medium);
    if (!v.name) return null;
    if (button) setBusy(button, true);
    setText(status, COPY.setup.planting);
    try {
      const at = new Date(now());
      // Many each, or one each; a garden that moves flowers (set elsewhere) keeps doing so.
      const planting: Planting = v.many ? 'many' : base?.planting === 'move' ? 'move' : PLANTING[0];
      const record = gardenRecord(
        { name: v.name, note: v.note || null, cols: v.cols, rows: v.rows, createdAt: base?.createdAt, closesAt: v.open ? null : base?.closesAt && !base.open ? base.closesAt : at.toISOString(), planting },
        at,
      );
      const saved = await saveGarden(session, record);
      setText(status, done);
      return saved.cid;
    } catch (error) {
      failed(error, (text) => setText(status, text));
      return null;
    } finally {
      if (button) setBusy(button, false);
    }
  }

  function wireForms(): void {
    const setupForm = setup?.querySelector<HTMLFormElement>('[data-setup-form]');
    setupForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = setup!.querySelector<HTMLElement>('[data-setup-status]');
      const version = await writeGarden(setupForm, status, setupForm.querySelector('button[type="submit"]'), COPY.setup.done, null);
      if (!version) return;
      setup!.hidden = true;
      await showGarden(version);
      setText(headStatus, COPY.setup.done);
      burst(patchTile ?? setupForm, 'leaves', win);
      cheer(win);
    });
    const settingsForm = settings?.querySelector<HTMLFormElement>('[data-settings-form]');
    settingsForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = settings!.querySelector<HTMLElement>('[data-settings-status]');
      const version = await writeGarden(settingsForm, status, settingsForm.querySelector('button[type="submit"]'), COPY.setup.saved, gardenView?.patch ?? null);
      if (version) await controller?.reload(version);
    });
  }

  /**
   * The person's garden: their patch (planting, tabs, cards), or setting one up, or a note.
   * `version` is the garden its keeper just saved (its CID), to show that one.
   */
  async function showGarden(version?: string): Promise<void> {
    if (!person) return;
    const has = Boolean(version) || person.garden !== null;
    if (patchTile) patchTile.hidden = !has;
    if (setup) setup.hidden = !(owner && !has);
    if (none) none.hidden = owner || has;
    setText(none?.querySelector<HTMLElement>('[data-none-text]') ?? null, COPY.none(person.handle));
    if (owner && !has && setup) fillForm(setup.querySelector<HTMLFormElement>('[data-setup-form]')!, { name: COPY.setup.name(person.handle), note: '', size: 'medium', planting: PLANTING[0] });
    if (!has) return;
    if (controller) {
      await controller.reload(version);
      return;
    }
    controller = await initGarden({
      version,
      doc,
      win,
      root: patchTile ?? undefined,
      owner: person.did,
      returnTo: safeReturnTo(win.location.pathname) ?? '/garden',
      auth,
      openSignIn,
      fetchImpl,
      now,
      sessionStore: store,
      localStore: local,
      random: opts.random,
      onView: (v) => {
        gardenView = v;
        if (v.patch) patchTile?.style.setProperty('--garden-cols', String(v.patch.cols));
        renderVisitors();
        renderStats();
        renderNumbers();
        renderPeople();
        const p = v.patch;
        // Settings only for your own garden (record key "self").
        if (settings) settings.hidden = !(owner && p && p.rkey === OWN_PATCH_RKEY);
        if (settings && p && owner) {
          fillForm(settings.querySelector<HTMLFormElement>('[data-settings-form]')!, { name: p.name, note: p.note ?? '', size: sizeOf(p), open: p.open, planting: p.planting });
        }
      },
    });
  }

  /* ---------- the flowers level ---------- */

  const featuredCard = q('[data-featured]');
  const fBed = q('[data-featured-bed]');
  const fEyebrow = q('[data-featured-eyebrow]');
  const fTitle = q('[data-featured-title]');
  const fLede = q('[data-featured-lede]');
  const fWeek = q('[data-featured-week]');
  const fTend = q('[data-featured-tend]');
  const fCare = q('[data-featured-care]');
  const fActions = q('[data-featured-actions]');
  const fStatus = q('[data-featured-status]');
  const tendButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-featured-tend] [data-tend]')];
  const flowersCard = q('[data-flowers]');
  const waterAll = q<HTMLButtonElement>('[data-water-all]');
  const filters = q('[data-flowers-filters]');
  const list = q('[data-flowers-list]');
  const listStatus = q('[data-flowers-status]');
  const numbersCard = q('[data-numbers]');
  const peopleCard = q('[data-people]');
  const guideCard = q('[data-guide]');

  const whose = () => (owner ? 'your' : `@${person?.handle ?? ''}'s`);

  /** Did the reader already tend this flower today (by its growing day while it grows, else by date)? */
  function tendedToday(f: GardenerFlower): boolean {
    const t = now();
    if (wateredToday(local, f.uri, t)) return true;
    if (!me) return false;
    const planted = Date.parse(f.plantedAt);
    const growing = t - planted < GROW_DAYS * DAY_MS;
    const same = (at: string) =>
      growing ? Math.floor((Date.parse(at) - planted) / DAY_MS) === Math.floor((t - planted) / DAY_MS) : new Date(at).toISOString().slice(0, 10) === new Date(t).toISOString().slice(0, 10);
    return f.tends.some((x) => x.did === me!.did && same(x.at));
  }

  /** Tends `f` as the reader; false when they need to sign in first or it failed. */
  async function tendIt(f: GardenerFlower, action: TendAction, button: HTMLButtonElement | null, say: (text: string) => void): Promise<boolean> {
    if (!auth || !signIn) {
      say(COPY.otherHost);
      return false;
    }
    if (!session || !me) {
      openSignIn(COPY.tendLede);
      return false;
    }
    if (button && isBusy(button)) return false;
    if (button) setBusy(button, true);
    try {
      await tend(session, { uri: f.uri, cid: f.cid }, action, new Date(now()));
      markWatered(local, f.uri, now());
      const at = new Date(now()).toISOString();
      f.tends = [{ did: me.did, handle: me.handle, action, at }, ...f.tends];
      f.care = Math.max(f.care, careFrom(f));
      f.lastTended = at;
      f.thirsty = false;
      if (owner && person) {
        person.given.total++;
        if (f.did !== person.did && !person.given.recent.some((g) => g.flower.owner.did === f.did)) person.given.helped++;
      }
      return true;
    } catch (error) {
      failed(error, say);
      return false;
    } finally {
      if (button) setBusy(button, false);
    }
  }

  function afterTend(f: GardenerFlower): void {
    if (featured === f) renderFeatured();
    renderList();
    renderNumbers();
    renderPeople();
    renderStats();
  }

  function renderWeek(f: GardenerFlower, stage: Stage): void {
    if (!fWeek) return;
    const planted = Date.parse(f.plantedAt);
    const today = Math.floor((now() - planted) / DAY_MS);
    const byDay = new Map<number, TendAction>();
    for (const t of [...f.tends].reverse()) {
      if (t.did !== f.did) continue;
      const d = Math.floor((Date.parse(t.at) - planted) / DAY_MS);
      if (d >= 0 && d < GROW_DAYS && !byDay.has(d)) byDay.set(d, t.action);
    }
    const days = Array.from({ length: GROW_DAYS }, (_, d) => {
      const did = byDay.get(d);
      const state = did ? 'tended' : d === today && stage !== 'bloom' ? 'today' : d < today ? 'missed' : 'ahead';
      const li = el(doc, 'li', { class: `garden-week__day is-${state}`, 'aria-label': COPY.day(d + 1, COPY.dayHow[state]) });
      if (did) li.append(icon(doc, did));
      else li.textContent = String(d + 1);
      return li;
    });
    const end = el(doc, 'li', { class: `garden-week__bloom${stage === 'bloom' ? ' is-done' : ''}`, 'aria-label': COPY.day(GROW_DAYS + 1, COPY.bloomDay) });
    const small = drawFlower(doc, f.kind, 'bloom', stage === 'bloom' ? flowerVariant(f) : sampleVariant(f.kind));
    if (stage !== 'bloom') small.classList.add('home-flower--ghost');
    end.append(small, el(doc, 'span', {}, COPY.bloomDay));
    fWeek.replaceChildren(...days, end);
    fWeek.hidden = false;
  }

  function oddsLine(f: GardenerFlower): string {
    const odds = rarityOdds(f.kind, f.care);
    const pct = (p: number) => `${p < 0.1 ? (p * 100).toFixed(1).replace(/\.0$/, '') : Math.round(p * 100)}%`;
    const parts = [COPY.care(Math.round(f.care * GROW_DAYS))];
    if (odds.twoTone !== null) parts.push(`${COPY.odds.twoTone} ${pct(odds.twoTone)}`);
    if (odds.double !== null) parts.push(`${COPY.odds.double} ${pct(odds.double)}`);
    parts.push(`${COPY.odds.ladybug} ${pct(odds.ladybug)}`);
    return parts.join(' · ');
  }

  function ribbonFor(v: Variant): string {
    return COPY.ribbon[v.double ? 'double' : v.twoTone ? 'twoTone' : v.ladybug ? 'ladybug' : 'plain'];
  }

  function renderFeatured(): void {
    const f = featured;
    if (!featuredCard) return;
    featuredCard.hidden = !f;
    if (!f) return;
    const open = f.patch.open;
    const stage = stageFor(f.plantedAt, now(), open);
    const v = flowerVariant(f);
    const place = COPY.place(f.patch);
    const waiting = owner && open && stage === 'bloom' && !seenBloom(local, f.uri);
    setText(fEyebrow, COPY.featuredEyebrow(place, f.plot + 1));
    fBed?.classList.toggle('is-revealing', revealing);
    fBed?.classList.toggle('is-pressed', !open);
    fBed?.replaceChildren(drawFlower(doc, f.kind, waiting ? 'bud' : stage, v));
    if (revealing) fBed?.append(el(doc, 'span', { class: 'garden-hero__ribbon' }, ribbonFor(v)));
    fActions?.replaceChildren();
    if (fCare) fCare.hidden = true;
    if (fWeek) fWeek.hidden = true;
    if (fTend) fTend.hidden = true;
    if (waiting) {
      setText(fTitle, COPY.waiting);
      setText(fLede, COPY.waitingLede);
      fActions?.append(el(doc, 'button', { type: 'button', class: 'btn btn--primary', 'data-reveal': '' }, COPY.takeALook));
      return;
    }
    if (!open) {
      setText(fTitle, describeBloom(f.kind, v));
      setText(fLede, COPY.pressedLede(place, Math.round(f.care * GROW_DAYS)));
    } else if (stage !== 'bloom') {
      setText(fTitle, COPY.growing(owner ? 'a' : whose(), f.kind, stage));
      const when = weekday(bloomsAt(f.plantedAt));
      setText(fLede, owner ? COPY.growingLede(dayOf(f.plantedAt, now()), when) : COPY.visitingLede(dayOf(f.plantedAt, now()), when));
      if (owner && fCare) {
        fCare.textContent = oddsLine(f);
        fCare.hidden = false;
      }
    } else if (f.thirsty) {
      setText(fTitle, COPY.thirsty(whose(), f.kind));
      setText(fLede, COPY.thirstyLede(thirstyDays(f, now())));
    } else {
      setText(fTitle, describeBloom(f.kind, v));
      setText(fLede, COPY.bloomLede(shortDay(bloomsAt(f.plantedAt)), Math.round(f.care * GROW_DAYS)));
    }
    renderWeek(f, open ? stage : 'bloom');
    if (fTend && open) {
      fTend.hidden = false;
      const done = tendedToday(f);
      for (const b of tendButtons) {
        b.hidden = !owner && b.dataset.tend !== 'water';
        b.disabled = done;
      }
    }
    fActions?.append(el(doc, 'a', { class: 'btn btn--outline btn--sm', href: gardenPath(actorOf(f.patch.owner)) }, COPY.visit));
  }

  for (const b of tendButtons) {
    b.addEventListener('click', async () => {
      const f = featured;
      const action = b.dataset.tend as TendAction;
      if (!f) return;
      if (!(await tendIt(f, action, b, (text) => setText(fStatus, text)))) return;
      revealing = false;
      afterTend(f);
      setText(fStatus, owner ? COPY.tended[action] : COPY.visitorWatered);
      burst(fBed ?? b, action === 'water' ? 'drops' : 'leaves', win);
      cheer(win);
    });
  }

  fActions?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-reveal]') || !featured) return;
    const f = featured;
    markSeen(local, f.uri);
    revealing = true;
    renderFeatured();
    renderList();
    const v = flowerVariant(f);
    setText(fStatus, COPY.bloomed(f.kind, describeBloom(f.kind, v)));
    burst(fBed ?? target, 'petals', win, v.colourway.slice(0, 3));
    cheer(win);
    fTitle?.focus();
  });

  function feature(f: GardenerFlower): void {
    featured = f;
    revealing = false;
    setText(fStatus, '');
    renderFeatured();
    renderList();
    featuredCard?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    fTitle?.focus();
  }

  function groupOf(f: GardenerFlower): Exclude<Filter, 'all'> {
    if (!f.patch.open) return 'pressed';
    return stageFor(f.plantedAt, now(), true) === 'bloom' ? 'bloom' : 'growing';
  }

  function careBars(f: GardenerFlower): HTMLElement {
    const n = Math.round(f.care * GROW_DAYS);
    const bars = el(doc, 'span', { class: 'garden-flower__care', role: 'img', 'aria-label': COPY.careBars(n) });
    for (let i = 0; i < GROW_DAYS; i++) bars.append(el(doc, 'span', { class: i < n ? 'is-on' : '' }));
    return bars;
  }

  function flowerItem(f: GardenerFlower): HTMLLIElement {
    const open = f.patch.open;
    const stage = stageFor(f.plantedAt, now(), open);
    const v = flowerVariant(f);
    const place = COPY.place(f.patch);
    const waiting = owner && open && stage === 'bloom' && !seenBloom(local, f.uri);
    const li = el(doc, 'li', { class: 'garden-flower', 'data-flower': f.uri });
    li.classList.toggle('is-featured', f === featured);
    li.classList.toggle('is-pressed', !open);
    li.classList.toggle('is-thirsty', open && f.thirsty);
    const bed = el(doc, 'span', { class: 'garden-flower__bed', 'aria-hidden': 'true' });
    bed.append(drawFlower(doc, f.kind, waiting ? 'bud' : stage, v));
    const words = el(doc, 'span', { class: 'garden-flower__words' });
    const name = waiting
      ? COPY.somethingBlooming
      : stage === 'bloom'
        ? describeBloom(f.kind, v)
        : COPY.growing(owner ? 'a' : whose(), f.kind, stage);
    const nameButton = el(doc, 'button', { type: 'button', class: 'garden-flower__name' }, name);
    nameButton.addEventListener('click', () => feature(f));
    const meta = !open ? COPY.meta.pressed(place) : stage !== 'bloom' ? COPY.meta.growing(place, dayOf(f.plantedAt, now())) : f.thirsty ? COPY.meta.thirsty(place) : COPY.meta.bloom(place);
    words.append(nameButton, el(doc, 'span', { class: 'garden-flower__meta' }, meta), careBars(f));
    li.append(bed, words);
    if (open) {
      const tools = el(doc, 'span', { class: 'garden-flower__tend' });
      const done = tendedToday(f);
      for (const action of owner ? (['water', 'sun', 'talk'] as const) : (['water'] as const)) {
        const b = el(doc, 'button', { type: 'button', class: `garden-flower__tool is-${action}`, 'aria-label': COPY.tendLabel(action, whose(), f.kind) });
        b.append(icon(doc, action));
        b.disabled = done;
        b.addEventListener('click', async () => {
          if (!(await tendIt(f, action, b, (text) => setText(listStatus, text)))) return;
          afterTend(f);
          setText(listStatus, owner ? COPY.tended[action] : COPY.visitorWatered);
          burst(li.querySelector('.garden-flower__bed') ?? li, action === 'water' ? 'drops' : 'leaves', win);
        });
        tools.append(b);
      }
      li.append(tools);
    }
    return li;
  }

  function renderList(): void {
    if (!flowersCard || !list || !person) return;
    const flowers = person.flowers;
    flowersCard.hidden = false;
    setText(flowersCard.querySelector<HTMLElement>('[data-flowers-title]'), COPY.flowersTitle(owner, flowers.length));
    const counts: Record<Filter, number> = { all: flowers.length, growing: 0, bloom: 0, pressed: 0 };
    for (const f of flowers) counts[groupOf(f)]++;
    filters?.replaceChildren(
      ...(['all', 'growing', 'bloom', 'pressed'] as const)
        .filter((k) => k === 'all' || counts[k] > 0)
        .map((k) => {
          const b = el(doc, 'button', { type: 'button', class: 'garden-filters__btn', 'aria-pressed': String(k === filter) }, COPY.filterLabel(k, counts[k]));
          b.addEventListener('click', () => {
            filter = k;
            renderList();
          });
          return b;
        }),
    );
    if (filters) filters.hidden = flowers.length === 0;
    const shown = flowers.filter((f) => filter === 'all' || groupOf(f) === filter);
    list.replaceChildren(...shown.map(flowerItem));
    if (!flowers.length) setText(listStatus, COPY.noFlowers(owner, person.handle));
    else if (!shown.length) setText(listStatus, COPY.nothingHere);
    // Water them all: your open flowers that haven't been looked after today.
    if (waterAll) {
      const due = owner ? flowers.filter((f) => f.patch.open && !tendedToday(f)) : [];
      waterAll.hidden = due.length === 0;
      if (!isBusy(waterAll)) waterAll.textContent = COPY.waterAll(due.length);
    }
  }

  waterAll?.addEventListener('click', async () => {
    if (!person || isBusy(waterAll)) return;
    const due = person.flowers.filter((f) => f.patch.open && !tendedToday(f));
    setBusy(waterAll, true);
    let done = 0;
    try {
      for (const f of due) {
        setText(listStatus, COPY.wateringAll(done + 1, due.length));
        if (!(await tendIt(f, 'water', null, (text) => setText(listStatus, text)))) return;
        done++;
      }
      setText(listStatus, COPY.wateredAll(done));
      burst(waterAll, 'drops', win);
      cheer(win);
    } finally {
      setBusy(waterAll, false);
      if (featured) renderFeatured();
      renderList();
      renderNumbers();
      renderStats();
      if (done) setText(listStatus, COPY.wateredAll(done));
    }
  });

  function renderNumbers(): void {
    const dl = numbersCard?.querySelector('[data-numbers-list]');
    if (!numbersCard || !dl || !person) return;
    const n = numbersFor(person, now());
    const rows: Array<[string, number]> = [
      [COPY.numbers.planted, n.planted],
      [COPY.numbers.growing, n.growing],
      [COPY.numbers.bloom, n.bloom],
      [COPY.numbers.pressed, n.pressed],
      [COPY.numbers.rare, n.rare],
      [COPY.numbers.care, n.care],
      [COPY.numbers.tended, person.given.total],
      [COPY.numbers.helped, person.given.helped],
      [COPY.numbers.helpers, n.helpers],
    ];
    if (person.garden) rows.push([COPY.numbers.visitors, visitorList().length]);
    dl.replaceChildren(
      ...rows.map(([label, value]) => {
        const div = el(doc, 'div', { class: 'garden-numbers__item' });
        div.append(el(doc, 'dt', {}, label), el(doc, 'dd', {}, String(value)));
        return div;
      }),
    );
    numbersCard.hidden = false;
  }

  function renderPeople(): void {
    const groups = peopleCard?.querySelector('[data-people-groups]');
    if (!peopleCard || !groups || !person) return;
    const self = person.did;
    const tally = (items: Array<{ did: string; handle: string }>) => {
      const by = new Map<string, { did: string; handle: string; n: number }>();
      for (const p of items) {
        if (p.did === self) continue;
        const had = by.get(p.did);
        if (had) had.n++;
        else by.set(p.did, { did: p.did, handle: p.handle, n: 1 });
      }
      return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 12);
    };
    const sections: Array<[string, Array<{ did: string; handle: string; n: number }>]> = [
      [COPY.people.gardens(owner), tally(person.flowers.map((f) => f.patch.owner))],
      [COPY.people.visitors(owner), tally(visitorList())],
      [COPY.people.helpers(owner), tally(person.flowers.flatMap((f) => f.tends.map((t) => ({ did: t.did, handle: t.handle }))))],
      [COPY.people.helped(owner), tally(person.given.recent.map((g) => g.flower.owner))],
    ];
    const filled = sections.filter(([, people]) => people.length);
    groups.replaceChildren(
      ...(filled.length
        ? filled.map(([title, people]) => {
            const div = el(doc, 'div', { class: 'garden-people__group' });
            const ul = el(doc, 'ul', { class: 'garden-chips', role: 'list' });
            ul.append(...people.map((p) => chip(p, p.n > 1 ? `×${p.n}` : undefined)));
            div.append(el(doc, 'h3', { class: 'garden-people__title' }, title), ul);
            return div;
          })
        : [el(doc, 'p', { class: 'garden-card__note' }, COPY.people.none)]),
    );
    peopleCard.hidden = false;
  }

  function renderGuide(): void {
    const table = guideCard?.querySelector<HTMLTableElement>('[data-guide-table]');
    if (!guideCard || !table || !person) return;
    const found = new Map<string, GardenerFlower>();
    for (const f of person.flowers) {
      if (stageFor(f.plantedAt, now(), f.patch.open) !== 'bloom') continue;
      const v = flowerVariant(f);
      const looks = ['plain', v.twoTone ? 'two-tone' : '', v.double ? 'double' : '', v.ladybug ? 'ladybug' : ''].filter(Boolean);
      for (const look of looks) if (!found.has(`${f.kind}/${look}`)) found.set(`${f.kind}/${look}`, f);
    }
    let total = 0;
    const head = el(doc, 'tr');
    head.append(el(doc, 'th', { scope: 'col', class: 'visually-hidden' }, 'kind'), ...COPY.looks.map((l) => el(doc, 'th', { scope: 'col' }, l)));
    const thead = el(doc, 'thead');
    thead.append(head);
    const tbody = el(doc, 'tbody');
    for (const kind of FLOWER_KINDS) {
      const tr = el(doc, 'tr');
      tr.append(el(doc, 'th', { scope: 'row' }, kind));
      for (const look of COPY.looks) {
        const possible = !(look === 'two-tone' && kind === 'rose') && !(look === 'double' && !['sunflower', 'daisy', 'poppy'].includes(kind));
        if (possible) total++;
        const got = found.get(`${kind}/${look}`);
        const td = el(doc, 'td');
        const cell = el(doc, 'span', { class: `garden-guide__cell is-${got ? 'found' : possible ? 'missing' : 'impossible'}`, role: 'img', 'aria-label': COPY.guideCell(kind, look, got ? 'found' : possible ? 'missing' : 'impossible') });
        if (got) {
          const v = flowerVariant(got);
          cell.append(drawFlower(doc, kind, 'bloom', { ...v, twoTone: look === 'two-tone', double: look === 'double', ladybug: look === 'ladybug' }));
        } else cell.textContent = possible ? '?' : '·';
        td.append(cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
    setText(guideCard.querySelector<HTMLElement>('[data-guide-count]'), COPY.guideCount(found.size, total));
    guideCard.hidden = false;
  }

  function fillHow(): void {
    if (!how) return;
    how.hidden = false;
    for (const spot of how.querySelectorAll<HTMLElement>('[data-how]')) {
      const which = spot.dataset.how;
      const stage: Stage = which === 'sprout' || which === 'bud' ? which : 'bloom';
      spot.replaceChildren(drawFlower(doc, 'tulip', stage, { ...sampleVariant('tulip'), twoTone: stage === 'bloom' }));
    }
  }

  /* ---------- load ---------- */

  const route = parseGardenPath(win.location.pathname);
  const pending = readPending(store, now());
  // Back from signing in to tend: nothing more to do here, unless it was a flower in the
  // garden below (TEND_KEY), which the garden waters itself once it loads.
  if (pending?.kind === 'tend' && safeReturnTo(win.location.pathname) === pending.returnTo && !store.get(TEND_KEY)) clearPending(store);

  if (auth?.eager) {
    const result = await auth.start();
    if (result.session) {
      session = result.session;
      me = await loadMe(fetchImpl, session.did);
      if (!me.handle.startsWith('did:')) rememberReader(me.handle);
    }
  }

  if (!route) {
    root.dataset.state = 'missing';
    setText(headTitle, COPY.missing.title);
    setText(headLede, COPY.missing.lede(win.location.pathname.split('/')[2] ?? ''));
    headActions?.replaceChildren(el(doc, 'a', { class: 'btn btn--primary', href: '/garden' }, COPY.community.visit));
    return;
  }

  // /garden is the community garden, signed in or not: atpotato's page, at this address.
  const asked = route.actor ?? GARDEN_SUBJECT;
  const loaded = await fetchGardener(asked, fetchImpl);
  if (loaded === 'missing' || loaded === null) {
    root.dataset.state = loaded === 'missing' ? 'missing' : 'error';
    setText(headTitle, loaded === 'missing' ? COPY.missing.title : headTitle?.textContent ?? '');
    setText(headLede, loaded === 'missing' ? COPY.missing.lede(asked) : COPY.loadFailed);
    if (route.actor) headActions?.replaceChildren(el(doc, 'a', { class: 'btn btn--primary', href: '/garden' }, COPY.community.visit));
    return;
  }
  person = loaded;
  owner = me?.did === person.did;
  actor = route.actor ?? actorOf(person);
  root.dataset.state = 'ready';
  root.classList.toggle('is-own', owner);
  renderHead();
  if (levelsNav) levelsNav.hidden = false;
  showLevel(route.level);
  wireForms();

  featured = featuredFlower(person.flowers, { owner, now: now(), seen: (uri) => seenBloom(local, uri), tendedToday });
  renderFeatured();
  renderList();
  renderNumbers();
  renderPeople();
  renderGuide();
  // How it grows: for anyone at the community garden, and on your own page until you plant.
  if ((person.did === GARDEN_SUBJECT && !owner) || (owner && !person.flowers.length)) fillHow();
  await showGarden();
}

export function init(): Promise<void> {
  return initGardenPage();
}
