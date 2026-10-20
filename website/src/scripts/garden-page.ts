/**
 * The garden page (/garden, garden/index.html): your flower from the flower patch, up close.
 *
 * Signed in, it shows the reader's flower in this season's patch: how far it has grown, the
 * week so far, and buttons to water it, give it sun or talk to it (once a day; each is a
 * to.atpota.garden.tend record in their own repo). Below: who has helped, which neighbours
 * look thirsty (with a button to water theirs), and every flower they grew in seasons gone
 * by, pressed (the herbarium). On the day it blooms, the bud waits for them to take a look,
 * then opens. /garden?did=… shows anyone's garden; a visitor can water that flower too.
 *
 * Everything comes from /api/gardener (server/gardener.ts), plus /api/garden for the
 * neighbours. Signing in is the blog's (src/blog/signin.ts): a "tend" pending action brings
 * the reader back here, to the garden they were visiting (VISIT_KEY). Care shown after a
 * tend is worked out here until the next load (careFrom, the same rule as the server's).
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { RepoError } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, safeReturnTo, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { bloomsAt, DAY_MS, drawFlower, GROW_DAYS, rarityOdds, sampleVariant, stageFor, type FlowerKind, type Stage } from './flowers';
import {
  COPY as PATCH_COPY,
  dayOf,
  describeBloom,
  fetchGarden,
  fetchGardener,
  flowerVariant,
  markWatered,
  tend,
  thirstyDays,
  wateredToday,
  type Flower,
  type GardenerFlower,
  type TendAction,
} from './garden';
import { rememberReader } from './reader';

/** localStorage: the blooms this reader has already seen open ({ uris }). */
export const SEEN_KEY = 'garden:seen';
/** sessionStorage: whose garden the reader was visiting before leaving to sign in. */
export const VISIT_KEY = 'garden:visit';
/** Neighbours who help count towards a flower's care, up to this many (server/garden.ts). */
const MAX_HELPERS = 3;

export const COPY = {
  loadFailed: "your garden didn't load just now. try again in a moment?",
  yourGarden: 'your garden',
  theirGarden: (handle: string) => `@${handle}'s garden`,
  title: (handle: string | null) => (handle ? `@${handle}'s garden · atpotato` : 'your garden · atpotato'),
  signedOut: {
    title: 'sign in to see your garden',
    lede: 'your flowers live in your own bluesky repo. sign in to look after yours, or plant one in the flower patch on the home page.',
    button: 'sign in with bluesky',
  },
  otherHost: 'the garden works on atpota.to.',
  toPatch: 'go to the flower patch',
  empty: { title: 'nothing growing yet', lede: "plant a flower in this season's patch, and you can look after it here." },
  emptyTheirs: (handle: string) => `@${handle} hasn't planted a flower this season.`,
  eyebrow: (patch: string, plot: number) => `${patch} · plot ${plot}`,
  growing: (whose: string, kind: FlowerKind, stage: Stage) => `${whose} ${kind}, ${stage === 'sprout' ? 'just planted' : 'budding'}`,
  growingLede: (day: number, weekday: string) =>
    `day ${day} of ${GROW_DAYS}. it blooms on ${weekday}, and the better it's looked after this week, the better it'll grow.`,
  visitingLede: (day: number, weekday: string) => `day ${day} of ${GROW_DAYS}. it blooms on ${weekday}. a little water from you counts towards its care.`,
  waiting: `day ${GROW_DAYS}. something's happening…`,
  waitingLede: 'your flower has finished growing. come and see what it turned into.',
  takeALook: 'take a look',
  bloomLede: (since: string, care: number) => `in bloom since ${since}. cared for ${care} of ${GROW_DAYS} days.`,
  thirsty: (whose: string, kind: FlowerKind) => `${whose} ${kind} looks thirsty`,
  thirstyLede: (days: number) => `nobody's watered it for ${days} ${days === 1 ? 'day' : 'days'}. a drink will perk it right up.`,
  ribbon: { double: 'a second ring!', twoTone: 'two-tone!', ladybug: 'a ladybug moved in!', plain: 'in full bloom!' },
  bloomed: (kind: FlowerKind, bloom: string) => `your ${kind} bloomed: ${bloom}.`,
  care: (n: number) => `care so far: ${n} of ${GROW_DAYS}`,
  odds: { twoTone: 'two-tone', double: 'second ring', ladybug: 'ladybug' },
  tended: {
    water: 'watered! it drank the lot. see you tomorrow.',
    sun: 'it soaked up the sun. see you tomorrow.',
    talk: 'you told it about your day. it leaned in. see you tomorrow.',
  } satisfies Record<TendAction, string>,
  tendedToday: 'looked after today. come back tomorrow.',
  visitorWatered: 'watered! thanks for helping it along.',
  tendLede: 'sign in with your bluesky account to look after flowers. each one is a small record in your own repo.',
  helped: { water: 'watered it', sun: 'gave it some sun', talk: 'talked to it' } satisfies Record<TendAction, string>,
  nearThirsty: (handle: string, kind: FlowerKind) => `@${handle}'s ${kind} looks thirsty`,
  nearHappy: 'your neighbours all look happy.',
  nearWater: 'water',
  nearWatered: 'watered',
  herbarium: (n: number) => `your herbarium · ${n} pressed`,
  herbariumTheirs: (handle: string, n: number) => `@${handle}'s herbarium · ${n} pressed`,
  pressedEyebrow: (patch: string) => `${patch} has closed`,
  pressedTitle: (kind: FlowerKind) => `your ${kind} was pressed`,
  pressedLede: "it's in your herbarium for keeps, and the record stays in your repo. a new patch is open in the flower patch on the home page.",
  pressedCard: (season: string, care: number) => `${season} · care ${care}/${GROW_DAYS}`,
  today: 'today',
  yesterday: 'yesterday',
  day: (n: number, how: string) => `day ${n}: ${how}`,
  dayHow: { tended: 'looked after', today: 'today', missed: 'not looked after', ahead: 'still to come' },
  bloomDay: 'bloom',
} as const;

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
  local.set(SEEN_KEY, JSON.stringify({ uris: uris.slice(-50) }));
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

export interface GardenPageOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to createAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
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
  const bed = q('[data-garden-bed]');
  const eyebrow = q('[data-garden-eyebrow]');
  const title = q('[data-garden-title]');
  const lede = q('[data-garden-lede]');
  const week = q('[data-garden-week]');
  const tendRow = q('[data-garden-tend]');
  const careLine = q('[data-garden-care]');
  const actions = q('[data-garden-actions]');
  const status = q('[data-garden-status]');
  const helpers = q('[data-garden-helpers]');
  const near = q('[data-garden-near]');
  const herbarium = q('[data-garden-herbarium]');
  const how = q('[data-garden-how]');
  const tendButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-tend]')];
  const auth = opts.auth === undefined ? createAuth(win) : opts.auth;

  let session: Session | null = null;
  let me: Me | null = null;
  let flower: GardenerFlower | null = null;
  let owner = false;
  let handle = '';

  const say = (text: string) => {
    if (status) status.textContent = text;
  };
  const setText = (node: HTMLElement | null, text: string) => {
    if (node) node.textContent = text;
  };

  const params = new URLSearchParams(win.location.search ?? '');
  const pending = readPending(store, now());
  const back = pending?.kind === 'tend' && safeReturnTo(win.location.pathname) === pending.returnTo;
  if (back) clearPending(store);
  const visit = back ? store.get(VISIT_KEY) : null;
  store.remove(VISIT_KEY);
  const asked = [params.get('did'), visit].find((d): d is string => typeof d === 'string' && /^did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}$/.test(d)) ?? null;

  const signIn: SignIn | null = auth
    ? mountSignIn({
        doc,
        win,
        dialog: doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin]'),
        auth,
        fetchImpl,
        local,
        now,
        beforeLeave: () => {
          savePending(store, { kind: 'tend', returnTo: safeReturnTo(win.location.pathname) ?? '/garden', at: now() });
          if (asked) store.set(VISIT_KEY, asked);
        },
      })
    : null;

  function failed(error: unknown): void {
    const code = error instanceof RepoError ? error.status : 0;
    const authTrouble = code === 401 || ['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'].includes((error as Error)?.name ?? '');
    if (authTrouble || code === 403) {
      session = null;
      me = null;
      say(authTrouble ? PATCH_COPY.expired : PATCH_COPY.consent);
      signIn?.open(authTrouble ? COPY.tendLede : PATCH_COPY.consent);
      return;
    }
    say(PATCH_COPY.failed);
  }

  /** Tends `target` as the reader; false when they need to sign in first or it failed. */
  async function tendIt(target: { uri: string; cid: string }, action: TendAction, button: HTMLButtonElement): Promise<boolean> {
    if (!auth || !signIn) {
      say(COPY.otherHost);
      return false;
    }
    if (!session || !me) {
      signIn.open(COPY.tendLede);
      return false;
    }
    if (isBusy(button)) return false;
    setBusy(button, true);
    try {
      await tend(session, target, action, new Date(now()));
      markWatered(local, target.uri, now());
      return true;
    } catch (error) {
      failed(error);
      return false;
    } finally {
      setBusy(button, false);
    }
  }

  function link(href: string, text: string, cls = 'btn btn--primary'): HTMLAnchorElement {
    return el(doc, 'a', { class: cls, href }, text);
  }

  function fillHow(): void {
    if (!how) return;
    how.hidden = false;
    for (const spot of how.querySelectorAll<HTMLElement>('[data-garden-how]')) {
      const which = spot.dataset.gardenHow;
      const stage: Stage = which === 'sprout' || which === 'bud' ? which : 'bloom';
      const v = { ...sampleVariant('tulip'), twoTone: which === 'bloom' || which === 'pressed' };
      spot.replaceChildren(drawFlower(doc, 'tulip', stage, v));
    }
  }

  /* ---------- the hero ---------- */

  /** Did the viewer already tend this flower today (by its growing day while it grows, else by date)? */
  function tendedToday(f: GardenerFlower): boolean {
    if (!me) return false;
    const planted = Date.parse(f.plantedAt);
    const t = now();
    const growing = t - planted < GROW_DAYS * DAY_MS;
    const same = (at: string) =>
      growing ? Math.floor((Date.parse(at) - planted) / DAY_MS) === Math.floor((t - planted) / DAY_MS) : new Date(at).toISOString().slice(0, 10) === new Date(t).toISOString().slice(0, 10);
    return f.tends.some((x) => x.did === me!.did && same(x.at)) || wateredToday(local, f.uri, t);
  }

  function renderWeek(f: GardenerFlower, stage: Stage): void {
    if (!week) return;
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
    const v = stage === 'bloom' ? flowerVariant(f) : sampleVariant(f.kind);
    const small = drawFlower(doc, f.kind, 'bloom', v);
    if (stage !== 'bloom') small.classList.add('home-flower--ghost');
    end.append(small, el(doc, 'span', {}, COPY.bloomDay));
    week.replaceChildren(...days, end);
    week.hidden = false;
  }

  function renderCare(f: GardenerFlower): void {
    if (!careLine) return;
    const odds = rarityOdds(f.kind, f.care);
    const pct = (p: number) => `${p < 0.1 ? (p * 100).toFixed(1).replace(/\.0$/, '') : Math.round(p * 100)}%`;
    const parts = [COPY.care(Math.round(f.care * GROW_DAYS))];
    if (odds.twoTone !== null) parts.push(`${COPY.odds.twoTone} ${pct(odds.twoTone)}`);
    if (odds.double !== null) parts.push(`${COPY.odds.double} ${pct(odds.double)}`);
    parts.push(`${COPY.odds.ladybug} ${pct(odds.ladybug)}`);
    careLine.textContent = parts.join(' · ');
    careLine.hidden = false;
  }

  function showFlower(f: GardenerFlower, opts: { reveal?: boolean } = {}): void {
    const open = f.patch.open;
    const stage = stageFor(f.plantedAt, now(), open);
    const v = flowerVariant(f);
    const whose = owner ? 'your' : `@${handle}'s`;
    const waiting = owner && open && stage === 'bloom' && !seenBloom(local, f.uri) && !opts.reveal;
    setText(eyebrow, COPY.eyebrow(f.patch.name, f.plot + 1));
    bed?.classList.toggle('is-revealing', Boolean(opts.reveal));
    bed?.classList.remove('is-pressed');
    bed?.replaceChildren(drawFlower(doc, f.kind, waiting ? 'bud' : stage, v));
    if (opts.reveal) {
      const v2 = v.double ? 'double' : v.twoTone ? 'twoTone' : v.ladybug ? 'ladybug' : 'plain';
      bed?.append(el(doc, 'span', { class: 'garden-hero__ribbon' }, COPY.ribbon[v2]));
    }
    actions?.replaceChildren();
    if (careLine) careLine.hidden = true;
    if (waiting) {
      setText(title, COPY.waiting);
      setText(lede, COPY.waitingLede);
      const look = el(doc, 'button', { type: 'button', class: 'btn btn--primary', 'data-garden-reveal': '' }, COPY.takeALook);
      actions?.append(look);
      if (tendRow) tendRow.hidden = true;
      if (week) week.hidden = true;
      return;
    }
    if (stage !== 'bloom') {
      setText(title, COPY.growing(owner ? 'a' : whose, f.kind, stage));
      const when = weekday(bloomsAt(f.plantedAt));
      setText(lede, owner ? COPY.growingLede(dayOf(f.plantedAt, now()), when) : COPY.visitingLede(dayOf(f.plantedAt, now()), when));
      if (owner) renderCare(f);
    } else if (open && f.thirsty) {
      setText(title, COPY.thirsty(whose, f.kind));
      setText(lede, COPY.thirstyLede(thirstyDays(f, now())));
    } else {
      setText(title, describeBloom(f.kind, v));
      setText(lede, COPY.bloomLede(shortDay(bloomsAt(f.plantedAt)), Math.round(f.care * GROW_DAYS)));
    }
    renderWeek(f, stage);
    // Tending: the owner gets all three; a visitor can water it. Not in a closed patch.
    if (tendRow) {
      tendRow.hidden = !open;
      const done = tendedToday(f);
      for (const b of tendButtons) {
        b.hidden = !owner && b.dataset.tend !== 'water';
        b.disabled = done;
      }
    }
  }

  function showPressed(f: GardenerFlower): void {
    const v = flowerVariant(f);
    setText(eyebrow, COPY.pressedEyebrow(f.patch.name));
    setText(title, COPY.pressedTitle(f.kind));
    setText(lede, COPY.pressedLede);
    bed?.classList.add('is-pressed');
    bed?.replaceChildren(drawFlower(doc, f.kind, 'bloom', v));
    actions?.replaceChildren(link('/#garden-plots', COPY.toPatch));
  }

  function showEmpty(text: { title: string; lede: string }, withPatchLink: boolean): void {
    setText(title, text.title);
    setText(lede, text.lede);
    actions?.replaceChildren(...(withPatchLink ? [link('/#garden-plots', COPY.toPatch)] : []));
  }

  /* ---------- below the hero ---------- */

  function renderHelpers(f: GardenerFlower): void {
    const list = helpers?.querySelector('[data-garden-helpers-list]');
    if (!helpers || !list) return;
    const others = f.tends.filter((t) => t.did !== f.did).slice(0, 6);
    helpers.hidden = others.length === 0;
    list.replaceChildren(
      ...others.map((t) => {
        const li = el(doc, 'li', { class: 'garden-helpers__item' });
        const badge = el(doc, 'span', { class: `garden-helpers__badge is-${t.action}`, 'aria-hidden': 'true' });
        badge.append(icon(doc, t.action));
        const words = el(doc, 'span', { class: 'garden-helpers__words' });
        words.append(el(doc, 'strong', {}, `@${t.handle}`), doc.createTextNode(` ${COPY.helped[t.action]}`));
        li.append(badge, words, el(doc, 'span', { class: 'garden-helpers__when' }, whenText(t.at, now())));
        return li;
      }),
    );
  }

  async function renderNear(f: GardenerFlower): Promise<void> {
    const plotsEl = near?.querySelector<HTMLElement>('[data-garden-near-plots]');
    const list = near?.querySelector<HTMLElement>('[data-garden-near-list]');
    if (!near || !plotsEl || !list) return;
    const view = await fetchGarden(fetchImpl, f.patch.rkey);
    if (!view?.patch || view.patch.uri !== f.patch.uri) return;
    const { cols, rows, open } = view.patch;
    const at = new Map(view.flowers.map((x) => [x.plot, x]));
    const w = Math.min(5, cols);
    const h = Math.min(3, rows);
    const col = f.plot % cols;
    const row = Math.floor(f.plot / cols);
    const c0 = Math.max(0, Math.min(col - Math.floor(w / 2), cols - w));
    const r0 = Math.max(0, Math.min(row - Math.floor(h / 2), rows - h));
    const around: Flower[] = [];
    const cells: HTMLElement[] = [];
    for (let r = r0; r < r0 + h; r++) {
      for (let c = c0; c < c0 + w; c++) {
        const plot = r * cols + c;
        const x = at.get(plot);
        const cell = el(doc, 'span', { class: 'garden-near__plot' });
        if (plot === f.plot) cell.classList.add('is-yours');
        if (x) {
          cell.append(drawFlower(doc, x.kind, stageFor(x.plantedAt, now(), open), flowerVariant(x)));
          if (x.did !== f.did) around.push(x);
          if (open && x.thirsty && x.did !== f.did) cell.classList.add('is-thirsty');
        }
        cells.push(cell);
      }
    }
    plotsEl.style.setProperty('--near-cols', String(w));
    plotsEl.replaceChildren(...cells);
    const thirsty = open ? around.filter((x) => x.thirsty) : [];
    list.replaceChildren(
      ...(thirsty.length
        ? thirsty.map((x) => {
            const li = el(doc, 'li', { class: 'garden-near__item' });
            const done = wateredToday(local, x.uri, now());
            const b = el(doc, 'button', { type: 'button', class: 'garden-near__water', 'data-near-water': x.uri }, done ? COPY.nearWatered : COPY.nearWater);
            b.disabled = done;
            b.addEventListener('click', async () => {
              if (await tendIt({ uri: x.uri, cid: x.cid }, 'water', b)) {
                b.textContent = COPY.nearWatered;
                b.disabled = true;
                burst(b, 'drops', win);
              }
            });
            li.append(el(doc, 'span', {}, COPY.nearThirsty(x.handle, x.kind)), b);
            return li;
          })
        : [el(doc, 'li', { class: 'garden-near__item' }, COPY.nearHappy)]),
    );
    near.hidden = false;
  }

  function renderHerbarium(pressed: GardenerFlower[]): void {
    const list = herbarium?.querySelector('[data-garden-herbarium-list]');
    const heading = herbarium?.querySelector<HTMLElement>('[data-garden-herbarium-title]');
    if (!herbarium || !list) return;
    herbarium.hidden = pressed.length === 0;
    setText(heading ?? null, owner ? COPY.herbarium(pressed.length) : COPY.herbariumTheirs(handle, pressed.length));
    list.replaceChildren(
      ...pressed.map((f) => {
        const v = flowerVariant(f);
        const li = el(doc, 'li', { class: 'garden-herbarium__sheet' });
        const art = el(doc, 'span', { class: 'garden-herbarium__flower', 'aria-hidden': 'true' });
        art.append(drawFlower(doc, f.kind, 'bloom', v));
        li.append(art, el(doc, 'strong', { class: 'garden-herbarium__name' }, describeBloom(f.kind, v)), el(doc, 'span', { class: 'garden-herbarium__meta' }, COPY.pressedCard(f.patch.name, Math.round(f.care * GROW_DAYS))));
        return li;
      }),
    );
  }

  /* ---------- tending and the reveal ---------- */

  for (const b of tendButtons) {
    b.addEventListener('click', async () => {
      const f = flower;
      const action = b.dataset.tend as TendAction;
      if (!f || !me) {
        if (!session) signIn?.open(COPY.tendLede);
        return;
      }
      if (!(await tendIt({ uri: f.uri, cid: f.cid }, action, b))) return;
      const at = new Date(now()).toISOString();
      f.tends = [{ did: me.did, handle: me.handle, action, at }, ...f.tends];
      f.care = Math.max(f.care, careFrom(f));
      f.lastTended = at;
      f.thirsty = false;
      showFlower(f);
      renderHelpers(f);
      say(owner ? COPY.tended[action] : COPY.visitorWatered);
      burst(bed ?? b, action === 'water' ? 'drops' : 'leaves', win);
      cheer(win);
    });
  }

  actions?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-garden-reveal]') && flower) {
      const f = flower;
      markSeen(local, f.uri);
      showFlower(f, { reveal: true });
      const v = flowerVariant(f);
      say(COPY.bloomed(f.kind, describeBloom(f.kind, v)));
      burst(bed ?? target, 'petals', win, v.colourway.slice(0, 3));
      cheer(win);
      title?.focus();
    } else if (target?.closest('[data-garden-signin]')) signIn?.open(COPY.tendLede);
  });

  /* ---------- load ---------- */

  if (auth?.eager) {
    const result = await auth.start();
    if (result.session) {
      session = result.session;
      me = await loadMe(fetchImpl, session.did);
      if (!me.handle.startsWith('did:')) rememberReader(me.handle);
    }
  }

  const did = asked ?? me?.did ?? null;
  if (!did) {
    root.dataset.state = 'signed-out';
    setText(title, COPY.signedOut.title);
    setText(lede, auth ? COPY.signedOut.lede : COPY.otherHost);
    if (auth) actions?.append(el(doc, 'button', { type: 'button', class: 'btn btn--primary', 'data-garden-signin': '' }, COPY.signedOut.button));
    actions?.append(link('/#garden-plots', COPY.toPatch, auth ? 'btn btn--outline' : 'btn btn--primary'));
    fillHow();
    return;
  }

  const view = await fetchGardener(did, fetchImpl);
  if (!view) {
    root.dataset.state = 'error';
    setText(lede, COPY.loadFailed);
    return;
  }
  owner = me?.did === did;
  handle = view.handle;
  setText(eyebrow, owner ? COPY.yourGarden : COPY.theirGarden(handle));
  if (!owner) doc.title = COPY.title(handle);
  root.dataset.state = 'ready';

  flower = view.flowers.find((f) => f.patch.open) ?? null;
  const pressed = view.flowers.filter((f) => !f.patch.open);
  renderHerbarium(pressed);
  if (flower) {
    showFlower(flower);
    renderHelpers(flower);
    if (owner) await renderNear(flower);
  } else if (owner && pressed[0]) {
    showPressed(pressed[0]);
  } else {
    showEmpty(owner ? COPY.empty : { title: COPY.empty.title, lede: COPY.emptyTheirs(handle) }, true);
    if (owner) fillHow();
  }
}

export function init(): Promise<void> {
  return initGardenPage();
}
