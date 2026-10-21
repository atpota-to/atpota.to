// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_PATHS } from '../server/garden-page.js';
import type { Auth, Prepared, Session } from '../src/blog/auth.js';
import { PENDING_KEY } from '../src/blog/state.js';
import { createStore } from '../src/poe/storage.js';
import { DAY_MS, GROW_DAYS, KIND_INFO, KINDS } from '../src/scripts/flowers.js';
import {
  actorOf,
  careFrom,
  COPY,
  featuredFlower,
  gardenPath,
  initGardenPage,
  LEADERS_SHOWN,
  markSeen,
  numbersFor,
  parseGardenPath,
  poeNotesUrl,
  seenBloom,
} from '../src/scripts/garden-page.js';
import { describeBloom, flowerVariant, GARDEN_SUBJECT, PATCH_NSID, patchUri, SPROUT_NSID, TEND_NSID, type FlowerPatch, type GardenerFlower } from '../src/scripts/garden.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const PAGE = read('../garden/index.html');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const DIALOG = (() => {
  const partial = read('../src/partials/signin.html');
  return partial.slice(partial.indexOf('<dialog'), partial.indexOf('</dialog>') + '</dialog>'.length);
})();

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const CY = 'did:plc:cccccccccccccccccccccccc';
const BO = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const MO = 'did:plc:dddddddddddddddddddddddd';
const PDS = 'https://pds.me.test';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const handles: Record<string, string> = { [ME]: 'me.test', [CY]: 'cy.example', [BO]: 'bo.example', [MO]: 'mo.example', [GARDEN_SUBJECT]: 'atpota.to' };

const community = { rkey: '2026-autumn', uri: patchUri('2026-autumn'), name: 'autumn 2026', season: 'autumn' as const, open: true, cols: 12, rows: 8, owner: { did: GARDEN_SUBJECT, handle: 'atpota.to' } };
const summer = { ...community, rkey: '2026-summer', uri: patchUri('2026-summer'), name: 'summer 2026', season: 'summer' as const, open: false };
const boGarden = { rkey: 'self', uri: patchUri('self', BO), name: "bo's garden", season: null, open: true, cols: 8, rows: 6, owner: { did: BO, handle: 'bo.example' } };

type FP = FlowerPatch;

function flowerOf(did: string, opts: { daysOld?: number; rkey?: string; patch?: FP; kind?: string; plot?: number; care?: number; thirsty?: boolean } = {}): GardenerFlower {
  const rkey = opts.rkey ?? '3kmine';
  const planted = NOW - (opts.daysOld ?? 4.5) * DAY_MS;
  const at = (days: number) => new Date(planted + days * DAY_MS + 3600_000).toISOString();
  const handle = handles[did]!;
  return {
    did,
    rkey,
    uri: `at://${did}/${SPROUT_NSID}/${rkey}`,
    cid: `bafy${rkey}`,
    handle,
    kind: (opts.kind ?? 'violet') as never,
    family: opts.kind === 'seed' ? null : 'flower',
    weather: null,
    plot: opts.plot ?? 31,
    plantedAt: new Date(planted).toISOString(),
    care: opts.care ?? 0.71,
    helpers: 2,
    lastTended: at(3),
    thirsty: opts.thirsty ?? false,
    patch: opts.patch ?? community,
    tends: [
      { did: MO, handle: 'mo.example', action: 'sun', at: at(3) },
      { did, handle, action: 'water', at: at(3) },
      { did: BO, handle: 'bo.example', action: 'water', at: at(2) },
      { did, handle, action: 'sun', at: at(1) },
      { did, handle, action: 'water', at: at(0) },
    ],
  } as GardenerFlower;
}

/** What /api/leaderboard answers: two tied second for flowers, and nobody yet for pets or visitors. */
const leaderboard = () => ({
  flowers: [
    { rank: 1, did: CY, handle: 'cy.example', avatar: null, n: 12, gardens: 4 },
    { rank: 2, did: BO, handle: 'bo.example', avatar: null, n: 5, gardens: 2 },
    { rank: 2, did: MO, handle: 'mo.example', avatar: null, n: 5, gardens: 1 },
  ],
  tending: [{ rank: 1, did: BO, handle: 'bo.example', avatar: null, n: 1204, neighbours: 1 }],
  pets: [],
  kinds: [{ rank: 1, did: CY, handle: 'cy.example', avatar: null, n: 3 }],
  visitors: [],
});

const pressedOf = (did: string, rkey: string, kind: string): GardenerFlower => ({ ...flowerOf(did, { rkey, kind, patch: summer, daysOld: 120, care: 1 }), tends: [] });

interface PersonOpts {
  flowers?: GardenerFlower[];
  garden?: boolean;
  displayName?: string | null;
  poe?: { pets: number; notes: number };
}

interface Rig {
  calls: Array<{ path: string; body: Record<string, unknown> | null }>;
  went: Prepared[];
  asked: string[];
  /** Query strings /api/garden was asked with. */
  gardenAsked: string[];
  /** Times /api/leaderboard was asked. */
  leadersAsked: number;
  run: () => Promise<void>;
}

/** A network where each person may keep a garden (rkey "self"), and the reader may sign in as ME. */
function rig(opts: { signedIn?: boolean; auth?: null; path?: string; people?: Record<string, PersonOpts>; gardenerDown?: boolean; leaders?: Record<string, unknown> | 'down' } = {}): Rig {
  document.body.innerHTML = MAIN + DIALOG;
  window.history.replaceState(null, '', opts.path ?? '/garden');
  const calls: Rig['calls'] = [];
  const went: Prepared[] = [];
  const asked: string[] = [];
  const gardenAsked: string[] = [];
  let leadersAsked = 0;
  const people: Record<string, PersonOpts> = {
    [ME]: { flowers: [flowerOf(ME), flowerOf(ME, { rkey: '3kbo', patch: boGarden, kind: 'tulip', plot: 4, daysOld: 9, care: 0.43, thirsty: true }), pressedOf(ME, '3kold1', 'daisy')], garden: true },
    [CY]: { flowers: [flowerOf(CY), pressedOf(CY, '3kold1', 'daisy')], garden: true, displayName: 'Cy' },
    [GARDEN_SUBJECT]: { flowers: [], garden: true, displayName: 'atpotato' },
    ...opts.people,
  };
  const gardens: Record<string, Record<string, unknown> | null> = {};
  for (const [did, p] of Object.entries(people)) {
    gardens[did] = p.garden ? { name: `${handles[did]!.split('.')[0]}'s garden`, note: 'plant something cheerful', cols: 8, rows: 6, createdAt: '2026-10-01T00:00:00Z' } : null;
  }
  let n = 0;
  const session: Session = {
    did: ME,
    pds: PDS,
    fetch: async (path, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path, body });
      if (path.endsWith('putRecord')) {
        gardens[ME] = body!.record as Record<string, unknown>;
        return Response.json({ uri: `at://${ME}/${PATCH_NSID}/self`, cid: `bafypatch${++n}` });
      }
      return Response.json({ uri: `at://${ME}/${String(body?.collection)}/3t${++n}`, cid: 'bafytend' });
    },
    signOut: async () => undefined,
  };
  const auth: Auth = {
    mode: 'site',
    eager: Boolean(opts.signedIn),
    start: async () => ({ session: opts.signedIn ? session : null, callback: false, error: null }),
    warm: () => undefined,
    prepare: async () => ({ url: 'https://bsky.social/oauth/authorize?x', host: 'bsky.social', account: { did: ME, handle: 'me.test' }, at: Date.now() }),
    go: (p) => went.push(p),
  };
  const didFor = (actor: string) => (actor.startsWith('did:') ? actor : Object.keys(handles).find((d) => handles[d] === actor));
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://atpota.to');
    if (url.pathname === '/api/gardener') {
      const actor = url.searchParams.get('actor') ?? url.searchParams.get('did') ?? '';
      asked.push(actor);
      if (opts.gardenerDown) return new Response('down', { status: 503 });
      const did = didFor(actor);
      const p = did ? people[did] : undefined;
      if (!did || !p) return Response.json({ error: 'not_found' }, { status: 404 });
      const g = gardens[did];
      return Response.json({
        did,
        handle: handles[did],
        displayName: p.displayName ?? null,
        avatar: null,
        garden: g ? { rkey: 'self', uri: patchUri('self', did), name: g.name, note: g.note ?? null, open: !g.closesAt, plots: Number(g.cols) * Number(g.rows), planted: 2 } : null,
        flowers: p.flowers ?? [],
        given: { total: 7, helped: 2, recent: [{ at: '2026-10-19T10:00:00Z', action: 'water', flower: { uri: `at://${BO}/${SPROUT_NSID}/3kx`, owner: { did: BO, handle: 'bo.example' } } }] },
        poe: p.poe,
      });
    }
    if (url.pathname === '/api/garden') {
      gardenAsked.push(url.search);
      const did = didFor(url.searchParams.get('owner') ?? GARDEN_SUBJECT)!;
      const g = gardens[did];
      const owner = { did, handle: handles[did], displayName: null, avatar: null };
      const visitor = (who: string, plot: number) => ({ did: who, rkey: `3k${plot}`, uri: `at://${who}/${SPROUT_NSID}/3k${plot}`, cid: 'bafyv', handle: handles[who], kind: 'daisy', plot, plantedAt: '2026-10-12T00:00:00Z', care: 0.5, helpers: 0, lastTended: null, thirsty: false });
      if (did === GARDEN_SUBJECT) {
        // atpotato's: this season's patch (two in bloom, one thirsty, one just planted), and last season's, pressed
        const autumn = { rkey: '2026-autumn', uri: patchUri('2026-autumn'), cid: 'bafyautumn', name: 'autumn 2026', note: null, season: 'autumn', cols: 12, rows: 8, opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-12-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', open: true };
        const flowers = [visitor(BO, 3), { ...visitor(MO, 9), thirsty: true }, { ...visitor(CY, 20), plantedAt: '2026-10-19T00:00:00Z' }];
        const summary = (p: typeof autumn, planted: number, open: boolean) => ({ rkey: p.rkey, name: p.name, season: p.season, open, planted, plots: 96, opensAt: p.opensAt, closesAt: p.closesAt });
        const summer = { ...autumn, rkey: '2026-summer', name: 'summer 2026', opensAt: '2026-06-01T00:00:00.000Z', closesAt: '2026-09-01T00:00:00.000Z' };
        return Response.json({ owner, patch: autumn, patches: [summary(summer, 5, false), summary(autumn, 3, true)], flowers, total: flowers.length });
      }
      if (!g) return Response.json({ owner, patch: null, patches: [], flowers: [], total: 0 });
      const open = !g.closesAt;
      const patch = { rkey: 'self', uri: patchUri('self', did), cid: 'bafypatch', name: g.name, note: g.note ?? null, season: null, cols: g.cols, rows: g.rows, opensAt: null, closesAt: g.closesAt ?? null, createdAt: g.createdAt, planting: g.planting, open };
      const flowers = [visitor(BO, 3), visitor(MO, 9)];
      return Response.json({ owner, patch, patches: [{ rkey: 'self', name: g.name, season: null, open, planted: flowers.length, plots: Number(g.cols) * Number(g.rows), opensAt: null, closesAt: g.closesAt ?? null }], flowers, total: flowers.length });
    }
    if (url.pathname === '/api/leaderboard') {
      leadersAsked++;
      if (!opts.leaders || opts.leaders === 'down') return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ boards: opts.leaders, updatedAt: '2026-10-20T11:59:00.000Z' });
    }
    if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return {
    calls,
    went,
    asked,
    gardenAsked,
    get leadersAsked() {
      return leadersAsked;
    },
    run: () =>
      initGardenPage({
        auth: opts.auth === null ? null : auth,
        fetchImpl,
        now: () => NOW,
        random: () => 0,
        sessionStore: createStore(() => window.sessionStorage),
        localStore: createStore(() => window.localStorage),
      }),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const text = (sel: string) => $(sel).textContent;
const shown = (sel: string) => !$(sel).hidden;
const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => !e.hidden);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('garden addresses', () => {
  it('reads /garden, someone by handle or DID, and their flowers', () => {
    expect(parseGardenPath('/garden')).toEqual({ actor: null, level: 'garden' });
    expect(parseGardenPath('/garden/')).toEqual({ actor: null, level: 'garden' });
    expect(parseGardenPath('/garden/Dame.Is')).toEqual({ actor: 'dame.is', level: 'garden' });
    expect(parseGardenPath(`/garden/${CY}/flowers`)).toEqual({ actor: CY, level: 'flowers' });
    expect(parseGardenPath('/garden/did%3Aplc%3Acccccccccccccccccccccccc')).toEqual({ actor: CY, level: 'garden' });
    for (const bad of ['/gardens', '/garden/a/b', '/garden/nodot', '/garden/x.y/z', '/garden/%E0%A4%A']) expect(parseGardenPath(bad), bad).toBeNull();
    expect(gardenPath('dame.is', 'flowers')).toBe('/garden/dame.is/flowers');
    expect(actorOf({ did: CY, handle: 'handle.invalid' })).toBe(CY);
    expect(actorOf({ did: CY, handle: 'cy.example' })).toBe('cy.example');
  });

  it('vercel.json serves garden/index.html for every garden address, through the function that gives it its tags', () => {
    const vercel = JSON.parse(read('../vercel.json')) as { cleanUrls?: boolean; rewrites: Array<{ source: string; destination: string }> };
    const garden = vercel.rewrites.filter((r) => r.source.startsWith('/garden'));
    // With cleanUrls, garden/index.html is served at /garden and /garden/index.html only
    // redirects there, so the function (server/garden-page.ts) fetches the page from /garden.
    expect(vercel.cleanUrls).toBe(true);
    expect(garden).toEqual([
      { source: '/garden/:actor', destination: '/api/garden-page?actor=:actor' },
      { source: '/garden/:actor/flowers', destination: '/api/garden-page?actor=:actor&level=flowers' },
    ]);
    expect(PAGE_PATHS).toEqual(['/garden']);
    expect(vercel.rewrites.some((r) => r.destination.endsWith('.html'))).toBe(false);
  });
});

describe('the garden page', () => {
  it('/garden is the community garden: its patch to plant in, a way to sign in, and how it grows', async () => {
    const r = rig();
    await r.run();
    expect(window.location.pathname).toBe('/garden');
    expect(r.asked).toEqual([GARDEN_SUBJECT]);
    expect($('[data-garden-page]').dataset.state).toBe('ready');
    expect(text('[data-head-eyebrow]')).toBe(COPY.community.eyebrow);
    expect(text('[data-head-title]')).toBe(COPY.community.title);
    expect(text('[data-head-lede]')).toBe(COPY.community.lede);
    expect(document.title).toBe(COPY.community.docTitle);
    // the garden's face is a flower, not atpotato's avatar
    expect($('.garden-head__avatar').classList.contains('garden-head__avatar--garden')).toBe(true);
    expect(document.querySelector('.garden-head__avatar svg.home-flower')).not.toBeNull();
    expect(document.querySelector('.garden-head__avatar img')).toBeNull();
    // this season's numbers, not atpotato's own
    const S = COPY.community.stats;
    expect([...document.querySelectorAll('.garden-stats__item')].map((li) => li.textContent)).toEqual([
      `3${S.growing(3)}`,
      `2${S.bloom}`,
      `1${S.thirsty(1)}`,
      `93${S.free(93)}`,
      `42${S.daysLeft(42)}`,
      `8${S.ever}`,
    ]);
    // atpotato's patch, from the home tile's own code, and no "flowers" (that would be atpotato's own)
    expect(shown('[data-garden]')).toBe(true);
    expect(text('[data-garden-name]')).toBe('autumn 2026');
    expect(new URLSearchParams(r.gardenAsked[0]).get('owner')).toBe(GARDEN_SUBJECT);
    expect(shown('[data-levels]')).toBe(false);
    expect(shown('[data-how]')).toBe(true);
    expect(document.querySelector('[data-your-garden]')).toBeNull();
    $<HTMLButtonElement>('[data-head-actions] button').click();
    await flush();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect(text('[data-blog-signin-lede]')).toBe(COPY.tendLede);
  });

  it('/garden signed in is still the community garden, with yours a tap away', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    expect(window.location.pathname).toBe('/garden');
    expect(r.asked).toEqual([GARDEN_SUBJECT]);
    expect(text('[data-head-title]')).toBe(COPY.community.title);
    const go = $('[data-your-garden]');
    expect([go.textContent, go.getAttribute('href'), go.classList.contains('btn--primary')]).toEqual([COPY.community.yours, '/garden/me.test', true]);
    // /garden/atpota.to is the same page; its flowers, asked for by address, keep the way back
    await rig({ signedIn: true, path: '/garden/atpota.to' }).run();
    expect(text('[data-head-title]')).toBe(COPY.community.title);
    expect($('[data-your-garden]').getAttribute('href')).toBe('/garden/me.test');
    await rig({ path: '/garden/atpota.to/flowers' }).run();
    expect(shown('[data-levels]')).toBe(true);
    expect($('[data-level-link="garden"]').getAttribute('href')).toBe('/garden/atpota.to');
    // someone else's page has a quieter one
    await rig({ signedIn: true, path: '/garden/cy.example' }).run();
    expect([text('[data-your-garden]'), $('[data-your-garden]').classList.contains('btn--outline')]).toEqual([COPY.yourGarden, true]);
    // and your own page is yours
    await rig({ signedIn: true, path: '/garden/me.test' }).run();
    expect(text('[data-head-eyebrow]')).toBe(COPY.eyebrow(true));
    expect(document.title).toBe(COPY.docTitle(null));
  });

  it('the community garden has the leaderboards: one board at a time, ranked, with ties', async () => {
    const r = rig({ leaders: leaderboard() });
    await r.run();
    expect(r.leadersAsked).toBe(1);
    expect(shown('[data-leaders]')).toBe(true);
    const boards = [...document.querySelectorAll<HTMLButtonElement>('[data-leaders-boards] button')];
    expect(boards.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      [COPY.leaders.boards.flowers, 'true'],
      [COPY.leaders.boards.tending, 'false'],
      [COPY.leaders.boards.pets, 'false'],
      [COPY.leaders.boards.kinds, 'false'],
      [COPY.leaders.boards.visitors, 'false'],
    ]);
    expect(text('[data-leaders-what]')).toBe(COPY.leaders.what.flowers);
    const rows = () =>
      [...document.querySelectorAll<HTMLElement>('[data-leaders-list] .garden-leader')].map((li) => [
        li.querySelector('.garden-leader__rank')!.textContent,
        li.querySelector('.garden-leader__name')!.textContent,
        li.querySelector('.garden-leader__score')!.textContent,
      ]);
    expect(rows()).toEqual([
      ['1', '@cy.example', `12 ${COPY.leaders.count.flowers(12)}${COPY.leaders.gardens(4)}`],
      ['2', '@bo.example', `5 ${COPY.leaders.count.flowers(5)}${COPY.leaders.gardens(2)}`],
      ['2', '@mo.example', `5 ${COPY.leaders.count.flowers(5)}${COPY.leaders.gardens(1)}`],
    ]);
    // the top three get a colour each; a tie shares one
    expect([...document.querySelectorAll('.garden-leader__rank')].map((n) => n.className)).toEqual([
      'garden-leader__rank is-top1',
      'garden-leader__rank is-top2',
      'garden-leader__rank is-top2',
    ]);
    expect($('.garden-leader__who').getAttribute('href')).toBe('/garden/cy.example');
    // signed out, nobody is "you", and nothing nags
    expect(document.querySelector('.garden-leader.is-you')).toBeNull();
    expect(text('[data-leaders-status]')).toBe('');
    // another board: the same buttons (focus stays put), the other list
    const tending = boards[1]!;
    tending.focus();
    tending.click();
    expect(document.activeElement).toBe(tending);
    expect(tending.getAttribute('aria-pressed')).toBe('true');
    expect(boards[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(text('[data-leaders-what]')).toBe(COPY.leaders.what.tending);
    expect(rows()).toEqual([['1', '@bo.example', `1,204 ${COPY.leaders.count.tending(1204)}${COPY.leaders.neighbours(1)}`]]);
    boards[4]!.click();
    expect(rows()).toEqual([]);
    expect(text('[data-leaders-status]')).toBe(COPY.leaders.empty);
  });

  it('signed in, your own place on each board: in the top, under it, or how to get on', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ rank: i + 1, did: `did:plc:${'p'.repeat(22)}${'abcdefghijklmn'[i]}a`, handle: `p${i}.example`, avatar: null, n: 100 - i }));
    const pets = [...many, { rank: 15, did: ME, handle: 'me.test', avatar: null, n: 3 }];
    const flowers = [...leaderboard().flowers, { rank: 4, did: ME, handle: 'me.test', avatar: null, n: 2, gardens: 2 }];
    const r = rig({ signedIn: true, leaders: { ...leaderboard(), flowers, pets } });
    await r.run();
    // on flowers, in the top
    const you = $('.garden-leader.is-you');
    expect(you.dataset.leader).toBe(ME);
    expect(document.querySelector('.garden-leader__gap')).toBeNull();
    expect(text('[data-leaders-status]')).toBe('');
    expect(you.querySelector('.garden-leader__you')?.textContent).toBe(COPY.leaders.you);
    // on pets, fifteenth: the top ten, then a gap, then you
    $<HTMLButtonElement>('[data-board="pets"]').click();
    const items = [...document.querySelectorAll<HTMLElement>('[data-leaders-list] > li')];
    expect(items).toHaveLength(LEADERS_SHOWN + 2);
    expect(items[LEADERS_SHOWN]!.className).toBe('garden-leader__gap');
    expect(items.at(-1)!.dataset.leader).toBe(ME);
    expect(items.at(-1)!.querySelector('.garden-leader__rank')!.textContent).toBe('15');
    // not on tending yet: how to get on it
    $<HTMLButtonElement>('[data-board="tending"]').click();
    expect(document.querySelector('.garden-leader.is-you')).toBeNull();
    expect(text('[data-leaders-status]')).toBe(COPY.leaders.notYet.tending);
  });

  it('the leaderboards are only on the community garden, and stay out of the way when they don’t load', async () => {
    const theirs = rig({ path: '/garden/cy.example', leaders: leaderboard() });
    await theirs.run();
    expect(theirs.leadersAsked).toBe(0);
    expect(shown('[data-leaders]')).toBe(false);
    const down = rig({ leaders: 'down' });
    await down.run();
    expect(down.leadersAsked).toBe(1);
    expect(shown('[data-leaders]')).toBe(false);
    expect(shown('[data-garden]')).toBe(true);
    expect($('[data-garden-page]').dataset.state).toBe('ready');
  });

  it("someone's page: who they are, their numbers, and their garden to plant in", async () => {
    await rig({ path: '/garden/cy.example' }).run();
    expect($('[data-garden-page]').dataset.state).toBe('ready');
    expect(text('[data-head-title]')).toBe('Cy');
    expect(text('[data-head-lede]')).toBe(COPY.lede('cy.example', false));
    expect(document.title).toBe(COPY.docTitle('Cy'));
    const stats = [...document.querySelectorAll('.garden-stats__item')].map((li) => li.textContent);
    const rare = numbersFor({ did: CY, flowers: [flowerOf(CY), pressedOf(CY, '3kold1', 'daisy')] }, NOW).rare;
    expect(stats).toEqual([`2${COPY.stats.planted(2)}`, `1${COPY.stats.gardens(1)}`, `2${COPY.stats.visitors(2)}`, `7${COPY.stats.tended(7)}`, `${rare}${COPY.stats.rare(rare)}`]);
    // the garden level, with their patch from the home tile's own code
    expect($('[data-level-link="garden"]').getAttribute('aria-current')).toBe('page');
    expect($('[data-level-link="flowers"]').getAttribute('href')).toBe('/garden/cy.example/flowers');
    expect(shown('[data-level="garden"]')).toBe(true);
    expect(shown('[data-level="flowers"]')).toBe(false);
    expect(shown('[data-garden]')).toBe(true);
    expect(text('[data-garden-name]')).toBe("cy's garden");
    expect(text('[data-garden-note]')).toBe('plant something cheerful');
    expect(document.querySelectorAll('[data-garden] [data-plot]')).toHaveLength(48);
    expect(text('[data-visitors-title]')).toBe(COPY.visitors(2));
    expect([...document.querySelectorAll('[data-visitors-list] a')].map((a) => a.getAttribute('href'))).toEqual(['/garden/mo.example', '/garden/bo.example']);
    expect(shown('[data-setup]')).toBe(false);
    expect(shown('[data-settings]')).toBe(false);
  });

  it("someone's page counts their pets for poe, and links to what poe remembers about them", async () => {
    await rig({ path: '/garden/cy.example', people: { [CY]: { flowers: [flowerOf(CY)], garden: true, displayName: 'Cy', poe: { pets: 108, notes: 2 } } } }).run();
    const items = [...document.querySelectorAll<HTMLElement>('.garden-stats__item')];
    expect(items.slice(-2).map((li) => li.textContent)).toEqual([`108${COPY.stats.pets(108)}`, `2${COPY.stats.notes(2)}`]);
    // the pets are just a number; the notes are poe's public record about them
    expect(items.at(-2)!.querySelector('a')).toBeNull();
    const link = items.at(-1)!.querySelector('a.garden-stats__link')!;
    expect(link.getAttribute('href')).toBe(poeNotesUrl(CY));
    expect(poeNotesUrl(CY)).toBe(`https://aturi.to/profile/did:plc:6qw63oash3jfnpykvpbwnq5z/to.atpota.poe.memory/did%3Aplc%3A${'c'.repeat(24)}`);
    // one of each, and none at all says nothing
    await rig({ path: '/garden/cy.example', people: { [CY]: { flowers: [], garden: true, poe: { pets: 1, notes: 1 } } } }).run();
    expect([...document.querySelectorAll('.garden-stats__item')].slice(-2).map((li) => li.textContent)).toEqual([`1${COPY.stats.pets(1)}`, `1${COPY.stats.notes(1)}`]);
    await rig({ path: '/garden/cy.example', people: { [CY]: { flowers: [], garden: true, poe: { pets: 0, notes: 0 } } } }).run();
    expect(document.querySelector('.garden-stats a')).toBeNull();
    expect(document.querySelector('[data-head-stats]')!.textContent).not.toContain('poe');
  });

  it('switching levels changes the address, and back goes back', async () => {
    await rig({ path: '/garden/cy.example' }).run();
    $('[data-level-link="flowers"]').click();
    expect(window.location.pathname).toBe('/garden/cy.example/flowers');
    expect(shown('[data-level="flowers"]')).toBe(true);
    expect(shown('[data-level="garden"]')).toBe(false);
    window.history.replaceState(null, '', '/garden/cy.example');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(shown('[data-level="garden"]')).toBe(true);
  });

  it('your flowers: the one that needs you up close, all of them with quick tending', async () => {
    markSeen(createStore(() => window.localStorage), `at://${ME}/${SPROUT_NSID}/3kbo`);
    const r = rig({ signedIn: true, path: '/garden/me.test/flowers' });
    await r.run();
    expect(shown('[data-level="flowers"]')).toBe(true);
    // up close: the one still growing and not looked after today
    expect(text('[data-featured-title]')).toBe(COPY.growing('a', 'violet', 'bud'));
    expect(text('[data-featured-eyebrow]')).toBe(COPY.featuredEyebrow('the autumn 2026 patch', 32));
    expect(visible('[data-featured-tend] [data-tend]').map((b) => b.dataset.tend)).toEqual(['water', 'sun', 'talk']);
    expect(text('[data-featured-care]')).toBe(`${COPY.care(5)} · ${COPY.odds.twoTone} 24% · ${COPY.odds.ladybug} 6.4%`);
    expect([...document.querySelectorAll('.garden-week__day')].map((d) => d.className.replace('garden-week__day is-', ''))).toEqual(['tended', 'tended', 'missed', 'tended', 'today', 'ahead', 'ahead']);
    // all of them
    expect(text('[data-flowers-title]')).toBe(COPY.flowersTitle(true, 3));
    expect([...document.querySelectorAll('.garden-filters__btn')].map((b) => b.textContent)).toEqual([COPY.filterLabel('all', 3), COPY.filterLabel('growing', 1), COPY.filterLabel('bloom', 1), COPY.filterLabel('pressed', 1)]);
    const items = [...document.querySelectorAll<HTMLElement>('.garden-flower')];
    expect(items).toHaveLength(3);
    expect(items[0]!.classList.contains('is-featured')).toBe(true);
    expect(items[1]!.querySelector('.garden-flower__meta')!.textContent).toBe(COPY.meta.thirsty("bo's garden"));
    expect(items[2]!.classList.contains('is-pressed')).toBe(true);
    expect(items[2]!.querySelectorAll('.garden-flower__tool')).toHaveLength(0);
    expect(items[0]!.querySelectorAll('.garden-flower__tool')).toHaveLength(3);
    // a quick tend from the list
    items[1]!.querySelector<HTMLButtonElement>('.garden-flower__tool.is-water')!.click();
    await flush();
    expect(r.calls[0]!.body!.collection).toBe(TEND_NSID);
    expect(r.calls[0]!.body!.record).toMatchObject({ subject: { uri: `at://${ME}/${SPROUT_NSID}/3kbo` }, action: 'water' });
    expect(text('[data-flowers-status]')).toBe(COPY.tended.water);
    expect([...document.querySelectorAll<HTMLButtonElement>('.garden-flower')[1]!.querySelectorAll<HTMLButtonElement>('.garden-flower__tool')].every((b) => b.disabled)).toBe(true);
    // water them all: only the ones still due
    expect(text('[data-water-all]')).toBe(COPY.waterAll(1));
    $('[data-water-all]').click();
    await flush();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.body!.record).toMatchObject({ subject: { uri: `at://${ME}/${SPROUT_NSID}/3kmine` } });
    expect(text('[data-flowers-status]')).toBe(COPY.wateredAll(1));
    expect(shown('[data-water-all]')).toBe(false);
  });

  it('your numbers, connections and field guide', async () => {
    await rig({ signedIn: true, path: '/garden/me.test/flowers' }).run();
    const numbers = Object.fromEntries([...document.querySelectorAll('.garden-numbers__item')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]));
    expect(numbers).toMatchObject({ [COPY.numbers.planted]: '3', [COPY.numbers.growing]: '1', [COPY.numbers.bloom]: '1', [COPY.numbers.pressed]: '1', [COPY.numbers.tended]: '7', [COPY.numbers.helped]: '2', [COPY.numbers.helpers]: '2', [COPY.numbers.visitors]: '2' });
    const groups = Object.fromEntries([...document.querySelectorAll('.garden-people__group')].map((g) => [g.querySelector('h3')!.textContent, [...g.querySelectorAll('.garden-chip__name')].map((c) => c.textContent)]));
    expect(groups[COPY.people.gardens(true)]).toEqual(['@atpota.to', '@bo.example']);
    expect(groups[COPY.people.visitors(true)]).toEqual(['@mo.example', '@bo.example']);
    expect(groups[COPY.people.helpers(true)]).toEqual(['@mo.example', '@bo.example']);
    expect(groups[COPY.people.helped(true)]).toEqual(['@bo.example']);
    // every kind there is: the pressed daisy found (the tulip has bloomed, but you haven't
    // taken a look yet), the rest dark with where they come from
    expect(text('[data-guide-count]')).toBe(`1 of ${KINDS.length} found`);
    expect([...document.querySelectorAll('.garden-guide__kind.is-found .garden-guide__name')].map((n) => n.textContent)).toEqual(['daisy']);
    const storm = [...document.querySelectorAll('.garden-guide__kind')][KINDS.indexOf('storm-lily')]!;
    expect(storm.querySelector('.garden-guide__note')!.textContent).toBe(KIND_INFO['storm-lily'].origin);
    expect(storm.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(COPY.guideMissing(KIND_INFO['storm-lily'].origin));
  });

  it('picking another flower brings it up close', async () => {
    await rig({ signedIn: true, path: '/garden/me.test/flowers' }).run();
    const items = [...document.querySelectorAll<HTMLElement>('.garden-flower')];
    items[2]!.querySelector<HTMLButtonElement>('.garden-flower__name')!.click();
    const pressed = pressedOf(ME, '3kold1', 'daisy');
    expect(text('[data-featured-title]')).toBe(describeBloom('daisy', flowerVariant(pressed)));
    expect($('[data-featured-bed]').classList.contains('is-pressed')).toBe(true);
    expect(shown('[data-featured-tend]')).toBe(false);
    expect(document.activeElement).toBe($('[data-featured-title]'));
  });

  it('on the day it blooms, the bud waits for you to take a look', async () => {
    const bloomed = flowerOf(ME, { daysOld: 7.5, care: 1 });
    await rig({ signedIn: true, path: '/garden/me.test/flowers', people: { [ME]: { flowers: [bloomed], garden: true } } }).run();
    expect(text('[data-featured-title]')).toBe(COPY.waiting);
    expect(text('.garden-flower__name')).toBe(COPY.somethingBlooming);
    $('[data-reveal]').click();
    const v = flowerVariant(bloomed);
    expect(text('[data-featured-title]')).toBe(describeBloom('violet', v));
    expect(document.querySelector('.garden-hero__ribbon')).not.toBeNull();
    expect(text('[data-featured-status]')).toBe(COPY.bloomed('violet', describeBloom('violet', v)));
    expect(seenBloom(createStore(() => window.localStorage), bloomed.uri)).toBe(true);
    expect(text('.garden-flower__name')).toBe(describeBloom('violet', v));
  });

  it('a seed stays a seed until the garden says what it grew into; then it waits for you to take a look', async () => {
    const budding = { ...flowerOf(ME, { rkey: '3kseed1', kind: 'seed', daysOld: 3 }), family: 'leafy' as const };
    const opening = { ...flowerOf(ME, { rkey: '3kseed2', kind: 'seed', daysOld: 7.5, plot: 2 }), tends: [] };
    await rig({ signedIn: true, path: '/garden/me.test/flowers', people: { [ME]: { flowers: [opening, budding], garden: true } } }).run();
    // the one in bloom isn't known yet: no reveal, just "it's opening"
    expect(text('[data-featured-title]')).toBe(COPY.opening);
    expect(document.querySelector('[data-reveal]')).toBeNull();
    const names = [...document.querySelectorAll('.garden-flower__name')].map((n) => n.textContent);
    expect(names).toEqual([COPY.somethingBlooming, COPY.growing('a', 'seed', 'bud')]);
    // nothing about a seed counts in the field guide or as a rare find until it's known
    expect(text('[data-guide-count]')).toBe(`0 of ${KINDS.length} found`);

    // once the garden has settled it, it's a bloom like any other, waiting to be seen
    const known = { ...opening, kind: 'lotus' as const, family: 'flower' as const, weather: { planted: { wind: 0, mix: 1 }, grew: { wind: 1, mix: 1, apps: [] } } };
    await rig({ signedIn: true, path: '/garden/me.test/flowers', people: { [ME]: { flowers: [known], garden: true } } }).run();
    expect(text('[data-featured-title]')).toBe(COPY.waiting);
    expect(text('[data-guide-count]')).toBe(`0 of ${KINDS.length} found`);
    $('[data-reveal]').click();
    expect(text('[data-featured-title]')).toBe(describeBloom('lotus', flowerVariant(known)));
    expect(text('[data-featured-lede]')).toContain('planted in a calm minute, grew in a light week under a usual sky.');
    expect(text('[data-guide-count]')).toBe(`1 of ${KINDS.length} found`);
  });

  it("setting up your garden writes a patch record in your repo, then it's ready to plant in", async () => {
    const r = rig({ signedIn: true, path: '/garden/me.test', people: { [ME]: { flowers: [], garden: false } } });
    await r.run();
    expect(shown('[data-setup]')).toBe(true);
    expect(shown('[data-garden]')).toBe(false);
    const form = $<HTMLFormElement>('[data-setup-form]');
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe("me's garden");
    (form.elements.namedItem('note') as HTMLTextAreaElement).value = 'come say hi';
    // one size for every garden: nothing to pick
    expect(form.querySelector('input[name="size"]')).toBeNull();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const put = r.calls.find((c) => c.path.endsWith('putRecord'))!.body!;
    expect(put).toMatchObject({ repo: ME, collection: PATCH_NSID, rkey: 'self' });
    expect(put.record).toMatchObject({ $type: PATCH_NSID, name: "me's garden", note: 'come say hi', cols: 12, rows: 8 });
    // one flower each unless you say otherwise: the default, so it isn't written
    expect(put.record).not.toHaveProperty('planting');
    // the garden is loaded at the version just saved, not an older cached one
    expect(new URLSearchParams(r.gardenAsked.at(-1)).get('v')).toBe('bafypatch1');
    expect(shown('[data-setup]')).toBe(false);
    expect(shown('[data-garden]')).toBe(true);
    expect(document.querySelectorAll('[data-garden] [data-plot]')).toHaveLength(96);
    expect(text('[data-head-status]')).toBe(COPY.setup.done);
    expect(shown('[data-settings]')).toBe(true);
    expect(shown('[data-how]')).toBe(true);
  });

  it('your garden settings: rename, let people plant more than one, or close it', async () => {
    const r = rig({ signedIn: true, path: '/garden/me.test' });
    await r.run();
    expect(shown('[data-settings]')).toBe(true);
    const form = $<HTMLFormElement>('[data-settings-form]');
    const many = () => form.elements.namedItem('many') as HTMLInputElement;
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe("me's garden");
    expect(form.querySelector('input[name="size"]')).toBeNull();
    expect(many().checked).toBe(false);
    (form.elements.namedItem('name') as HTMLInputElement).value = 'the back yard';
    many().checked = true;
    (form.elements.namedItem('open') as HTMLInputElement).checked = false;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const put = r.calls.find((c) => c.path.endsWith('putRecord'))!.body!;
    // a garden already planted keeps its size, so no flower moves
    expect(put.record).toMatchObject({ name: 'the back yard', cols: 8, rows: 6, planting: 'many', createdAt: '2026-10-01T00:00:00Z', closesAt: new Date(NOW).toISOString() });
    expect(many().checked).toBe(true);
    expect(text('[data-settings-status]')).toBe(COPY.setup.saved);
    expect(new URLSearchParams(r.gardenAsked.at(-1)).get('v')).toBe('bafypatch1');
    expect(text('[data-garden-name]')).toBe('the back yard');
    expect(document.querySelector('[data-garden] [data-garden-plots]')!.hasAttribute('data-pressed')).toBe(true);
  });

  it("someone without a garden: says so, and their flowers are a tap away", async () => {
    await rig({ path: '/garden/cy.example', people: { [CY]: { flowers: [flowerOf(CY)], garden: false } } }).run();
    expect(shown('[data-none]')).toBe(true);
    expect(text('[data-none-text]')).toBe(COPY.none('cy.example'));
    expect(shown('[data-garden]')).toBe(false);
    expect(shown('[data-setup]')).toBe(false);
  });

  it("a visitor waters someone's flower from their flowers", async () => {
    const r = rig({ signedIn: true, path: '/garden/cy.example/flowers' });
    await r.run();
    expect(visible('[data-featured-tend] [data-tend]').map((b) => b.dataset.tend)).toEqual(['water']);
    expect(text('[data-featured-title]')).toBe(COPY.growing("@cy.example's", 'violet', 'bud'));
    expect(shown('[data-water-all]')).toBe(false);
    $('[data-featured-tend] [data-tend="water"]').click();
    await flush();
    expect(r.calls[0]!.body!.record).toMatchObject({ subject: { uri: `at://${CY}/${SPROUT_NSID}/3kmine` }, action: 'water' });
    expect(text('[data-featured-status]')).toBe(COPY.visitorWatered);
  });

  it('signed out, tending asks to sign in and comes back to the same page', async () => {
    const r = rig({ path: '/garden/cy.example/flowers' });
    await r.run();
    $('[data-featured-tend] [data-tend="water"]').click();
    await flush();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    $<HTMLInputElement>('input[name="handle"]').value = 'me.test';
    $('form[data-blog-signin-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    $('[data-blog-signin-go]').click();
    await flush();
    expect(r.went).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY)!)).toMatchObject({ kind: 'tend', returnTo: '/garden/cy.example/flowers' });
    await rig({ signedIn: true, path: '/garden/cy.example/flowers' }).run();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("back from signing in to water a flower in someone's garden, it waters it", async () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ kind: 'tend', returnTo: '/garden/cy.example', at: NOW }));
    sessionStorage.setItem('garden:tend', JSON.stringify({ uri: `at://${BO}/${SPROUT_NSID}/3k3`, cid: 'bafyv', patch: 'self' }));
    const r = rig({ signedIn: true, path: '/garden/cy.example' });
    await r.run();
    expect(r.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ subject: { uri: `at://${BO}/${SPROUT_NSID}/3k3` }, action: 'water' });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem('garden:tend')).toBeNull();
  });

  it('says so for someone who isn’t there, and when it doesn’t load', async () => {
    await rig({ path: '/garden/nobody.example' }).run();
    expect($('[data-garden-page]').dataset.state).toBe('missing');
    expect(text('[data-head-lede]')).toBe(COPY.missing.lede('nobody.example'));
    expect($('[data-head-actions] a').getAttribute('href')).toBe('/garden');
    await rig({ path: '/garden/a/b' }).run();
    expect($('[data-garden-page]').dataset.state).toBe('missing');
    await rig({ path: '/garden/cy.example', gardenerDown: true }).run();
    expect($('[data-garden-page]').dataset.state).toBe('error');
    expect(text('[data-head-lede]')).toBe(COPY.loadFailed);
  });
});

describe('garden sums', () => {
  it('counts care like the server: days its owner tended it while it grew, plus up to three helpers', () => {
    const f = flowerOf(ME);
    expect(careFrom(f)).toBe(Math.round((5 / 7) * 100) / 100);
    const crowd = { ...f, tends: ['e', 'f', 'g', 'h', 'i'].map((c) => ({ did: `did:plc:${c.repeat(24)}`, handle: 'x', action: 'water' as const, at: f.tends[0]!.at })) };
    expect(careFrom(crowd)).toBe(Math.round((3 / 7) * 100) / 100);
  });

  it('adds up numbers and picks the flower to show up close', () => {
    const flowers = [flowerOf(ME), pressedOf(ME, '3kold1', 'daisy')];
    expect(numbersFor({ did: ME, flowers }, NOW)).toMatchObject({ planted: 2, growing: 1, pressed: 1, gardens: 1, helpers: 2 });
    const pick = (owner: boolean, seen: boolean, tended: boolean) => featuredFlower(flowers, { owner, now: NOW, seen: () => seen, tendedToday: () => tended });
    expect(pick(true, true, false)).toBe(flowers[0]);
    expect(pick(true, true, true)).toBe(flowers[0]);
    const bloom = flowerOf(ME, { rkey: '3kb', daysOld: 8 });
    expect(featuredFlower([flowers[0]!, bloom], { owner: true, now: NOW, seen: () => false, tendedToday: () => true })).toBe(bloom);
    markSeen(createStore(() => window.localStorage), bloom.uri);
    expect(seenBloom(createStore(() => window.localStorage), bloom.uri)).toBe(true);
    expect(GROW_DAYS).toBe(7);
  });
});
