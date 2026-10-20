/**
 * The flower patch on the home page: a grid of plots, seen from above. The patches are
 * seasonal, each a record in atpotato's repo (scripts/open-patches.ts writes them):
 *
 *   to.atpota.garden.patch   { name: "autumn 2026", season, cols, rows, opensAt, closesAt, createdAt }
 *
 * Anyone can plant one flower in an open patch with their Bluesky account. It's a record in
 * their own repo, tied to their DID, pointing at the patch with a strong ref:
 *
 *   to.atpota.garden.sprout  { patch: { uri, cid }, kind: "sunflower" | ..., plot, createdAt }
 *
 * and anyone can tend a flower, theirs or a neighbour's (tend(), for the garden page):
 *
 *   to.atpota.garden.tend    { subject: { uri, cid } (the flower), action: "water" | ..., createdAt }
 *
 * /api/garden (server/garden.ts) gathers everyone's from the network, settles plots two
 * people asked for (the earlier flower keeps it) and counts each flower's care. Each
 * flower's look grows from its DID, record key and care (flowers.ts), and it goes from
 * sprout to bud to bloom over its first week. Planting again moves your flower (a new
 * record, so a new look); "dig mine up" deletes it. Both leave flowers in patches that have
 * closed alone: those are pressed, and stay.
 *
 * Picking: tap an empty plot (or "pick a plot" for one near the middle), then plant. The
 * plots are one tab stop; arrow keys move between them. On narrow screens a wide patch
 * wraps half as many across (narrowCols), so each row shows as two.
 *
 * Sign-in is the blog's (src/blog/auth.ts, src/blog/signin.ts): the auth server sends the
 * reader back to /blog, which forwards them here, and the flower they picked is planted in
 * the plot and patch they picked once they're back (a "plant" pending action,
 * src/blog/state.ts, plus KIND_KEY, PLOT_KEY and PATCH_KEY in sessionStorage). The OAuth
 * library only loads once someone plants or digs.
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { createRecord, deleteRecord, findOwnWhere, parseRecordUri, RepoError, type RecordRef } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { drawFlower, FLOWER_KINDS, flowerSeed, sampleVariant, stageFor, variantFor, type FlowerKind, type Stage, type Variant } from './flowers';
import { readReader, rememberReader } from './reader';

export { FLOWER_KINDS, type FlowerKind } from './flowers';

export const PATCH_NSID = 'to.atpota.garden.patch';
export const SPROUT_NSID = 'to.atpota.garden.sprout';
export const TEND_NSID = 'to.atpota.garden.tend';
/** atpotato's DID: the patches are records in its repo. */
export const GARDEN_SUBJECT = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const GARDEN_ENDPOINT = '/api/garden';
export const GARDENER_ENDPOINT = '/api/gardener';
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export const TEND_ACTIONS = ['water', 'sun', 'talk'] as const;
export type TendAction = (typeof TEND_ACTIONS)[number];
/** Match server/garden.ts: the biggest patch is 24 × 40. */
export const MAX_COLS = 24;
export const MAX_ROWS = 40;
export const MAX_PLOTS = MAX_COLS * MAX_ROWS;
/** sessionStorage: the flower, plot and patch picked before leaving to sign in. */
export const KIND_KEY = 'garden:kind';
export const PLOT_KEY = 'garden:plot';
export const PATCH_KEY = 'garden:patch';

export interface Patch {
  rkey: string;
  uri: string;
  cid: string;
  name: string;
  season: Season;
  cols: number;
  rows: number;
  opensAt: string;
  closesAt: string;
  open: boolean;
}

export interface PatchSummary {
  rkey: string;
  name: string;
  season: Season;
  open: boolean;
  planted: number;
  plots: number;
  opensAt: string;
  closesAt: string;
}

export interface Flower {
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  handle: string;
  kind: FlowerKind;
  plot: number;
  plantedAt: string;
  /** 0 to 1: how well it was tended while it grew. */
  care: number;
  /** Neighbours who helped it grow (up to 3). */
  helpers: number;
  lastTended: string | null;
  thirsty: boolean;
}

export interface GardenView {
  /** Null until the first patch exists. */
  patch: Patch | null;
  patches: PatchSummary[];
  flowers: Flower[];
}

export interface Tend {
  did: string;
  handle: string;
  action: TendAction;
  at: string;
}

export interface GardenerFlower extends Flower {
  patch: { rkey: string; uri: string; name: string; season: Season; open: boolean; cols: number; rows: number };
  tends: Tend[];
}

export interface GardenerView {
  did: string;
  handle: string;
  flowers: GardenerFlower[];
}

export const COPY = {
  pick: 'pick a plot',
  plantHere: (kind: FlowerKind) => `plant a ${kind} here`,
  planting: 'planting…',
  choose: (kind: FlowerKind) => `tap an empty plot to plant your ${kind} there, or plant it here.`,
  planted: (kind: FlowerKind) => `planted! your ${kind} is a sprout for now, and it blooms in a week. tend it to help it grow (◕‿◕)`,
  moved: (kind: FlowerKind) => `moved! a new ${kind} is growing in your new plot (◕‿◕)`,
  dug: 'dug up. the patch will miss you.',
  count: (n: number, plots: number) => (n === 0 ? `${plots} empty plots. be the first!` : `${n} of ${plots} plots planted`),
  loadFailed: "the patch didn't load just now. it's still growing, promise.",
  noPatch: 'the first patch opens soon.',
  closed: (name: string) => `the ${name} patch has closed. its flowers stay, pressed.`,
  notYet: (name: string) => `the ${name} patch opens soon.`,
  full: 'this patch is full. a new one opens soon.',
  lede: "sign in with your bluesky account to plant a flower. it's saved in your own account, so it's yours.",
  consent: 'one more step: atpota.to needs your ok to plant and tend flowers. sign in again to allow it.',
  expired: 'your sign-in expired. sign in again to plant.',
  failed: "that didn't work. try again in a moment?",
  otherHost: 'planting works on atpota.to.',
  you: 'you',
  plantTag: 'plant here',
  stage: { sprout: 'just planted', bud: 'budding', bloom: 'in bloom' } satisfies Record<Stage, string>,
  thirsty: 'thirsty',
  emptyPlot: (n: number, selected: boolean) => `empty plot ${n}${selected ? ', picked' : ''}`,
  flowerPlot: (who: string, kind: FlowerKind, stage: Stage, thirsty = false) => `${who} ${kind}, ${COPY.stage[stage]}${thirsty ? `, ${COPY.thirsty}` : ''}`,
} as const;

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

export function isTendAction(value: unknown): value is TendAction {
  return typeof value === 'string' && (TEND_ACTIONS as readonly string[]).includes(value);
}

/** A whole plot number in a patch of `plots` plots (any patch, by default). */
export function isPlot(value: unknown, plots: number = MAX_PLOTS): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < plots;
}

export function patchUri(rkey: string): string {
  return `at://${GARDEN_SUBJECT}/${PATCH_NSID}/${rkey}`;
}

export function sproutRecord(patch: RecordRef, kind: FlowerKind, plot: number, now: Date): Record<string, unknown> {
  return { $type: SPROUT_NSID, patch: { uri: patch.uri, cid: patch.cid }, kind, plot, createdAt: now.toISOString() };
}

export function tendRecord(flowerUri: string, flowerCid: string, action: TendAction, now: Date): Record<string, unknown> {
  return { $type: TEND_NSID, subject: { uri: flowerUri, cid: flowerCid }, action, createdAt: now.toISOString() };
}

/** Tends a flower (anyone's): a to.atpota.garden.tend record in the reader's repo. */
export function tend(session: Session, flower: RecordRef, action: TendAction, now: Date = new Date()): Promise<RecordRef> {
  return createRecord(session, TEND_NSID, tendRecord(flower.uri, flower.cid, action, now));
}

/** A flower's look: from its DID and record key, fuller with care. */
export function flowerVariant(flower: Pick<Flower, 'did' | 'rkey' | 'kind' | 'care'>): Variant {
  return variantFor(flower.kind, flowerSeed(flower.did, flower.rkey), flower.care);
}

/** Plots across on a narrow screen: half of a wide, even patch (so each row shows as two). */
export function narrowCols(cols: number): number {
  return cols >= 10 && cols % 2 === 0 ? cols / 2 : cols;
}

/**
 * A free plot near the middle of a patch of `plots` plots (for "pick a plot"), as it shows
 * `cols` across, or null when none is free.
 */
export function middlePlot(taken: ReadonlySet<number>, plots: number, cols: number, random: () => number = Math.random): number | null {
  const cx = (cols - 1) / 2;
  const cy = (Math.ceil(plots / cols) - 1) / 2;
  const free: Array<[number, number]> = [];
  for (let i = 0; i < plots; i++) {
    if (taken.has(i)) continue;
    const d = Math.hypot((i % cols) - cx, Math.floor(i / cols) - cy) + random() * 2.5;
    free.push([d, i]);
  }
  free.sort((a, b) => a[0] - b[0]);
  return free[0]?.[1] ?? null;
}

/** `plot` if nobody else has it, else the next free one along; null when the patch is full. */
export function freePlotFrom(plot: number, taken: ReadonlySet<number>, plots: number): number | null {
  let p = plot < plots ? plot : 0;
  for (let n = 0; n < plots; n++, p = (p + 1) % plots) if (!taken.has(p)) return p;
  return null;
}

const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

function isSeason(value: unknown): value is Season {
  return typeof value === 'string' && (SEASONS as readonly string[]).includes(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isSize(cols: unknown, rows: unknown): boolean {
  return typeof cols === 'number' && typeof rows === 'number' && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= MAX_COLS && rows >= 1 && rows <= MAX_ROWS;
}

function isPatch(v: unknown): v is Patch {
  const p = v as Patch;
  return (
    typeof p?.rkey === 'string' &&
    RKEY_RE.test(p.rkey) &&
    p.uri === patchUri(p.rkey) &&
    typeof p.cid === 'string' &&
    typeof p.name === 'string' &&
    isSeason(p.season) &&
    isSize(p.cols, p.rows) &&
    isDate(p.opensAt) &&
    isDate(p.closesAt) &&
    typeof p.open === 'boolean'
  );
}

function isSummary(v: unknown): v is PatchSummary {
  const p = v as PatchSummary;
  return (
    typeof p?.rkey === 'string' &&
    RKEY_RE.test(p.rkey) &&
    typeof p.name === 'string' &&
    isSeason(p.season) &&
    typeof p.open === 'boolean' &&
    isPlot(p.planted, MAX_PLOTS + 1) &&
    isPlot(p.plots, MAX_PLOTS + 1) &&
    isDate(p.opensAt) &&
    isDate(p.closesAt)
  );
}

function isFlower(v: unknown): v is Flower {
  const f = v as Flower;
  return (
    typeof f?.did === 'string' &&
    f.did.startsWith('did:') &&
    typeof f.rkey === 'string' &&
    typeof f.uri === 'string' &&
    parseRecordUri(f.uri)?.did === f.did &&
    typeof f.cid === 'string' &&
    typeof f.handle === 'string' &&
    isFlowerKind(f.kind) &&
    isPlot(f.plot) &&
    isDate(f.plantedAt) &&
    typeof f.care === 'number' &&
    f.care >= 0 &&
    f.care <= 1 &&
    typeof f.helpers === 'number' &&
    (f.lastTended === null || isDate(f.lastTended)) &&
    typeof f.thirsty === 'boolean'
  );
}

/** A patch from /api/garden (the default one, or `rkey`), checked; null when it didn't load. */
export async function fetchGarden(fetchImpl: typeof fetch = fetch, rkey?: string): Promise<GardenView | null> {
  try {
    const url = rkey ? `${GARDEN_ENDPOINT}?${new URLSearchParams({ patch: rkey })}` : GARDEN_ENDPOINT;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { patch?: unknown; patches?: unknown; flowers?: unknown };
    if (!Array.isArray(body?.flowers) || !Array.isArray(body.patches)) return null;
    const patch = isPatch(body.patch) ? body.patch : null;
    const plots = patch ? patch.cols * patch.rows : 0;
    return {
      patch,
      patches: body.patches.filter(isSummary),
      flowers: patch ? body.flowers.filter((f): f is Flower => isFlower(f) && f.plot < plots) : [],
    };
  } catch {
    return null;
  }
}

/** One person's flowers from /api/gardener (for the garden page), checked; null when it didn't load. */
export async function fetchGardener(did: string, fetchImpl: typeof fetch = fetch): Promise<GardenerView | null> {
  try {
    const res = await fetchImpl(`${GARDENER_ENDPOINT}?${new URLSearchParams({ did })}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { did?: unknown; handle?: unknown; flowers?: unknown };
    if (body?.did !== did || typeof body.handle !== 'string' || !Array.isArray(body.flowers)) return null;
    const flowers = body.flowers.filter((f): f is GardenerFlower => {
      const g = f as GardenerFlower;
      return (
        isFlower(g) &&
        typeof g.patch?.rkey === 'string' &&
        g.patch.uri === patchUri(g.patch.rkey) &&
        typeof g.patch.name === 'string' &&
        isSeason(g.patch.season) &&
        typeof g.patch.open === 'boolean' &&
        isSize(g.patch.cols, g.patch.rows) &&
        Array.isArray(g.tends)
      );
    });
    for (const f of flowers) {
      f.tends = f.tends.filter((t) => typeof t?.did === 'string' && typeof t.handle === 'string' && isTendAction(t.action) && isDate(t.at));
    }
    return { did, handle: body.handle, flowers };
  } catch {
    return null;
  }
}

export interface GardenOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to createAuth(win); null means planting isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
  random?: () => number;
}

export async function initGarden(opts: GardenOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const tile = doc.querySelector<HTMLElement>('[data-garden]');
  if (!tile || tile.dataset.gardenBound === 'true') return;
  tile.dataset.gardenBound = 'true';
  const plots = tile.querySelector<HTMLElement>('[data-garden-plots]');
  const count = tile.querySelector<HTMLElement>('[data-garden-count]');
  const status = tile.querySelector<HTMLElement>('[data-garden-status]');
  const plantButton = tile.querySelector<HTMLButtonElement>('[data-garden-plant]');
  const digButton = tile.querySelector<HTMLButtonElement>('[data-garden-dig]');
  const kindButtons = [...tile.querySelectorAll<HTMLButtonElement>('[data-garden-kinds] [data-kind]')];
  const auth = opts.auth === undefined ? createAuth(win) : opts.auth;

  let patch: Patch | null = null;
  let patches: PatchSummary[] = [];
  let flowers: Flower[] = [];
  let session: Session | null = null;
  let me: Me | null = null;
  let fresh: string | null = null;
  let selected: number | null = null;
  let focusAt = 0;
  const storedKind = store.get(KIND_KEY);
  let kind: FlowerKind = isFlowerKind(storedKind) ? storedKind : 'sunflower';

  const say = (text: string) => {
    if (status) status.textContent = text;
  };
  const cols = () => patch?.cols ?? 0;
  const total = () => (patch ? patch.cols * patch.rows : 0);
  const taken = () => new Set(flowers.map((f) => f.plot));
  /** Plots across as shown: the patch's width, or narrowCols on narrow screens (home.css). */
  const shownCols = () => {
    const n = plots ? win.getComputedStyle(plots).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
    return n === narrowCols(cols()) ? n : cols();
  };

  /** The reader's flower: by session, or by the handle the blog remembered. */
  const isMine = (f: Flower) => (me ? f.did === me.did : f.handle === readReader());
  /** Why planting is off here, or null when it's on. */
  const shut = (): string | null => {
    if (!patch) return COPY.noPatch;
    if (!patch.open) return now() < Date.parse(patch.opensAt) ? COPY.notYet(patch.name) : COPY.closed(patch.name);
    const others = new Set(flowers.filter((f) => !isMine(f)).map((f) => f.plot));
    return others.size >= total() ? COPY.full : null;
  };

  function plotButton(i: number, at: Map<number, Flower>): HTMLButtonElement {
    const f = at.get(i);
    const b = el(doc, 'button', { type: 'button', class: 'home-plot', 'data-plot': String(i) });
    b.tabIndex = i === focusAt ? 0 : -1;
    if (f) {
      const open = patch?.open ?? false;
      const stage = stageFor(f.plantedAt, now(), open);
      const mine = isMine(f);
      b.classList.add('home-plot--planted');
      if (mine) b.classList.add('is-yours');
      if (f.did === fresh) b.classList.add('is-new');
      if (f.thirsty) b.classList.add('is-thirsty');
      b.setAttribute('aria-label', COPY.flowerPlot(mine ? 'your' : `@${f.handle}'s`, f.kind, stage, f.thirsty));
      b.append(drawFlower(doc, f.kind, stage, flowerVariant(f)));
      b.append(el(doc, 'span', { class: 'home-plot__tag', 'aria-hidden': 'true' }, mine ? COPY.you : `@${f.handle}`));
    } else {
      const picked = i === selected;
      b.classList.add('home-plot--empty');
      b.setAttribute('aria-pressed', String(picked));
      b.setAttribute('aria-label', COPY.emptyPlot(i + 1, picked));
      if (picked) {
        b.classList.add('is-picked');
        const ghost = drawFlower(doc, kind, 'bloom', sampleVariant(kind));
        ghost.classList.add('home-flower--ghost');
        b.append(ghost, el(doc, 'span', { class: 'home-plot__tag', 'aria-hidden': 'true' }, COPY.plantTag));
      }
    }
    return b;
  }

  function render(): void {
    const n = total();
    focusAt = Math.max(0, Math.min(focusAt, n - 1));
    if (plots) {
      const hadFocus = plots.contains(doc.activeElement);
      const at = new Map(flowers.map((f) => [f.plot, f]));
      plots.style.setProperty('--plot-cols', String(cols() || 1));
      plots.style.setProperty('--plot-cols-narrow', String(narrowCols(cols()) || 1));
      plots.replaceChildren(...Array.from({ length: n }, (_, i) => plotButton(i, at)));
      if (hadFocus) plots.querySelector<HTMLButtonElement>(`[data-plot="${focusAt}"]`)?.focus();
    }
    if (count) count.textContent = patch ? COPY.count(flowers.length, n) : '';
    if (digButton) digButton.hidden = !(patch?.open && flowers.some(isMine));
    if (plantButton && !isBusy(plantButton)) {
      plantButton.disabled = shut() !== null;
      plantButton.textContent = selected === null ? COPY.pick : COPY.plantHere(kind);
    }
  }

  function select(plot: number | null): void {
    selected = plot;
    if (plot !== null) focusAt = plot;
    render();
    if (plot !== null) say(COPY.choose(kind));
  }

  function pickKind(next: FlowerKind): void {
    kind = next;
    for (const b of kindButtons) {
      b.setAttribute('aria-checked', String(b.dataset.kind === next));
      b.tabIndex = b.dataset.kind === next ? 0 : -1;
    }
    render();
  }

  // The picker shows each kind's plain look.
  for (const b of kindButtons) {
    if (!isFlowerKind(b.dataset.kind)) continue;
    const k = b.dataset.kind;
    b.prepend(drawFlower(doc, k, 'bloom', sampleVariant(k)));
    b.addEventListener('click', () => pickKind(k));
  }
  // Arrow keys move between the flowers, as in any radio group.
  tile.querySelector('[data-garden-kinds]')?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = FLOWER_KINDS.indexOf(kind);
    const next = FLOWER_KINDS[(i + step + FLOWER_KINDS.length) % FLOWER_KINDS.length]!;
    pickKind(next);
    kindButtons.find((b) => b.dataset.kind === next)?.focus();
  });

  plots?.addEventListener('click', (event) => {
    const cell = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-plot]') : null;
    if (!cell) return;
    const i = Number(cell.dataset.plot);
    focusAt = i;
    if (cell.classList.contains('home-plot--empty') && !shut()) select(selected === i ? null : i);
  });
  // The plots are one tab stop; arrows, Home and End move between them.
  plots?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const n = total();
    const across = shownCols();
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: across, ArrowUp: -across };
    const from = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-plot]') : null;
    if (from) focusAt = Number(from.dataset.plot);
    let next: number | null = null;
    if (e.key in moves) next = focusAt + moves[e.key]!;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null || next < 0 || next >= n) return;
    e.preventDefault();
    for (const b of plots.querySelectorAll<HTMLButtonElement>('[data-plot][tabindex="0"]')) b.tabIndex = -1;
    const to = plots.querySelector<HTMLButtonElement>(`[data-plot="${next}"]`);
    if (to) {
      to.tabIndex = 0;
      to.focus();
    }
    focusAt = next;
  });

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
          savePending(store, { kind: 'plant', returnTo: '/', at: now() });
          store.set(KIND_KEY, kind);
          if (selected !== null) store.set(PLOT_KEY, String(selected));
          if (patch) store.set(PATCH_KEY, patch.rkey);
        },
      })
    : null;

  async function ensureSession(): Promise<Session | null> {
    if (session || !auth?.eager) return session;
    const result = await auth.start();
    if (result.session) {
      session = result.session;
      me = await loadMe(fetchImpl, session.did);
      if (!me.handle.startsWith('did:')) rememberReader(me.handle);
    }
    return session;
  }

  /** What to do when a write fails: sign in again for auth or permission trouble. */
  function failed(error: unknown): void {
    const code = error instanceof RepoError ? error.status : 0;
    const authTrouble = code === 401 || ['TokenRefreshError', 'TokenRevokedError', 'TokenInvalidError'].includes((error as Error)?.name ?? '');
    if (authTrouble || code === 403) {
      session = null;
      me = null;
      say(authTrouble ? COPY.expired : COPY.consent);
      signIn?.open(authTrouble ? COPY.lede : COPY.consent);
      return;
    }
    say(COPY.failed);
  }

  /** The reader's flowers in open patches (the ones planting again or digging replaces). */
  function openFlowers(s: Session): Promise<string[]> {
    const open = new Set(patches.filter((p) => p.open).map((p) => patchUri(p.rkey)));
    if (patch?.open) open.add(patch.uri);
    return findOwnWhere(s, SPROUT_NSID, (v) => open.has((v.patch as { uri?: unknown } | undefined)?.uri as string), fetchImpl);
  }

  async function plant(): Promise<void> {
    if (!plantButton || isBusy(plantButton)) return;
    const why = shut();
    if (why) {
      say(why);
      return;
    }
    if (selected === null) {
      select(middlePlot(taken(), total(), shownCols(), random));
      return;
    }
    if (!auth || !signIn) {
      say(COPY.otherHost);
      return;
    }
    setBusy(plantButton, true);
    plantButton.textContent = COPY.planting;
    try {
      const s = await ensureSession();
      if (!s || !me) {
        signIn.open(COPY.lede);
        return;
      }
      const here = patch!;
      const did = me.did;
      // Someone may have taken the plot while this page was open: the next free one, then.
      const others = new Set(flowers.filter((f) => f.did !== did).map((f) => f.plot));
      const plot = freePlotFrom(selected, others, total());
      if (plot === null) {
        say(COPY.full);
        return;
      }
      const existing = await openFlowers(s);
      const planted = new Date(now());
      const ref = await createRecord(s, SPROUT_NSID, sproutRecord(here, kind, plot, planted));
      // The new flower first, then the old ones go: a failed delete leaves two, and the
      // patch shows the newest.
      for (const uri of existing) if (uri !== ref.uri) await deleteRecord(s, uri);
      store.remove(KIND_KEY);
      store.remove(PLOT_KEY);
      store.remove(PATCH_KEY);
      const mine: Flower = {
        did,
        rkey: parseRecordUri(ref.uri)?.rkey ?? String(planted.getTime()),
        uri: ref.uri,
        cid: ref.cid,
        handle: me.handle.startsWith('did:') ? COPY.you : me.handle,
        kind,
        plot,
        plantedAt: planted.toISOString(),
        care: 0,
        helpers: 0,
        lastTended: null,
        thirsty: false,
      };
      flowers = [...flowers.filter((f) => f.did !== did), mine];
      fresh = did;
      selected = null;
      focusAt = plot;
      render();
      say(existing.length ? COPY.moved(kind) : COPY.planted(kind));
      const cell = plots?.querySelector(`[data-plot="${plot}"]`);
      burst(cell ?? plantButton, 'leaves', win);
      cheer(win);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(plantButton, false);
      render();
    }
  }

  async function dig(): Promise<void> {
    if (!digButton || isBusy(digButton) || !auth || !signIn) return;
    setBusy(digButton, true);
    try {
      const s = await ensureSession();
      if (!s || !me) {
        signIn.open(COPY.lede);
        return;
      }
      for (const uri of await openFlowers(s)) await deleteRecord(s, uri);
      flowers = flowers.filter((f) => f.did !== me!.did);
      render();
      say(COPY.dug);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(digButton, false);
    }
  }

  plantButton?.addEventListener('click', () => void plant());
  digButton?.addEventListener('click', () => void dig());

  pickKind(kind);

  // Back from signing in with a flower to plant: that patch, else the one shown by default.
  const pending = readPending(store, now());
  const backToPlant = pending?.kind === 'plant' && pending.returnTo === '/';
  const storedPatch = backToPlant ? store.get(PATCH_KEY) : null;
  const loaded = fetchGarden(fetchImpl, storedPatch && RKEY_RE.test(storedPatch) ? storedPatch : undefined).then((garden) => {
    if (garden) {
      patch = garden.patch;
      patches = garden.patches;
      // A flower planted while this was loading stays.
      const planted = flowers.filter((f) => f.did === fresh);
      flowers = [...garden.flowers.filter((f) => f.did !== fresh), ...planted];
      if (!patch?.open) say(shut()!);
    } else say(COPY.loadFailed);
    tile.dataset.state = garden ? 'ready' : 'error';
    render();
  });

  if (backToPlant) {
    clearPending(store);
    await loaded;
    const stored = store.get(PLOT_KEY);
    const want = stored === null ? null : Number(stored);
    selected = isPlot(want, total()) ? want : middlePlot(taken(), total(), shownCols(), random);
    tile.scrollIntoView?.({ block: 'center' });
    render();
    await plant();
  } else {
    await loaded;
  }
}
