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
 * wraps half as many across (narrowCols), so each row shows as two. Tapping a flower opens
 * its card: whose it is, how it's growing, and a button to water it (a neighbour's) or a
 * link to the garden page (yours). Tabs above the grid switch between the recent seasons'
 * patches; a closed one shows its flowers pressed.
 *
 * Sign-in is the blog's (src/blog/auth.ts, src/blog/signin.ts): the auth server sends the
 * reader back to /blog, which forwards them here, and the flower they picked is planted in
 * the plot and patch they picked once they're back (a "plant" pending action,
 * src/blog/state.ts, plus KIND_KEY, PLOT_KEY and PATCH_KEY in sessionStorage). Watering
 * works the same way, with a "tend" pending action and TEND_KEY. The OAuth library only
 * loads once someone plants, digs or waters.
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { createRecord, deleteRecord, findOwnWhere, parseRecordUri, RepoError } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { DAY_MS, drawFlower, FLOWER_KINDS, GROW_DAYS, sampleVariant, stageFor, type FlowerKind, type Stage, type Variant } from './flowers';
import {
  fetchGarden,
  flowerVariant,
  GARDEN_SUBJECT,
  isFlowerKind,
  isPlot,
  patchUri,
  SPROUT_NSID,
  sproutRecord,
  tend,
  type Flower,
  type GardenView,
  type Owner,
  type Patch,
  type PatchSummary,
} from './garden-api';
import { readReader, rememberReader } from './reader';

export { FLOWER_KINDS, type FlowerKind } from './flowers';
// The data (records, answers, writes) lives in garden-api.ts; everything there is here too.
export * from './garden-api';

/** sessionStorage: the flower, plot and patch picked before leaving to sign in. */
export const KIND_KEY = 'garden:kind';
export const PLOT_KEY = 'garden:plot';
export const PATCH_KEY = 'garden:patch';
/** sessionStorage: the flower being watered before leaving to sign in ({ uri, cid, patch }). */
export const TEND_KEY = 'garden:tend';
/** localStorage: the flowers this reader watered today ({ date, uris }), so the button rests. */
export const WATERED_KEY = 'garden:watered';

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
  lede: "sign in with your bluesky or atmosphere account to plant a flower. it's saved in your own account, so it's yours.",
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
  tabs: { open: 'growing now', closed: 'pressed', soon: (when: string) => `opens ${when}` },
  yours: (kind: FlowerKind) => `your ${kind}`,
  theirs: (handle: string, kind: FlowerKind) => `@${handle}'s ${kind}`,
  growing: (stage: Stage, day: number) => (stage === 'sprout' ? `just planted · day ${day}` : `budding · day ${day} of ${GROW_DAYS}`),
  inBloom: (bloom: string, open: boolean) => `${bloom} · ${open ? 'in bloom' : 'pressed'}`,
  thirstyFor: (days: number) => `looks thirsty: not watered for ${days} ${days === 1 ? 'day' : 'days'}`,
  water: 'water it',
  wateredToday: 'watered today',
  watered: (whose: string) => `watered! ${whose} perked right up (◕‿◕)`,
  lookAfter: 'look after it',
  theirGarden: 'their garden',
  tendLede: 'sign in with your bluesky or atmosphere account to water flowers. each watering is a small record in your own repo.',
  close: 'close',
} as const;

/** "a two-tone double daisy with a ladybug", or just "a daisy". */
export function describeBloom(kind: FlowerKind, v: Pick<Variant, 'twoTone' | 'double' | 'ladybug'>): string {
  const looks = [v.twoTone ? 'two-tone' : '', v.double ? 'double' : ''].filter(Boolean).join(' ');
  return `a ${looks ? `${looks} ` : ''}${kind}${v.ladybug ? ' with a ladybug' : ''}`;
}

/** Which day of its life a flower is on, from 1. */
export function dayOf(plantedAt: string, now: number): number {
  const age = now - Date.parse(plantedAt);
  return Number.isFinite(age) ? Math.max(1, Math.floor(age / DAY_MS) + 1) : 1;
}

/** Whole days since a flower was last tended (or bloomed, if nobody has tended it since). */
export function thirstyDays(f: Pick<Flower, 'plantedAt' | 'lastTended'>, now: number): number {
  const bloomed = Date.parse(f.plantedAt) + GROW_DAYS * DAY_MS;
  const last = Math.max(f.lastTended ? Date.parse(f.lastTended) : 0, bloomed);
  return Math.max(1, Math.floor((now - last) / DAY_MS));
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** True when this reader already watered `uri` today (UTC). */
export function wateredToday(local: KeyValueStore, uri: string, now: number): boolean {
  try {
    const v = JSON.parse(local.get(WATERED_KEY) ?? 'null') as { date?: unknown; uris?: unknown } | null;
    return v?.date === today(now) && Array.isArray(v.uris) && v.uris.includes(uri);
  } catch {
    return false;
  }
}

export function markWatered(local: KeyValueStore, uri: string, now: number): void {
  let uris: string[] = [];
  try {
    const v = JSON.parse(local.get(WATERED_KEY) ?? 'null') as { date?: unknown; uris?: unknown } | null;
    if (v?.date === today(now) && Array.isArray(v.uris)) uris = v.uris.filter((u): u is string => typeof u === 'string');
  } catch {
    // start the day afresh
  }
  if (!uris.includes(uri)) uris.push(uri);
  local.set(WATERED_KEY, JSON.stringify({ date: today(now), uris: uris.slice(-200) }));
}

/** "dec 1" */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toLowerCase();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function closeIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  svg.append(path);
  return svg;
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
const HANDLE_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Someone's garden page (/garden/dame.is), or their flowers (…/flowers). */
export function gardenPath(actor: string, level: 'garden' | 'flowers' = 'garden'): string {
  return `/garden/${actor}${level === 'flowers' ? '/flowers' : ''}`;
}

/** The address segment for someone: their handle, or their DID when the handle is broken. */
export function actorOf(p: { did: string; handle: string }): string {
  return HANDLE_RE.test(p.handle) && p.handle !== 'handle.invalid' ? p.handle : p.did;
}

export interface GardenOptions {
  doc?: Document;
  win?: Window;
  /** The patch's markup ([data-garden]); defaults to the first on the page (the home tile). */
  root?: HTMLElement;
  /** Whose garden: a DID or handle. Defaults to atpotato's community garden. */
  owner?: string;
  /** Where signing in comes back to (a path safeReturnTo accepts). Defaults to the home page. */
  returnTo?: string;
  /** Defaults to createAuth(win); null means planting isn't offered on this host. */
  auth?: Auth | null;
  /**
   * Opens a sign-in dialog the page already has, running `beforeLeave` if the reader goes
   * to sign in. Without it the garden mounts its own (the home page).
   */
  openSignIn?: (lede: string, beforeLeave: () => void) => void;
  /** Called whenever what the garden shows changes (loaded, a tab, planting, digging). */
  onView?: (view: GardenView) => void;
  /** The garden's version its keeper just saved (its record's CID), to load that one. */
  version?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionStore?: KeyValueStore;
  localStore?: KeyValueStore;
  random?: () => number;
}

export interface GardenController {
  /** Loads the garden again: after its keeper changed it, `version` is the CID they saved. */
  reload(version?: string): Promise<void>;
}

export async function initGarden(opts: GardenOptions = {}): Promise<GardenController | null> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const tile = opts.root ?? doc.querySelector<HTMLElement>('[data-garden]');
  if (!tile || tile.dataset.gardenBound === 'true') return null;
  tile.dataset.gardenBound = 'true';
  const box: HTMLElement = tile;
  const returnTo = opts.returnTo ?? '/';
  const nameEl = tile.querySelector<HTMLElement>('[data-garden-name]');
  const noteEl = tile.querySelector<HTMLElement>('[data-garden-note]');
  const plots = tile.querySelector<HTMLElement>('[data-garden-plots]');
  const count = tile.querySelector<HTMLElement>('[data-garden-count]');
  const status = tile.querySelector<HTMLElement>('[data-garden-status]');
  const plantButton = tile.querySelector<HTMLButtonElement>('[data-garden-plant]');
  const digButton = tile.querySelector<HTMLButtonElement>('[data-garden-dig]');
  const mineLink = tile.querySelector<HTMLElement>('[data-garden-mine]');
  const kindsGroup = tile.querySelector<HTMLElement>('[data-garden-kinds]');
  const kindButtons = [...tile.querySelectorAll<HTMLButtonElement>('[data-garden-kinds] [data-kind]')];
  const tabs = tile.querySelector<HTMLElement>('[data-garden-tabs]');
  const card = tile.querySelector<HTMLElement>('[data-garden-card]');
  const auth = opts.auth === undefined ? createAuth(win) : opts.auth;

  let owner: Owner | null = null;
  let patch: Patch | null = null;
  let patches: PatchSummary[] = [];
  let flowers: Flower[] = [];
  let session: Session | null = null;
  let me: Me | null = null;
  let fresh: string | null = null;
  let selected: number | null = null;
  let focusAt = 0;
  /** What signing in is for: the flower being planted, or the one being watered. */
  let intent: 'plant' | 'tend' = 'plant';
  /** The flower whose card is open. */
  let cardFor: string | null = null;
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
    if (!patch.open) return now() < Date.parse(patch.opensAt ?? patch.createdAt) ? COPY.notYet(patch.name) : COPY.closed(patch.name);
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
    plots?.toggleAttribute('data-pressed', Boolean(patch && !patch.open && patch.closesAt !== null && now() >= Date.parse(patch.closesAt)));
    renderTabs();
    if (nameEl && patch) nameEl.textContent = patch.name;
    if (noteEl) noteEl.textContent = patch?.note ?? '';
    if (count) count.textContent = patch ? COPY.count(flowers.length, n) : '';
    if (digButton) digButton.hidden = !(patch?.open && flowers.some(isMine));
    const mine = patch?.open ? flowers.find(isMine) : undefined;
    if (mineLink) {
      mineLink.hidden = !mine;
      if (mine) mineLink.setAttribute('href', gardenPath(actorOf(mine), 'flowers'));
    }
    // A closed or upcoming patch can't be planted in: no picker, no button.
    const shutAway = Boolean(patch && !patch.open);
    if (kindsGroup) kindsGroup.hidden = shutAway;
    if (plantButton) plantButton.hidden = shutAway;
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
  kindsGroup?.addEventListener('keydown', (event) => {
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
    const f = flowers.find((x) => x.plot === i);
    if (f) openCard(f, cell);
    else {
      closeCard(false);
      if (!shut()) select(selected === i ? null : i);
    }
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

  /** Before leaving to sign in: what to finish once the reader is back. */
  function beforeLeave(): void {
    if (intent === 'tend') {
      savePending(store, { kind: 'tend', returnTo, at: now() });
      return;
    }
    savePending(store, { kind: 'plant', returnTo, at: now() });
    store.set(KIND_KEY, kind);
    if (selected !== null) store.set(PLOT_KEY, String(selected));
    if (patch) store.set(PATCH_KEY, patch.rkey);
  }
  // The page's own sign-in dialog when it has one (garden pages), else this garden's.
  const signIn: Pick<SignIn, 'open'> | null = !auth
    ? null
    : opts.openSignIn
      ? { open: (lede: string) => opts.openSignIn!(lede, beforeLeave) }
      : mountSignIn({ doc, win, dialog: doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin]'), auth, fetchImpl, local, now, beforeLeave });
  const ownerDid = () => owner?.did ?? (opts.owner?.startsWith('did:') ? opts.owner : GARDEN_SUBJECT);
  const emit = () => opts.onView?.({ owner, patch, patches, flowers });

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
    const open = new Set(patches.filter((p) => p.open).map((p) => patchUri(p.rkey, ownerDid())));
    if (patch?.open) open.add(patch.uri);
    return findOwnWhere(s, SPROUT_NSID, (v) => open.has((v.patch as { uri?: unknown } | undefined)?.uri as string), fetchImpl);
  }

  async function plant(): Promise<void> {
    if (!plantButton || isBusy(plantButton)) return;
    intent = 'plant';
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
      emit();
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
      emit();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(digButton, false);
    }
  }

  /* ---------- seasons ---------- */

  /** The last two closed patches, the open ones, the next to open, and whichever is shown. */
  function tabPatches(): PatchSummary[] {
    const t = now();
    const closed = patches.filter((p) => !p.open && p.closesAt !== null && Date.parse(p.closesAt) <= t).slice(-2);
    const soon = patches.filter((p) => !p.open && p.opensAt !== null && Date.parse(p.opensAt) > t).slice(0, 1);
    const list = [...closed, ...patches.filter((p) => p.open), ...soon];
    const shown = patches.find((p) => p.rkey === patch?.rkey);
    if (shown && !list.includes(shown)) list.push(shown);
    const opens = (p: PatchSummary) => (p.opensAt ? Date.parse(p.opensAt) : 0);
    return list.sort((a, b) => opens(a) - opens(b));
  }

  function renderTabs(): void {
    if (!tabs) return;
    const t = now();
    const list = tabPatches();
    tabs.hidden = list.length < 2;
    const hadFocus = tabs.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.patch : undefined;
    tabs.replaceChildren(
      ...list.map((p) => {
        const opensAt = p.opensAt;
        const upcoming = !p.open && opensAt !== null && Date.parse(opensAt) > t;
        const on = p.rkey === patch?.rkey;
        const b = el(doc, 'button', { type: 'button', role: 'tab', class: 'home-patch__tab', 'data-patch': p.rkey, 'aria-selected': String(on) });
        if (plots?.id) b.setAttribute('aria-controls', plots.id);
        b.tabIndex = on ? 0 : -1;
        b.disabled = upcoming;
        b.append(
          el(doc, 'span', { class: 'home-patch__tab-name' }, p.name),
          el(doc, 'span', { class: 'home-patch__tab-note' }, p.open ? COPY.tabs.open : upcoming && opensAt ? COPY.tabs.soon(shortDate(opensAt)) : COPY.tabs.closed),
        );
        return b;
      }),
    );
    if (hadFocus) tabs.querySelector<HTMLElement>(`[data-patch="${hadFocus}"]`)?.focus();
  }

  async function showPatch(rkey?: string, version?: string): Promise<void> {
    closeCard(false);
    box.dataset.state = 'loading';
    const garden = await fetchGarden(fetchImpl, { owner: opts.owner, rkey, version });
    if (garden) {
      owner = garden.owner ?? owner;
      patch = garden.patch;
      if (garden.patches.length) patches = garden.patches;
      flowers = garden.flowers;
      selected = null;
      focusAt = 0;
      say(shut() ?? '');
    } else say(COPY.loadFailed);
    box.dataset.state = garden ? 'ready' : 'error';
    render();
    if (garden) emit();
  }

  tabs?.addEventListener('click', (event) => {
    const b = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-patch]') : null;
    if (b && !b.disabled && b.dataset.patch && b.dataset.patch !== patch?.rkey) void showPatch(b.dataset.patch);
  });
  // Arrow keys move along the tabs; Enter or Space shows that patch.
  tabs?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const all = [...tabs.querySelectorAll<HTMLButtonElement>('[data-patch]:not(:disabled)')];
    const at = all.indexOf(doc.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % all.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next < 0 || !all.length) return;
    e.preventDefault();
    for (const b of all) b.tabIndex = -1;
    all[next]!.tabIndex = 0;
    all[next]!.focus();
  });

  /* ---------- a flower's card ---------- */

  const cardFlower = () => flowers.find((f) => f.uri === cardFor);
  const cardSay = (text: string) => {
    const line = card?.querySelector<HTMLElement>('[data-garden-card-status]');
    if (line) line.textContent = text;
  };

  function fillCard(): void {
    const f = cardFlower();
    if (!card || !f) return;
    const open = patch?.open ?? false;
    const stage = stageFor(f.plantedAt, now(), open);
    const v = flowerVariant(f);
    const mine = isMine(f);
    const close = el(doc, 'button', { type: 'button', class: 'home-card__close', 'aria-label': COPY.close, 'data-garden-card-close': '' });
    close.append(closeIcon(doc));
    const bed = el(doc, 'span', { class: 'home-card__bed', 'aria-hidden': 'true' });
    bed.append(drawFlower(doc, f.kind, stage, v));
    const words = el(doc, 'div', { class: 'home-card__words' });
    words.append(
      el(doc, 'h3', { class: 'home-card__title', id: 'garden-card-title' }, mine ? COPY.yours(f.kind) : COPY.theirs(f.handle, f.kind)),
      el(doc, 'p', { class: 'home-card__meta' }, stage === 'bloom' ? COPY.inBloom(describeBloom(f.kind, v), open) : COPY.growing(stage, dayOf(f.plantedAt, now()))),
    );
    const top = el(doc, 'div', { class: 'home-card__top' });
    top.append(bed, words);
    const parts: HTMLElement[] = [top];
    if (open && f.thirsty) parts.push(el(doc, 'p', { class: 'home-card__note' }, COPY.thirstyFor(thirstyDays(f, now()))));
    const actions = el(doc, 'div', { class: 'home-card__actions' });
    if (mine) actions.append(el(doc, 'a', { class: 'btn btn--primary btn--sm', href: gardenPath(actorOf(f), 'flowers') }, COPY.lookAfter));
    else {
      if (open) {
        const done = wateredToday(local, f.uri, now());
        const water = el(doc, 'button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-garden-water': '' }, done ? COPY.wateredToday : COPY.water);
        water.disabled = done;
        actions.append(water);
      }
      actions.append(el(doc, 'a', { class: 'home-card__link', href: gardenPath(actorOf(f)) }, COPY.theirGarden));
    }
    parts.push(actions, el(doc, 'p', { class: 'home-card__status', role: 'status', 'data-garden-card-status': '' }));
    card.replaceChildren(close, ...parts);
  }

  function openCard(f: Flower, cell: HTMLElement): void {
    if (!card) return;
    cardFor = f.uri;
    fillCard();
    const tb = box.getBoundingClientRect();
    const cb = cell.getBoundingClientRect();
    // Under the flower, or over it when it's near the bottom of the tile.
    const above = cb.bottom - tb.top + 260 > tb.height && cb.top - tb.top > 260;
    card.classList.toggle('is-above', above);
    card.style.setProperty('--card-x', `${Math.round(cb.left - tb.left + cb.width / 2)}px`);
    card.style.setProperty('--card-y', `${Math.round(above ? cb.top - tb.top - 10 : cb.bottom - tb.top + 10)}px`);
    card.hidden = false;
    card.focus();
  }

  /** Closes the card, and puts focus back on its flower if it was inside the card. */
  function closeCard(refocus = true): void {
    if (!card || card.hidden) return;
    const f = cardFlower();
    const inside = card.contains(doc.activeElement);
    card.hidden = true;
    cardFor = null;
    if (refocus && inside && f) plots?.querySelector<HTMLButtonElement>(`[data-plot="${f.plot}"]`)?.focus();
  }

  async function water(): Promise<void> {
    const f = cardFlower();
    const button = card?.querySelector<HTMLButtonElement>('[data-garden-water]');
    if (!f || !button || isBusy(button)) return;
    if (!auth || !signIn) {
      cardSay(COPY.otherHost);
      return;
    }
    intent = 'tend';
    store.set(TEND_KEY, JSON.stringify({ uri: f.uri, cid: f.cid, patch: patch?.rkey }));
    setBusy(button, true);
    try {
      const s = await ensureSession();
      if (!s || !me) {
        signIn.open(COPY.tendLede);
        return;
      }
      await tend(s, { uri: f.uri, cid: f.cid }, 'water', new Date(now()));
      store.remove(TEND_KEY);
      markWatered(local, f.uri, now());
      f.thirsty = false;
      f.lastTended = new Date(now()).toISOString();
      render();
      fillCard();
      cardSay(COPY.watered(isMine(f) ? COPY.yours(f.kind) : COPY.theirs(f.handle, f.kind)));
      burst(plots?.querySelector(`[data-plot="${f.plot}"]`) ?? button, 'drops', win);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(button, false);
    }
  }

  card?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-garden-card-close]')) closeCard();
    else if (target?.closest('[data-garden-water]')) void water();
  });
  card?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') closeCard();
  });
  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Node ? event.target : null;
    if (card && !card.hidden && target && !card.contains(target) && !plots?.contains(target)) closeCard(false);
  });

  plantButton?.addEventListener('click', () => void plant());
  digButton?.addEventListener('click', () => void dig());

  pickKind(kind);

  // Back from signing in with a flower to plant or water: that patch, else the one shown
  // by default.
  const pending = readPending(store, now());
  const backToPlant = pending?.kind === 'plant' && pending.returnTo === returnTo;
  const backToTend = pending?.kind === 'tend' && pending.returnTo === returnTo;
  type ToWater = { uri?: unknown; patch?: unknown } | null;
  let toWater: ToWater = null;
  try {
    toWater = backToTend ? (JSON.parse(store.get(TEND_KEY) ?? 'null') as ToWater) : null;
  } catch {
    toWater = null;
  }
  const storedPatch = backToPlant ? store.get(PATCH_KEY) : typeof toWater?.patch === 'string' ? toWater.patch : null;
  const loaded = fetchGarden(fetchImpl, { owner: opts.owner, rkey: storedPatch && RKEY_RE.test(storedPatch) ? storedPatch : undefined, version: opts.version }).then((garden) => {
    if (garden) {
      owner = garden.owner ?? owner;
      patch = garden.patch;
      patches = garden.patches;
      // A flower planted while this was loading stays.
      const planted = flowers.filter((f) => f.did === fresh);
      flowers = [...garden.flowers.filter((f) => f.did !== fresh), ...planted];
      if (!patch?.open) say(shut()!);
    } else say(COPY.loadFailed);
    tile.dataset.state = garden ? 'ready' : 'error';
    render();
    if (garden) emit();
  });

  if (backToTend) {
    clearPending(store);
    await loaded;
    const f = flowers.find((x) => x.uri === toWater?.uri);
    const cell = f ? plots?.querySelector<HTMLElement>(`[data-plot="${f.plot}"]`) : null;
    if (f && cell) {
      tile.scrollIntoView?.({ block: 'center' });
      openCard(f, cell);
      await water();
    } else store.remove(TEND_KEY);
  } else if (backToPlant) {
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
  return { reload: (version) => showPatch(patch?.rkey, version) };
}
