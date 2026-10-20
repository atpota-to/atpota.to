// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Auth, Prepared, Session } from '../src/blog/auth.js';
import { PENDING_KEY } from '../src/blog/state.js';
import { createStore } from '../src/poe/storage.js';
import { DAY_MS, GROW_DAYS } from '../src/scripts/flowers.js';
import {
  actorOf,
  careFrom,
  COPY,
  featuredFlower,
  gardenPath,
  initGardenPage,
  markSeen,
  numbersFor,
  parseGardenPath,
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

const pressedOf = (did: string, rkey: string, kind: string): GardenerFlower => ({ ...flowerOf(did, { rkey, kind, patch: summer, daysOld: 120, care: 1 }), tends: [] });

interface PersonOpts {
  flowers?: GardenerFlower[];
  garden?: boolean;
  displayName?: string | null;
}

interface Rig {
  calls: Array<{ path: string; body: Record<string, unknown> | null }>;
  went: Prepared[];
  asked: string[];
  /** Query strings /api/garden was asked with. */
  gardenAsked: string[];
  run: () => Promise<void>;
}

/** A network where each person may keep a garden (rkey "self"), and the reader may sign in as ME. */
function rig(opts: { signedIn?: boolean; auth?: null; path?: string; people?: Record<string, PersonOpts>; gardenerDown?: boolean } = {}): Rig {
  document.body.innerHTML = MAIN + DIALOG;
  window.history.replaceState(null, '', opts.path ?? '/garden');
  const calls: Rig['calls'] = [];
  const went: Prepared[] = [];
  const asked: string[] = [];
  const gardenAsked: string[] = [];
  const people: Record<string, PersonOpts> = {
    [ME]: { flowers: [flowerOf(ME), flowerOf(ME, { rkey: '3kbo', patch: boGarden, kind: 'tulip', plot: 4, daysOld: 9, care: 0.43, thirsty: true }), pressedOf(ME, '3kold1', 'daisy')], garden: true },
    [CY]: { flowers: [flowerOf(CY), pressedOf(CY, '3kold1', 'daisy')], garden: true, displayName: 'Cy' },
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
      });
    }
    if (url.pathname === '/api/garden') {
      gardenAsked.push(url.search);
      const did = didFor(url.searchParams.get('owner') ?? GARDEN_SUBJECT)!;
      const g = gardens[did];
      const owner = { did, handle: handles[did], displayName: null, avatar: null };
      if (!g) return Response.json({ owner, patch: null, patches: [], flowers: [], total: 0 });
      const open = !g.closesAt;
      const patch = { rkey: 'self', uri: patchUri('self', did), cid: 'bafypatch', name: g.name, note: g.note ?? null, season: null, cols: g.cols, rows: g.rows, opensAt: null, closesAt: g.closesAt ?? null, createdAt: g.createdAt, open };
      const visitor = (who: string, plot: number) => ({ did: who, rkey: `3k${plot}`, uri: `at://${who}/${SPROUT_NSID}/3k${plot}`, cid: 'bafyv', handle: handles[who], kind: 'daisy', plot, plantedAt: '2026-10-12T00:00:00Z', care: 0.5, helpers: 0, lastTended: null, thirsty: false });
      const flowers = [visitor(BO, 3), visitor(MO, 9)];
      return Response.json({ owner, patch, patches: [{ rkey: 'self', name: g.name, season: null, open, planted: flowers.length, plots: Number(g.cols) * Number(g.rows), opensAt: null, closesAt: g.closesAt ?? null }], flowers, total: flowers.length });
    }
    if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return {
    calls,
    went,
    asked,
    gardenAsked,
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

  it('vercel.json serves garden/index.html for every garden address', () => {
    const vercel = JSON.parse(read('../vercel.json')) as { rewrites: Array<{ source: string; destination: string }> };
    const garden = vercel.rewrites.filter((r) => r.source.startsWith('/garden'));
    expect(garden).toEqual([
      { source: '/garden/:actor', destination: '/garden/index.html' },
      { source: '/garden/:actor/flowers', destination: '/garden/index.html' },
    ]);
  });
});

describe('the garden page', () => {
  it('/garden signed out: a welcome, a way in, and how it grows', async () => {
    await rig().run();
    expect($('[data-garden-page]').dataset.state).toBe('landing');
    expect(text('[data-head-title]')).toBe(COPY.landing.title);
    expect(shown('[data-how]')).toBe(true);
    expect($('[data-head-actions] a').getAttribute('href')).toBe('/garden/atpota.to');
    $('[data-landing-signin]').click();
    await flush();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect(text('[data-blog-signin-lede]')).toBe(COPY.tendLede);
  });

  it('/garden signed in becomes your own page, at your address', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    expect(window.location.pathname).toBe('/garden/me.test');
    expect(r.asked).toEqual(['me.test']);
    expect(text('[data-head-eyebrow]')).toBe(COPY.eyebrow(true));
    expect(document.title).toBe(COPY.docTitle(null));
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
    expect(text('[data-guide-count]')).toMatch(/^\d+ of 20 found$/);
    expect(document.querySelectorAll('.garden-guide__cell.is-found').length).toBeGreaterThanOrEqual(2);
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

  it("setting up your garden writes a patch record in your repo, then it's ready to plant in", async () => {
    const r = rig({ signedIn: true, path: '/garden/me.test', people: { [ME]: { flowers: [], garden: false } } });
    await r.run();
    expect(shown('[data-setup]')).toBe(true);
    expect(shown('[data-garden]')).toBe(false);
    const form = $<HTMLFormElement>('[data-setup-form]');
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe("me's garden");
    (form.elements.namedItem('note') as HTMLTextAreaElement).value = 'come say hi';
    form.querySelector<HTMLInputElement>('input[value="small"]')!.checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const put = r.calls.find((c) => c.path.endsWith('putRecord'))!.body!;
    expect(put).toMatchObject({ repo: ME, collection: PATCH_NSID, rkey: 'self' });
    expect(put.record).toMatchObject({ $type: PATCH_NSID, name: "me's garden", note: 'come say hi', cols: 6, rows: 4 });
    // the garden is loaded at the version just saved, not an older cached one
    expect(new URLSearchParams(r.gardenAsked.at(-1)).get('v')).toBe('bafypatch1');
    expect(shown('[data-setup]')).toBe(false);
    expect(shown('[data-garden]')).toBe(true);
    expect(document.querySelectorAll('[data-garden] [data-plot]')).toHaveLength(24);
    expect(text('[data-head-status]')).toBe(COPY.setup.done);
    expect(shown('[data-settings]')).toBe(true);
    expect(shown('[data-how]')).toBe(true);
  });

  it('your garden settings: rename, resize, or close it', async () => {
    const r = rig({ signedIn: true, path: '/garden/me.test' });
    await r.run();
    expect(shown('[data-settings]')).toBe(true);
    const form = $<HTMLFormElement>('[data-settings-form]');
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe("me's garden");
    expect(form.querySelector<HTMLInputElement>('input[value="medium"]')!.checked).toBe(true);
    (form.elements.namedItem('name') as HTMLInputElement).value = 'the back yard';
    form.querySelector<HTMLInputElement>('input[value="large"]')!.checked = true;
    (form.elements.namedItem('open') as HTMLInputElement).checked = false;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const put = r.calls.find((c) => c.path.endsWith('putRecord'))!.body!;
    expect(put.record).toMatchObject({ name: 'the back yard', cols: 12, rows: 8, createdAt: '2026-10-01T00:00:00Z', closesAt: new Date(NOW).toISOString() });
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
