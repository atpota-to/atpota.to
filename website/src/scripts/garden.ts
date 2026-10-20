/**
 * The flower patch on the home page: a grid of plots, seen from above. Anyone can plant one
 * flower with their Bluesky account. It's a record in their own repo, tied to their DID:
 *
 *   to.atpota.garden.sprout  { subject: <atpotato's DID>, kind: "sunflower" | ..., plot, createdAt }
 *
 * and /api/garden (server/garden.ts) gathers everyone's from the network, settles plots two
 * people asked for (the earlier flower keeps it) and says how many rows the grid has. Each
 * flower's look grows from its DID and record key (flowers.ts), and it goes from sprout to
 * bud to bloom over its first few days. Planting again moves your flower (a new record, so
 * a new look); "dig mine up" deletes it.
 *
 * Picking: tap an empty plot (or "pick a plot" for one near the middle), then plant. The
 * plots are one tab stop; arrow keys move between them. On narrow screens the same plots
 * wrap six across, so each row of twelve shows as two.
 *
 * Sign-in is the blog's (src/blog/auth.ts, src/blog/signin.ts): the auth server sends the
 * reader back to /blog, which forwards them here, and the flower they picked is planted in
 * the plot they picked once they're back (a "plant" pending action, src/blog/state.ts, plus
 * KIND_KEY and PLOT_KEY in sessionStorage). The OAuth library only loads once someone plants
 * or digs.
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { createRecord, deleteRecord, findOwn, parseRecordUri, RepoError } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { drawFlower, FLOWER_KINDS, flowerSeed, sampleVariant, stageFor, variantFor, type FlowerKind, type Stage } from './flowers';
import { readReader, rememberReader } from './reader';

export { FLOWER_KINDS, type FlowerKind } from './flowers';

export const SPROUT_NSID = 'to.atpota.garden.sprout';
/** atpotato's DID: every flower points here, which is how the patch finds them. */
export const GARDEN_SUBJECT = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const GARDEN_ENDPOINT = '/api/garden';
/** Match server/garden.ts. */
export const GRID_COLS = 12;
export const MIN_ROWS = 5;
export const MAX_PLOTS = GRID_COLS * 40;
/** sessionStorage: the flower and plot picked before leaving to sign in. */
export const KIND_KEY = 'garden:kind';
export const PLOT_KEY = 'garden:plot';

export interface Flower {
  did: string;
  rkey: string;
  handle: string;
  kind: FlowerKind;
  plot: number;
  plantedAt: string;
}

export const COPY = {
  pick: 'pick a plot',
  plantHere: (kind: FlowerKind) => `plant a ${kind} here`,
  planting: 'planting…',
  choose: (kind: FlowerKind) => `tap an empty plot to plant your ${kind} there, or plant it here.`,
  planted: (kind: FlowerKind) => `planted! your ${kind} is a sprout for now, and it blooms in a few days (◕‿◕)`,
  moved: (kind: FlowerKind) => `moved! a new ${kind} is growing in your new plot (◕‿◕)`,
  dug: 'dug up. the patch will miss you.',
  count: (n: number, plots: number) => (n === 0 ? `${plots} empty plots. be the first!` : `${n} of ${plots} plots planted`),
  loadFailed: "the patch didn't load just now. it's still growing, promise.",
  lede: "sign in with your bluesky account to plant a flower. it's saved in your own account, so it's yours.",
  consent: 'one more step: atpota.to needs your ok to plant flowers. sign in again to allow it.',
  expired: 'your sign-in expired. sign in again to plant.',
  failed: "that didn't work. try again in a moment?",
  otherHost: 'planting works on atpota.to.',
  you: 'you',
  plantTag: 'plant here',
  stage: { sprout: 'just planted', bud: 'budding', bloom: 'in bloom' } satisfies Record<Stage, string>,
  emptyPlot: (n: number, selected: boolean) => `empty plot ${n}${selected ? ', picked' : ''}`,
  flowerPlot: (who: string, kind: FlowerKind, stage: Stage) => `${who} ${kind}, ${COPY.stage[stage]}`,
} as const;

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

export function isPlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_PLOTS;
}

export function sproutRecord(kind: FlowerKind, plot: number, now: Date): Record<string, unknown> {
  return { $type: SPROUT_NSID, subject: GARDEN_SUBJECT, kind, plot, createdAt: now.toISOString() };
}

/** Rows the grid needs: MIN_ROWS, every planted plot, and at least one free plot. */
export function rowsFor(flowers: readonly { plot: number }[]): number {
  const highest = flowers.reduce((m, f) => Math.max(m, f.plot), -1);
  return Math.max(MIN_ROWS, Math.ceil((highest + 1) / GRID_COLS), Math.ceil((flowers.length + 1) / GRID_COLS));
}

/**
 * A free plot near the middle of the grid (for "pick a plot"), or null when none is free.
 * `cols` is how many plots across it shows: on narrow screens the same plots wrap six across.
 */
export function middlePlot(taken: ReadonlySet<number>, rows: number, random: () => number = Math.random, cols: number = GRID_COLS): number | null {
  const total = rows * GRID_COLS;
  const cx = (cols - 1) / 2;
  const cy = (Math.ceil(total / cols) - 1) / 2;
  const free: Array<[number, number]> = [];
  for (let i = 0; i < total; i++) {
    if (taken.has(i)) continue;
    const d = Math.hypot((i % cols) - cx, Math.floor(i / cols) - cy) + random() * 2.5;
    free.push([d, i]);
  }
  free.sort((a, b) => a[0] - b[0]);
  return free[0]?.[1] ?? null;
}

/** `plot` if nobody else has it, else the next free one along. */
export function freePlotFrom(plot: number, taken: ReadonlySet<number>): number {
  let p = plot;
  for (let n = 0; n < MAX_PLOTS && taken.has(p); n++) p = (p + 1) % MAX_PLOTS;
  return p;
}

function isFlower(v: unknown): v is Flower {
  const f = v as Flower;
  return (
    typeof f?.did === 'string' &&
    f.did.startsWith('did:') &&
    typeof f.rkey === 'string' &&
    typeof f.handle === 'string' &&
    isFlowerKind(f.kind) &&
    isPlot(f.plot) &&
    typeof f.plantedAt === 'string'
  );
}

export async function fetchGarden(fetchImpl: typeof fetch = fetch): Promise<{ flowers: Flower[]; rows: number } | null> {
  try {
    const res = await fetchImpl(GARDEN_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { flowers?: unknown; rows?: unknown };
    if (!Array.isArray(body?.flowers)) return null;
    const flowers = body.flowers.filter(isFlower);
    const rows = typeof body.rows === 'number' && Number.isInteger(body.rows) && body.rows > 0 && body.rows <= MAX_PLOTS / GRID_COLS ? body.rows : MIN_ROWS;
    return { flowers, rows };
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

  let flowers: Flower[] = [];
  let serverRows = MIN_ROWS;
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
  const rows = () => Math.max(serverRows, rowsFor(flowers));
  const taken = () => new Set(flowers.map((f) => f.plot));
  /** Plots across as shown: twelve, or six on narrow screens (home.css). */
  const shownCols = () => {
    const n = plots ? win.getComputedStyle(plots).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
    return n === 6 ? 6 : GRID_COLS;
  };

  /** The reader's flower: by session, or by the handle the blog remembered. */
  const isMine = (f: Flower) => (me ? f.did === me.did : f.handle === readReader());

  function plotButton(i: number, at: Map<number, Flower>): HTMLButtonElement {
    const f = at.get(i);
    const b = el(doc, 'button', { type: 'button', class: 'home-plot', 'data-plot': String(i) });
    b.tabIndex = i === focusAt ? 0 : -1;
    if (f) {
      const stage = stageFor(f.plantedAt, now());
      const mine = isMine(f);
      b.classList.add('home-plot--planted');
      if (mine) b.classList.add('is-yours');
      if (f.did === fresh) b.classList.add('is-new');
      b.setAttribute('aria-label', COPY.flowerPlot(mine ? 'your' : `@${f.handle}'s`, f.kind, stage));
      b.append(drawFlower(doc, f.kind, stage, variantFor(f.kind, flowerSeed(f.did, f.rkey))));
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
    const total = rows() * GRID_COLS;
    focusAt = Math.min(focusAt, total - 1);
    if (plots) {
      const hadFocus = plots.contains(doc.activeElement);
      const at = new Map(flowers.map((f) => [f.plot, f]));
      plots.replaceChildren(...Array.from({ length: total }, (_, i) => plotButton(i, at)));
      if (hadFocus) plots.querySelector<HTMLButtonElement>(`[data-plot="${focusAt}"]`)?.focus();
    }
    if (count) count.textContent = COPY.count(flowers.length, total);
    if (digButton) digButton.hidden = !flowers.some(isMine);
    if (plantButton && !isBusy(plantButton)) plantButton.textContent = selected === null ? COPY.pick : COPY.plantHere(kind);
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
    if (cell.classList.contains('home-plot--empty')) select(selected === i ? null : i);
  });
  // The plots are one tab stop; arrows, Home and End move between them.
  plots?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const total = rows() * GRID_COLS;
    const cols = shownCols();
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    const from = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-plot]') : null;
    if (from) focusAt = Number(from.dataset.plot);
    let next: number | null = null;
    if (e.key in moves) next = focusAt + moves[e.key]!;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = total - 1;
    if (next === null || next < 0 || next >= total) return;
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

  async function plant(): Promise<void> {
    if (!plantButton || isBusy(plantButton)) return;
    if (selected === null) {
      select(middlePlot(taken(), rows(), random, shownCols()));
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
      const did = me.did;
      // Someone may have taken the plot while this page was open: the next free one, then.
      const others = new Set(flowers.filter((f) => f.did !== did).map((f) => f.plot));
      const plot = freePlotFrom(selected, others);
      const existing = await findOwn(s, SPROUT_NSID, 'subject', GARDEN_SUBJECT, fetchImpl);
      for (const uri of existing) await deleteRecord(s, uri);
      const planted = new Date(now());
      const ref = await createRecord(s, SPROUT_NSID, sproutRecord(kind, plot, planted));
      store.remove(KIND_KEY);
      store.remove(PLOT_KEY);
      const mine: Flower = {
        did,
        rkey: parseRecordUri(ref.uri)?.rkey ?? String(planted.getTime()),
        handle: me.handle.startsWith('did:') ? COPY.you : me.handle,
        kind,
        plot,
        plantedAt: planted.toISOString(),
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
      for (const uri of await findOwn(s, SPROUT_NSID, 'subject', GARDEN_SUBJECT, fetchImpl)) await deleteRecord(s, uri);
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

  const loaded = fetchGarden(fetchImpl).then((garden) => {
    if (garden) {
      // A flower planted while this was loading stays.
      const planted = flowers.filter((f) => f.did === fresh);
      flowers = [...garden.flowers.filter((f) => f.did !== fresh), ...planted];
      serverRows = garden.rows;
    } else say(COPY.loadFailed);
    tile.dataset.state = garden ? 'ready' : 'error';
    render();
  });

  // Back from signing in with a flower to plant.
  const pending = readPending(store, now());
  if (pending?.kind === 'plant' && pending.returnTo === '/') {
    clearPending(store);
    await loaded;
    const stored = store.get(PLOT_KEY);
    const want = stored === null ? null : Number(stored);
    selected = isPlot(want) ? want : middlePlot(taken(), rows(), random, shownCols());
    tile.scrollIntoView?.({ block: 'center' });
    render();
    await plant();
  } else {
    await loaded;
  }
}
