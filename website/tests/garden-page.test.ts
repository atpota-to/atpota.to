// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Auth, Prepared, Session } from '../src/blog/auth.js';
import { PENDING_KEY } from '../src/blog/state.js';
import { createStore } from '../src/poe/storage.js';
import { DAY_MS, GROW_DAYS } from '../src/scripts/flowers.js';
import { careFrom, COPY, initGardenPage, markSeen, SEEN_KEY, seenBloom, VISIT_KEY } from '../src/scripts/garden-page.js';
import { describeBloom, flowerVariant, patchUri, SPROUT_NSID, TEND_NSID } from '../src/scripts/garden.js';

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
const autumn = { rkey: '2026-autumn', uri: patchUri('2026-autumn'), name: 'autumn 2026', season: 'autumn', open: true, cols: 12, rows: 8 };
const summer = { ...autumn, rkey: '2026-summer', uri: patchUri('2026-summer'), name: 'summer 2026', season: 'summer', open: false };

function flowerOf(did: string, handle: string, opts: { daysOld?: number; rkey?: string; patch?: typeof autumn; kind?: string; plot?: number; care?: number } = {}) {
  const rkey = opts.rkey ?? '3kmine';
  const planted = NOW - (opts.daysOld ?? 4.5) * DAY_MS;
  const at = (days: number) => new Date(planted + days * DAY_MS + 3600_000).toISOString();
  return {
    did,
    rkey,
    uri: `at://${did}/${SPROUT_NSID}/${rkey}`,
    cid: `bafy${rkey}`,
    handle,
    kind: opts.kind ?? 'violet',
    plot: opts.plot ?? 31,
    plantedAt: new Date(planted).toISOString(),
    care: opts.care ?? 0.71,
    helpers: 2,
    lastTended: at(3),
    thirsty: false,
    patch: opts.patch ?? autumn,
    tends: [
      { did: MO, handle: 'mo.example', action: 'sun' as const, at: at(3) },
      { did, handle, action: 'water' as const, at: at(3) },
      { did: BO, handle: 'bo.example', action: 'water' as const, at: at(2) },
      { did, handle, action: 'sun' as const, at: at(1) },
      { did, handle, action: 'water' as const, at: at(0) },
    ],
  };
}

const pressedOf = (did: string, handle: string, rkey: string, kind: string) => ({ ...flowerOf(did, handle, { rkey, kind, patch: summer, daysOld: 120, care: 1 }), tends: [] });

interface Rig {
  calls: Array<{ path: string; body: Record<string, unknown> | null }>;
  went: Prepared[];
  asked: string[];
  run: () => Promise<void>;
}

function rig(opts: { signedIn?: boolean; auth?: null; flowers?: unknown[]; gardenerDown?: boolean; path?: string } = {}): Rig {
  document.body.innerHTML = MAIN + DIALOG;
  window.history.replaceState(null, '', opts.path ?? '/garden');
  const calls: Rig['calls'] = [];
  const went: Prepared[] = [];
  const asked: string[] = [];
  let n = 0;
  const session: Session = {
    did: ME,
    pds: PDS,
    fetch: async (path, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path, body });
      return Response.json({ uri: `at://${ME}/${TEND_NSID}/3t${++n}`, cid: 'bafytend' });
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
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://atpota.to');
    if (url.pathname === '/api/gardener') {
      const did = url.searchParams.get('did')!;
      asked.push(did);
      if (opts.gardenerDown) return new Response('down', { status: 503 });
      const handle = did === ME ? 'me.test' : 'cy.example';
      return Response.json({ did, handle, flowers: opts.flowers ?? [flowerOf(did, handle), pressedOf(did, handle, '3kold1', 'daisy'), pressedOf(did, handle, '3kold2', 'tulip')] });
    }
    if (url.pathname === '/api/garden') {
      const near = (d: string, handle: string, plot: number, thirsty: boolean) => ({ ...flowerOf(d, handle, { rkey: `3k${plot}`, plot, kind: 'daisy', daysOld: 12 }), thirsty, tends: undefined, patch: undefined });
      return Response.json({
        patch: { ...autumn, cid: 'bafypatch', opensAt: '2026-09-01T00:00:00Z', closesAt: '2026-12-01T00:00:00Z' },
        patches: [],
        flowers: [near(BO, 'jo.example', 32, true), near(MO, 'sam.example', 30, false), { ...flowerOf(ME, 'me.test'), tends: undefined, patch: undefined }],
        total: 3,
      });
    }
    if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return {
    calls,
    went,
    asked,
    run: () =>
      initGardenPage({
        auth: opts.auth === null ? null : auth,
        fetchImpl,
        now: () => NOW,
        sessionStore: createStore(() => window.sessionStorage),
        localStore: createStore(() => window.localStorage),
      }),
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const text = (sel: string) => $(sel).textContent;
const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => !e.hidden);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the garden page', () => {
  it('signed out: asks to sign in, and shows how it grows', async () => {
    await rig().run();
    expect($('[data-garden-page]').dataset.state).toBe('signed-out');
    expect(text('[data-garden-title]')).toBe(COPY.signedOut.title);
    expect(document.querySelectorAll('[data-garden-how] svg.home-flower')).toHaveLength(4);
    expect($('[data-garden-how]').hidden).toBe(false);
    $('[data-garden-signin]').click();
    await flush();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    expect(text('[data-blog-signin-lede]')).toBe(COPY.tendLede);
  });

  it('elsewhere (previews) it says the garden works on atpota.to', async () => {
    await rig({ auth: null }).run();
    expect(text('[data-garden-lede]')).toBe(COPY.otherHost);
    expect(document.querySelector('[data-garden-signin]')).toBeNull();
  });

  it('your growing flower: its week, the odds, who helped, the neighbours and the herbarium', async () => {
    await rig({ signedIn: true }).run();
    const planted = NOW - 4.5 * DAY_MS;
    expect($('[data-garden-page]').dataset.state).toBe('ready');
    expect(text('[data-garden-eyebrow]')).toBe(COPY.eyebrow('autumn 2026', 32));
    expect(text('[data-garden-title]')).toBe(COPY.growing('a', 'violet', 'bud'));
    const weekday = new Date(planted + GROW_DAYS * DAY_MS).toLocaleDateString('en', { weekday: 'long' }).toLowerCase();
    expect(text('[data-garden-lede]')).toBe(COPY.growingLede(5, weekday));
    const days = [...document.querySelectorAll('.garden-week__day')].map((d) => d.className.replace('garden-week__day is-', ''));
    expect(days).toEqual(['tended', 'tended', 'missed', 'tended', 'today', 'ahead', 'ahead']);
    expect($('.garden-week__bloom').classList.contains('is-done')).toBe(false);
    expect(text('[data-garden-care]')).toBe(`${COPY.care(5)} · ${COPY.odds.twoTone} 24% · ${COPY.odds.ladybug} 6.4%`);
    expect(visible('[data-tend]').map((b) => b.dataset.tend)).toEqual(['water', 'sun', 'talk']);
    expect([...document.querySelectorAll('.garden-helpers__item')].map((li) => li.textContent)).toEqual([
      `@mo.example ${COPY.helped.sun}${COPY.yesterday}`,
      `@bo.example ${COPY.helped.water}${new Date(planted + 2 * DAY_MS + 3600_000).toLocaleDateString('en', { weekday: 'long' }).toLowerCase()}`,
    ]);
    expect(text('[data-garden-herbarium-title]')).toBe(COPY.herbarium(2));
    expect(document.querySelectorAll('.garden-herbarium__sheet')).toHaveLength(2);
    expect(document.querySelector('.garden-herbarium__name')!.textContent).toBe(describeBloom('daisy', flowerVariant(pressedOf(ME, 'me.test', '3kold1', 'daisy') as never)));
    // neighbours: a window of the patch around your plot, and the thirsty ones to water
    expect($('[data-garden-near]').hidden).toBe(false);
    expect(document.querySelectorAll('.garden-near__plot')).toHaveLength(15);
    expect(document.querySelectorAll('.garden-near__plot.is-yours')).toHaveLength(1);
    expect(document.querySelectorAll('.garden-near__plot.is-thirsty')).toHaveLength(1);
    expect(text('.garden-near__item span')).toBe(COPY.nearThirsty('jo.example', 'daisy'));
  });

  it('tending your flower: a tend record, once a day, and the odds go up', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    $('[data-tend="sun"]').click();
    await flush();
    const made = r.calls[0]!.body!;
    expect(made.collection).toBe(TEND_NSID);
    expect(made.record).toMatchObject({ $type: TEND_NSID, subject: { uri: `at://${ME}/${SPROUT_NSID}/3kmine`, cid: 'bafy3kmine' }, action: 'sun' });
    expect(text('[data-garden-status]')).toBe(COPY.tended.sun);
    expect(visible('[data-tend]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(text('[data-garden-care]')?.startsWith(COPY.care(6))).toBe(true);
    expect([...document.querySelectorAll('.garden-week__day')].map((d) => d.className.replace('garden-week__day is-', ''))[4]).toBe('tended');

    // watering a thirsty neighbour
    const water = $<HTMLButtonElement>('[data-near-water]');
    water.click();
    await flush();
    expect(r.calls[1]!.body!.record).toMatchObject({ subject: { uri: `at://${BO}/${SPROUT_NSID}/3k32` }, action: 'water' });
    expect([water.disabled, water.textContent]).toEqual([true, COPY.nearWatered]);

    // the next visit today remembers
    await rig({ signedIn: true }).run();
    expect(visible('[data-tend]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('on the day it blooms, the bud waits for you to take a look', async () => {
    const bloomed = { ...flowerOf(ME, 'me.test', { daysOld: 7.5, care: 1 }) };
    await rig({ signedIn: true, flowers: [bloomed] }).run();
    expect(text('[data-garden-title]')).toBe(COPY.waiting);
    expect($('[data-garden-tend]').hidden).toBe(true);
    $('[data-garden-reveal]').click();
    const v = flowerVariant(bloomed as never);
    expect(text('[data-garden-title]')).toBe(describeBloom('violet', v));
    expect(document.querySelector('.garden-hero__ribbon')).not.toBeNull();
    expect($('[data-garden-bed]').classList.contains('is-revealing')).toBe(true);
    expect(text('[data-garden-status]')).toBe(COPY.bloomed('violet', describeBloom('violet', v)));
    expect(document.activeElement).toBe($('[data-garden-title]'));
    expect(seenBloom(createStore(() => window.localStorage), bloomed.uri)).toBe(true);
    expect($('.garden-week__bloom').classList.contains('is-done')).toBe(true);

    // seen: straight to the bloom next time
    await rig({ signedIn: true, flowers: [bloomed] }).run();
    expect(text('[data-garden-title]')).toBe(describeBloom('violet', v));
    expect(document.querySelector('[data-garden-reveal]')).toBeNull();
  });

  it('a thirsty bloom asks for a drink', async () => {
    const f = { ...flowerOf(ME, 'me.test', { daysOld: 14 }), thirsty: true, lastTended: null };
    markSeen(createStore(() => window.localStorage), f.uri);
    await rig({ signedIn: true, flowers: [f] }).run();
    expect(text('[data-garden-title]')).toBe(COPY.thirsty('your', 'violet'));
    expect(text('[data-garden-lede]')).toBe(COPY.thirstyLede(7));
  });

  it('after the season: your flower was pressed; with nothing at all: how to start', async () => {
    await rig({ signedIn: true, flowers: [pressedOf(ME, 'me.test', '3kold1', 'daisy')] }).run();
    expect(text('[data-garden-title]')).toBe(COPY.pressedTitle('daisy'));
    expect($('[data-garden-bed]').classList.contains('is-pressed')).toBe(true);
    expect($('[data-garden-actions] a').getAttribute('href')).toBe('/#garden-plots');

    await rig({ signedIn: true, flowers: [] }).run();
    expect(text('[data-garden-title]')).toBe(COPY.empty.title);
    expect($('[data-garden-how]').hidden).toBe(false);
    expect($('[data-garden-herbarium]').hidden).toBe(true);
  });

  it('someone else’s garden: their flower, and a button to water it', async () => {
    const r = rig({ signedIn: true, path: `/garden?did=${encodeURIComponent(CY)}` });
    await r.run();
    expect(r.asked).toEqual([CY]);
    expect(document.title).toBe(COPY.title('cy.example'));
    expect(text('[data-garden-title]')).toBe(COPY.growing("@cy.example's", 'violet', 'bud'));
    expect(visible('[data-tend]').map((b) => b.dataset.tend)).toEqual(['water']);
    expect($('[data-garden-near]').hidden).toBe(true);
    expect(text('[data-garden-herbarium-title]')).toBe(COPY.herbariumTheirs('cy.example', 2));
    $('[data-tend="water"]').click();
    await flush();
    expect(r.calls[0]!.body!.record).toMatchObject({ subject: { uri: `at://${CY}/${SPROUT_NSID}/3kmine` }, action: 'water' });
    expect(text('[data-garden-status]')).toBe(COPY.visitorWatered);
  });

  it('signed out on someone’s garden: watering asks to sign in, and brings you back to theirs', async () => {
    const r = rig({ path: `/garden?did=${encodeURIComponent(CY)}` });
    await r.run();
    $('[data-tend="water"]').click();
    await flush();
    expect($<HTMLDialogElement>('dialog[data-blog-signin]').hasAttribute('open')).toBe(true);
    $<HTMLInputElement>('input[name="handle"]').value = 'me.test';
    $('form[data-blog-signin-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    $('[data-blog-signin-go]').click();
    await flush();
    expect(r.went).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY)!)).toMatchObject({ kind: 'tend', returnTo: '/garden' });
    expect(sessionStorage.getItem(VISIT_KEY)).toBe(CY);

    // back from the auth server (the blog forwards to /garden, without the ?did=)
    const back = rig({ signedIn: true });
    await back.run();
    expect(back.asked).toEqual([CY]);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(VISIT_KEY)).toBeNull();
  });

  it('says so when the garden does not load', async () => {
    await rig({ signedIn: true, gardenerDown: true }).run();
    expect($('[data-garden-page]').dataset.state).toBe('error');
    expect(text('[data-garden-lede]')).toBe(COPY.loadFailed);
  });

  it('counts care like the server: days its owner tended it while it grew, plus up to three helpers', () => {
    const f = flowerOf(ME, 'me.test');
    expect(careFrom(f)).toBe(Math.round((5 / 7) * 100) / 100);
    const late = { ...f, tends: [...f.tends, { did: ME, handle: 'me.test', action: 'water' as const, at: new Date(Date.parse(f.plantedAt) + 8 * DAY_MS).toISOString() }] };
    expect(careFrom(late)).toBe(careFrom(f));
    const crowd = { ...f, tends: ['e', 'f', 'g', 'h', 'i'].map((c) => ({ did: `did:plc:${c.repeat(24)}`, handle: 'x', action: 'water' as const, at: f.tends[0]!.at })) };
    expect(careFrom(crowd)).toBe(Math.round((3 / 7) * 100) / 100);
    expect(localStorage.getItem(SEEN_KEY)).toBeNull();
  });
});
