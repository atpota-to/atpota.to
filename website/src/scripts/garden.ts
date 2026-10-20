/**
 * The flower patch on the home page. Anyone can plant one flower with their Bluesky
 * account: it's a record in their own repo,
 *
 *   to.atpota.garden.sprout  { subject: <atpotato's DID>, kind: "sunflower" | ..., createdAt }
 *
 * and /api/garden (server/garden.ts) gathers everyone's from the network. Planting again
 * swaps your flower for the new kind; "dig mine up" deletes it.
 *
 * Sign-in is the blog's (src/blog/auth.ts, src/blog/signin.ts): the auth server sends the
 * reader back to /blog, which forwards them here, and the flower they picked is planted
 * once they're back (a "plant" pending action, src/blog/state.ts, plus the kind in
 * sessionStorage KIND_KEY). The OAuth library only loads once someone plants or digs.
 *
 * Fetched text only reaches the DOM through textContent.
 */

import { createAuth, type Auth, type Session } from '../blog/auth';
import { createRecord, deleteRecord, findOwn, RepoError } from '../blog/repo';
import { el, isBusy, loadMe, mountSignIn, setBusy, type Me, type SignIn } from '../blog/signin';
import { clearPending, localStoreFor, readPending, savePending, sessionStoreFor } from '../blog/state';
import type { KeyValueStore } from '../poe/storage';
import { burst, cheer } from './burst';
import { readReader, rememberReader } from './reader';

export const SPROUT_NSID = 'to.atpota.garden.sprout';
/** atpotato's DID: every flower points here, which is how the patch finds them. */
export const GARDEN_SUBJECT = 'did:plc:qntsxa2i4sb24noi45fx4np2';
export const GARDEN_ENDPOINT = '/api/garden';
export const FLOWER_KINDS = ['sunflower', 'rose', 'daisy', 'violet', 'poppy', 'tulip'] as const;
export type FlowerKind = (typeof FLOWER_KINDS)[number];
/** sessionStorage: the flower picked before leaving to sign in. */
export const KIND_KEY = 'garden:kind';

export interface Flower {
  did: string;
  handle: string;
  kind: FlowerKind;
  plantedAt: string;
}

export const COPY = {
  plant: (kind: FlowerKind) => `plant a ${kind}`,
  planting: 'planting…',
  planted: (kind: FlowerKind) => `planted! your ${kind} is growing (◕‿◕)`,
  replanted: (kind: FlowerKind) => `swapped! your ${kind} is growing now (◕‿◕)`,
  dug: 'dug up. the patch will miss you.',
  count: (n: number) => (n === 0 ? 'no flowers yet. be the first!' : n === 1 ? '1 flower' : `${n} flowers`),
  loadFailed: "the patch didn't load just now. it's still growing, promise.",
  lede: "sign in with your bluesky account to plant a flower. it's saved in your own account, so it's yours.",
  consent: 'one more step: atpota.to needs your ok to plant flowers. sign in again to allow it.',
  expired: 'your sign-in expired. sign in again to plant.',
  failed: "that didn't work. try again in a moment?",
  otherHost: 'planting works on atpota.to.',
  yours: (handle: string) => `@${handle} (you)`,
} as const;

export function isFlowerKind(value: unknown): value is FlowerKind {
  return typeof value === 'string' && (FLOWER_KINDS as readonly string[]).includes(value);
}

export function sproutRecord(kind: FlowerKind, now: Date): Record<string, unknown> {
  return { $type: SPROUT_NSID, subject: GARDEN_SUBJECT, kind, createdAt: now.toISOString() };
}

/** Where a flower grows: the same spot every time for the same account. */
export function flowerSpot(did: string): { x: number; height: number; sway: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < did.length; i++) {
    h ^= did.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { x: 4 + (h % 9200) / 100, height: 34 + ((h >>> 8) % 48), sway: 3 + ((h >>> 16) % 30) / 10 };
}

function isFlower(v: unknown): v is Flower {
  const f = v as Flower;
  return typeof f?.did === 'string' && f.did.startsWith('did:') && typeof f.handle === 'string' && isFlowerKind(f.kind) && typeof f.plantedAt === 'string';
}

export async function fetchGarden(fetchImpl: typeof fetch = fetch): Promise<Flower[] | null> {
  try {
    const res = await fetchImpl(GARDEN_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { flowers?: unknown };
    return Array.isArray(body?.flowers) ? body.flowers.filter(isFlower) : null;
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
}

export async function initGarden(opts: GardenOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const store = opts.sessionStore ?? sessionStoreFor(win);
  const local = opts.localStore ?? localStoreFor(win);
  const tile = doc.querySelector<HTMLElement>('[data-garden]');
  if (!tile || tile.dataset.gardenBound === 'true') return;
  tile.dataset.gardenBound = 'true';
  const bed = tile.querySelector<HTMLElement>('[data-garden-bed]');
  const count = tile.querySelector<HTMLElement>('[data-garden-count]');
  const status = tile.querySelector<HTMLElement>('[data-garden-status]');
  const plantButton = tile.querySelector<HTMLButtonElement>('[data-garden-plant]');
  const digButton = tile.querySelector<HTMLButtonElement>('[data-garden-dig]');
  const kindButtons = [...tile.querySelectorAll<HTMLButtonElement>('[data-garden-kinds] [data-kind]')];
  const auth = opts.auth === undefined ? createAuth(win) : opts.auth;

  let flowers: Flower[] = [];
  let session: Session | null = null;
  let me: Me | null = null;
  let fresh: string | null = null;
  const stored = store.get(KIND_KEY);
  let kind: FlowerKind = isFlowerKind(stored) ? stored : 'sunflower';

  const say = (text: string) => {
    if (status) status.textContent = text;
  };

  /** The flower that is the reader's: by session, or by the handle the blog remembered. */
  const isMine = (f: Flower) => (me ? f.did === me.did : f.handle === readReader());

  function render(): void {
    if (bed) {
      bed.replaceChildren(
        ...flowers.map((f) => {
          const spot = flowerSpot(f.did);
          const node = el(doc, 'span', { class: `home-flower home-flower--${f.kind}` });
          node.style.setProperty('--x', `${spot.x}%`);
          node.style.setProperty('--h', `${spot.height}px`);
          node.style.setProperty('--sway', `${spot.sway}s`);
          if (isMine(f)) node.classList.add('is-yours');
          if (f.did === fresh) node.classList.add('is-new');
          node.append(el(doc, 'span', { class: 'home-flower__tag' }, isMine(f) ? COPY.yours(f.handle) : `@${f.handle}`), el(doc, 'span', { class: 'home-flower__head' }), el(doc, 'span', { class: 'home-flower__stem' }));
          return node;
        }),
      );
    }
    if (count) count.textContent = COPY.count(flowers.length);
    if (digButton) digButton.hidden = !flowers.some(isMine);
  }

  function pick(next: FlowerKind): void {
    kind = next;
    for (const b of kindButtons) {
      b.setAttribute('aria-checked', String(b.dataset.kind === next));
      b.tabIndex = b.dataset.kind === next ? 0 : -1;
    }
    if (plantButton && !isBusy(plantButton)) plantButton.textContent = COPY.plant(next);
  }

  for (const b of kindButtons) {
    b.addEventListener('click', () => {
      if (isFlowerKind(b.dataset.kind)) pick(b.dataset.kind);
    });
  }
  // Arrow keys move between the flowers, as in any radio group.
  tile.querySelector('[data-garden-kinds]')?.addEventListener('keydown', (event) => {
    const e = event as KeyboardEvent;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = FLOWER_KINDS.indexOf(kind);
    const next = FLOWER_KINDS[(i + step + FLOWER_KINDS.length) % FLOWER_KINDS.length]!;
    pick(next);
    kindButtons.find((b) => b.dataset.kind === next)?.focus();
  });
  pick(kind);

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
      const existing = await findOwn(s, SPROUT_NSID, 'subject', GARDEN_SUBJECT, fetchImpl);
      for (const uri of existing) await deleteRecord(s, uri);
      await createRecord(s, SPROUT_NSID, sproutRecord(kind, new Date(now())));
      store.remove(KIND_KEY);
      const mine: Flower = { did: me.did, handle: me.handle.startsWith('did:') ? 'you' : me.handle, kind, plantedAt: new Date(now()).toISOString() };
      flowers = [...flowers.filter((f) => f.did !== me!.did), mine];
      fresh = me.did;
      render();
      say(existing.length ? COPY.replanted(kind) : COPY.planted(kind));
      burst(plantButton, 'leaves', win);
      cheer(win);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(plantButton, false);
      plantButton.textContent = COPY.plant(kind);
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

  const loaded = fetchGarden(fetchImpl).then((list) => {
    if (list) {
      // A flower planted while this was loading stays.
      const planted = flowers.filter((f) => f.did === fresh);
      flowers = [...list.filter((f) => f.did !== fresh), ...planted];
    } else say(COPY.loadFailed);
    tile.dataset.state = list ? 'ready' : 'error';
    render();
  });

  // Back from signing in with a flower to plant.
  const pending = readPending(store, now());
  if (pending?.kind === 'plant' && pending.returnTo === '/') {
    clearPending(store);
    await loaded;
    tile.scrollIntoView?.({ block: 'center' });
    await plant();
  } else {
    await loaded;
  }
}
