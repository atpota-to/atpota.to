// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth, Prepared, Session } from '../src/blog/auth.js';
import { PENDING_KEY } from '../src/blog/state.js';
import { createStore } from '../src/poe/storage.js';
import { burst, cheer } from '../src/scripts/burst.js';
import {
  COPY,
  describeBloom,
  flowerVariant,
  freePlotFrom,
  initGarden,
  KIND_KEY,
  middlePlot,
  narrowCols,
  PATCH_KEY,
  patchUri,
  PLOT_KEY,
  SPROUT_NSID,
  TEND_KEY,
  TEND_NSID,
  tend,
} from '../src/scripts/garden.js';
import { initLatest, LOADING_LINES } from '../src/scripts/home.js';
import { MASCOT_URLS } from '../src/scripts/mascot.js';
import { greeting, initPet, milestoneLine, PETS_KEY, petReaction } from '../src/scripts/pet.js';
import { forgetReader, readReader, READER_KEY, rememberReader } from '../src/scripts/reader.js';
import { initTagline, TAGLINES } from '../src/scripts/tagline.js';
import { CONDITION_TEXT, ERROR_TEXT, fetchReading, renderReading, renderWeatherError } from '../src/scripts/weather.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const INDEX = read('../index.html');
const section = (cls: string) => {
  const start = INDEX.indexOf(`<section class="tile ${cls}"`);
  return INDEX.slice(start, INDEX.indexOf('</section>', start) + '</section>'.length);
};
const DIALOG = (() => {
  const partial = read('../src/partials/signin.html');
  return partial.slice(partial.indexOf('<dialog'), partial.indexOf('</dialog>') + '</dialog>'.length);
})();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('little details', () => {
  it('the footer tagline is one of the list, picked per page load', () => {
    document.body.innerHTML = '<span data-tagline>grown in the atmosphere</span>';
    initTagline(document, () => 0.5);
    expect(document.querySelector('[data-tagline]')!.textContent).toBe(TAGLINES[6]);
    expect(TAGLINES).toContain('grown in the atmosphere');
    for (const line of TAGLINES) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('the latest feed loads with a pun', () => {
    document.body.innerHTML = section('home-latest');
    vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => undefined));
    initLatest(document, (() => new Promise(() => undefined)) as typeof fetch, () => 0.99);
    expect(document.querySelector('[data-latest-loading]')!.textContent).toBe(LOADING_LINES[LOADING_LINES.length - 1]);
  });

  it('robots.txt welcomes crawlers and keeps them out of the api', () => {
    const robots = read('../public/robots.txt');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
  });
});

describe('poe remembers you', () => {
  const HERO = () => `
    <div class="home-sun" data-mascot-trigger>
      <img data-mascot="kawaii" data-pet src="${MASCOT_URLS.kawaii}" alt="poe">
      <p class="home-sun__bubble"><span class="only-hover">psst, hover me (◕‿◕)</span><span class="only-touch">psst, tap me (◕‿◕)</span><span data-pet-say></span></p>
    </div>`;

  it('keeps the blog reader handle until they sign out, and ignores junk', () => {
    rememberReader('me.test');
    expect(readReader()).toBe('me.test');
    localStorage.setItem(READER_KEY, '<script>');
    expect(readReader()).toBeNull();
    rememberReader('me.test');
    forgetReader();
    expect(readReader()).toBeNull();
  });

  it('says hi by handle in the bubble, when it fits', () => {
    expect(greeting(null, false)).toBeNull();
    expect(greeting('me.test', false)).toBe('hi @me.test! hover me (◕‿◕)');
    expect(greeting('me.test', true)).toBe('hi @me.test! tap me (◕‿◕)');
    expect(greeting('a-very-long-handle.example.com', false)).toBe('hi again! hover me (◕‿◕)');
    rememberReader('me.test');
    document.body.innerHTML = HERO();
    initPet();
    expect(document.querySelector('.only-hover')!.textContent).toBe('hi @me.test! hover me (◕‿◕)');
  });

  it('adds pets up across visits and celebrates some totals', () => {
    expect(milestoneLine(24)).toBeNull();
    expect(milestoneLine(50)).toContain('family');
    expect(milestoneLine(1000)).toBe('1000 pets. legend.');
    expect(petReaction(10, true).say).toBe('still best friends (◕‿◕)');
    expect(petReaction(10, false).say).toBe("ok ok, we're friends now");

    vi.useFakeTimers();
    localStorage.setItem(PETS_KEY, '48');
    document.body.innerHTML = HERO();
    initPet();
    const img = document.querySelector<HTMLImageElement>('img[data-pet]')!;
    img.click();
    img.click();
    expect(localStorage.getItem(PETS_KEY)).toBe('50');
    expect(document.querySelector('[data-pet-say]')!.textContent).toBe("50 pets. we're basically family");
  });
});

describe('celebrations', () => {
  it('bursts bits out of an element, then cleans them up, and asks poe to cheer', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="b">subscribe</button>';
    burst(document.getElementById('b')!, 'leaves');
    expect(document.querySelectorAll('.burst--leaves').length).toBeGreaterThan(5);
    vi.advanceTimersByTime(1000);
    expect(document.querySelectorAll('.burst').length).toBe(0);
    const heard = vi.fn();
    window.addEventListener('poe:cheer', heard);
    cheer();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('never throws, whatever the window', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    expect(() => burst(document.getElementById('b')!, 'hearts', {} as Window)).not.toThrow();
    expect(() => cheer({} as Window)).not.toThrow();
  });
});

describe('atmospheric conditions', () => {
  const READING = { perSecond: { posts: 31.4, likes: 170.2, reposts: 22, follows: 14.6 }, condition: 'gusty' as const };

  it('shows the reading and the weather', () => {
    document.body.innerHTML = section('home-weather');
    const tile = document.querySelector<HTMLElement>('[data-weather]')!;
    renderReading(tile, READING);
    expect(tile.dataset.state).toBe('ready');
    expect(tile.querySelector('[data-weather-posts]')!.textContent).toBe('31');
    expect(tile.querySelector('[data-weather-likes]')!.textContent).toBe('170');
    expect(tile.querySelector('[data-weather-follows]')!.textContent).toBe('15');
    expect(tile.querySelector('[data-weather-cond]')!.textContent).toBe(CONDITION_TEXT.gusty);
    // a failed refresh keeps the last reading
    renderWeatherError(tile);
    expect(tile.dataset.state).toBe('ready');
  });

  it('says so when the sky is hard to read', () => {
    document.body.innerHTML = section('home-weather');
    const tile = document.querySelector<HTMLElement>('[data-weather]')!;
    renderWeatherError(tile);
    expect(tile.dataset.state).toBe('error');
    expect(tile.querySelector('[data-weather-cond]')!.textContent).toBe(ERROR_TEXT);
  });

  it('only accepts well-formed readings', async () => {
    const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;
    expect(await fetchReading(answer(READING))).toEqual(READING);
    expect(await fetchReading(answer({ ...READING, condition: 'hail' }))).toBeNull();
    expect(await fetchReading(answer({ perSecond: { posts: -1 } }))).toBeNull();
    expect(await fetchReading(answer({ error: 'unavailable' }, 503))).toBeNull();
  });
});

describe('the flower patch', () => {
  const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const FRIEND = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
  const PDS = 'https://pds.me.test';
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const COLS = 12;
  const ROWS = 5;
  const PLOTS = COLS * ROWS;
  const autumn = {
    rkey: '2026-autumn',
    uri: patchUri('2026-autumn'),
    cid: 'bafypatchautumn',
    name: 'autumn 2026',
    season: 'autumn',
    cols: COLS,
    rows: ROWS,
    opensAt: '2026-09-01T00:00:00.000Z',
    closesAt: '2026-12-01T00:00:00.000Z',
    open: true,
  };
  const summer = { ...autumn, rkey: '2026-summer', uri: patchUri('2026-summer'), name: 'summer 2026', season: 'summer', opensAt: '2026-06-01T00:00:00.000Z', closesAt: '2026-09-01T00:00:00.000Z', open: false };
  const winter = { ...autumn, rkey: '2026-winter', uri: patchUri('2026-winter'), name: 'winter 2026', season: 'winter', opensAt: '2026-12-01T00:00:00.000Z', closesAt: '2027-03-01T00:00:00.000Z', open: false };
  const summary = (p: typeof autumn, planted: number) => ({ rkey: p.rkey, name: p.name, season: p.season, open: p.open, planted, plots: p.cols * p.rows, opensAt: p.opensAt, closesAt: p.closesAt });
  const friendRose = {
    did: FRIEND,
    rkey: '3kfriend',
    uri: `at://${FRIEND}/${SPROUT_NSID}/3kfriend`,
    cid: 'bafyfriend',
    handle: 'friend.test',
    kind: 'rose',
    plot: 20,
    plantedAt: '2026-10-10T00:00:00Z',
    care: 0.57,
    helpers: 1,
    lastTended: '2026-10-19T00:00:00Z',
    thirsty: false,
  };

  interface Rig {
    calls: Array<{ path: string; body: Record<string, unknown> | null }>;
    went: Prepared[];
    /** The reader's sprout records, by URI, with the patch each points at. */
    owned: Map<string, string>;
    asked: string[];
    run: () => Promise<unknown>;
  }

  function rig(opts: { signedIn?: boolean; failCreate?: number; auth?: null; flowers?: unknown[]; patch?: typeof autumn | null; summerFlowers?: unknown[] } = {}): Rig {
    document.body.innerHTML = section('home-patch') + DIALOG;
    const calls: Rig['calls'] = [];
    const went: Prepared[] = [];
    const owned = new Map<string, string>();
    const asked: string[] = [];
    let n = 0;
    const session: Session = {
      did: ME,
      pds: PDS,
      fetch: async (path, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ path, body });
        if (path.endsWith('createRecord')) {
          if (opts.failCreate) return Response.json({ error: 'Nope' }, { status: opts.failCreate });
          const uri = `at://${ME}/${String(body!.collection)}/3new${++n}`;
          if (body!.collection === SPROUT_NSID) owned.set(uri, ((body!.record as { patch: { uri: string } }).patch.uri));
          return Response.json({ uri, cid: 'bafynew' });
        }
        owned.delete(`at://${ME}/${SPROUT_NSID}/${String(body!.rkey)}`);
        return new Response(null, { status: 200 });
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
    const flowers = opts.flowers ?? [friendRose];
    const patch = opts.patch === undefined ? autumn : opts.patch;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://atpota.to');
      if (url.pathname === '/api/garden') {
        asked.push(url.search);
        const pressed = url.searchParams.get('patch') === summer.rkey;
        const shown = pressed ? opts.summerFlowers ?? [] : flowers;
        return Response.json({
          patch: pressed ? summer : patch,
          patches: patch ? [summary(summer, 4), summary(autumn, flowers.length), summary(winter, 0)] : [],
          flowers: shown,
          total: shown.length,
        });
      }
      if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
      if (url.origin === PDS) return Response.json({ records: [...owned].map(([uri, p]) => ({ uri, value: { patch: { uri: p, cid: 'bafy' } } })) });
      return new Response('unexpected', { status: 599 });
    }) as typeof fetch;
    return {
      calls,
      went,
      owned,
      asked,
      run: () =>
        initGarden({
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
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const plot = (i: number) => document.querySelector<HTMLButtonElement>(`[data-plot="${i}"]`)!;
  const plantButton = () => document.querySelector<HTMLButtonElement>('[data-garden-plant]')!;
  const statusText = () => document.querySelector('[data-garden-status]')!.textContent;

  it('lays out the patch’s plots, with everyone in the plot they picked', async () => {
    await rig().run();
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(PLOTS);
    expect(document.querySelector<HTMLElement>('[data-garden-plots]')!.style.getPropertyValue('--plot-cols')).toBe('12');
    expect(document.querySelector<HTMLElement>('[data-garden-plots]')!.style.getPropertyValue('--plot-cols-narrow')).toBe('6');
    expect(document.querySelector('[data-garden-count]')!.textContent).toBe(COPY.count(1, PLOTS));
    const rose = plot(20);
    expect(rose.classList.contains('home-plot--planted')).toBe(true);
    expect(rose.querySelector('svg.home-flower')).not.toBeNull();
    expect(rose.querySelector('.home-plot__tag')!.textContent).toBe('@friend.test');
    expect(rose.getAttribute('aria-label')).toBe(COPY.flowerPlot("@friend.test's", 'rose', 'bloom'));
    // the same flower looks the same every time
    const first = rose.querySelector('svg')!.outerHTML;
    await rig().run();
    expect(plot(20).querySelector('svg')!.outerHTML).toBe(first);
    // ...and its care shows: the same flower untended looks plainer
    await rig({ flowers: [{ ...friendRose, care: 0 }] }).run();
    expect(plot(20).querySelector('svg')!.outerHTML).not.toBe(first);
    // the kinds picker shows each flower
    expect(document.querySelectorAll('[data-garden-kinds] [data-kind] svg.home-flower')).toHaveLength(6);
  });

  it('a patch can be any size, and a wide one wraps in half on a narrow screen', async () => {
    await rig({ patch: { ...autumn, cols: 8, rows: 3 }, flowers: [{ ...friendRose, plot: 5 }, { ...friendRose, did: ME, plot: 30 }] }).run();
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(24);
    // a flower off this patch's grid isn't shown
    expect(document.querySelectorAll('.home-plot--planted')).toHaveLength(1);
    expect([narrowCols(12), narrowCols(8), narrowCols(10), narrowCols(9)]).toEqual([6, 8, 5, 9]);
  });

  it('a thirsty bloom says so', async () => {
    await rig({ flowers: [{ ...friendRose, thirsty: true }] }).run();
    expect(plot(20).classList.contains('is-thirsty')).toBe(true);
    expect(plot(20).getAttribute('aria-label')).toBe(COPY.flowerPlot("@friend.test's", 'rose', 'bloom', true));
  });

  it('a closed patch shows its pressed flowers, all in bloom, and turns planting off', async () => {
    await rig({ patch: summer, flowers: [{ ...friendRose, plantedAt: '2026-08-31T00:00:00Z' }] }).run();
    expect(plot(20).getAttribute('aria-label')).toBe(COPY.flowerPlot("@friend.test's", 'rose', 'bloom'));
    expect(plantButton().disabled).toBe(true);
    expect(statusText()).toBe(COPY.closed('summer 2026'));
    plot(3).click();
    expect(document.querySelector('.is-picked')).toBeNull();
  });

  it('a full patch turns planting off, and so does one that hasn’t opened', async () => {
    const full = Array.from({ length: PLOTS }, (_, i) => ({ ...friendRose, did: `did:plc:${String(i).padStart(24, 'c')}`, rkey: `r${i}`, uri: `at://did:plc:${String(i).padStart(24, 'c')}/${SPROUT_NSID}/r${i}`, plot: i }));
    await rig({ flowers: full }).run();
    expect(plantButton().disabled).toBe(true);
    plantButton().click();
    await rig({ patch: { ...autumn, name: 'winter 2026', opensAt: '2026-12-01T00:00:00Z', closesAt: '2027-03-01T00:00:00Z', open: false }, flowers: [] }).run();
    expect(plantButton().disabled).toBe(true);
    expect(statusText()).toBe(COPY.notYet('winter 2026'));
    await rig({ patch: null, flowers: [] }).run();
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(0);
    expect(statusText()).toBe(COPY.noPatch);
  });

  it('picking: tap an empty plot, tap it again to unpick, or let it pick one near the middle', async () => {
    await rig().run();
    expect(plantButton().textContent).toBe(COPY.pick);
    document.querySelector<HTMLButtonElement>('[data-kind="violet"]')!.click();
    plot(3).click();
    expect(plot(3).classList.contains('is-picked')).toBe(true);
    expect(plot(3).getAttribute('aria-pressed')).toBe('true');
    expect(plot(3).querySelector('.home-flower--ghost')).not.toBeNull();
    expect(plantButton().textContent).toBe(COPY.plantHere('violet'));
    expect(statusText()).toBe(COPY.choose('violet'));
    plot(3).click();
    expect(plot(3).classList.contains('is-picked')).toBe(false);
    expect(plantButton().textContent).toBe(COPY.pick);
    // a planted plot can't be picked
    plot(20).click();
    expect(document.querySelector('.is-picked')).toBeNull();
    // "pick a plot" picks a free one near the middle
    plantButton().click();
    await flush();
    const picked = document.querySelector<HTMLElement>('.is-picked')!;
    expect(Number(picked.dataset.plot)).toBe(middlePlot(new Set([20]), PLOTS, COLS, () => 0));
  });

  it('arrow keys move between the plots', async () => {
    await rig().run();
    plot(0).focus();
    plot(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(plot(1));
    plot(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(plot(1 + COLS));
    expect(plot(1 + COLS).tabIndex).toBe(0);
    expect(plot(0).tabIndex).toBe(-1);
    // from whichever plot has focus
    plot(30).focus();
    plot(30).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(plot(29));
    expect(document.querySelectorAll('[data-plot][tabindex="0"]')).toHaveLength(1);
  });

  it('signed in: plants in your repo, pointing at the patch, and moves your open flower but not your pressed ones', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    r.owned.set(`at://${ME}/${SPROUT_NSID}/3old`, autumn.uri);
    r.owned.set(`at://${ME}/${SPROUT_NSID}/3pressed`, summer.uri);
    document.querySelector<HTMLButtonElement>('[data-kind="violet"]')!.click();
    plot(7).click();
    plantButton().click();
    await flush();
    // the new flower first, then the old one goes
    expect(r.calls.map((c) => c.path.split('.').pop())).toEqual(['createRecord', 'deleteRecord']);
    const created = r.calls[0]!.body!;
    expect(created.collection).toBe(SPROUT_NSID);
    expect(created.record).toMatchObject({ $type: SPROUT_NSID, patch: { uri: autumn.uri, cid: autumn.cid }, kind: 'violet', plot: 7 });
    expect(r.calls[1]!.body).toMatchObject({ rkey: '3old' });
    expect([...r.owned.keys()].sort()).toEqual([`at://${ME}/${SPROUT_NSID}/3new1`, `at://${ME}/${SPROUT_NSID}/3pressed`]);
    const mine = plot(7);
    expect(mine.classList.contains('is-yours')).toBe(true);
    expect(mine.classList.contains('is-new')).toBe(true);
    expect(mine.querySelector('.home-plot__tag')!.textContent).toBe(COPY.you);
    expect(mine.getAttribute('aria-label')).toBe(COPY.flowerPlot('your', 'violet', 'sprout'));
    expect(statusText()).toBe(COPY.moved('violet'));
    expect(plantButton().textContent).toBe(COPY.pick);
    expect(document.querySelector<HTMLElement>('[data-garden-dig]')!.hidden).toBe(false);
    expect(readReader()).toBe('me.test');

    document.querySelector<HTMLButtonElement>('[data-garden-dig]')!.click();
    await flush();
    expect([...r.owned.keys()]).toEqual([`at://${ME}/${SPROUT_NSID}/3pressed`]);
    expect(document.querySelector('.is-yours')).toBeNull();
    expect(plot(7).classList.contains('home-plot--empty')).toBe(true);
    expect(statusText()).toBe(COPY.dug);
  });

  it('a plot taken while the page was open goes to the next free one', () => {
    expect(freePlotFrom(20, new Set([20, 21]), PLOTS)).toBe(22);
    expect(freePlotFrom(4, new Set([20]), PLOTS)).toBe(4);
    expect(freePlotFrom(PLOTS - 1, new Set([PLOTS - 1]), PLOTS)).toBe(0);
    expect(freePlotFrom(3, new Set([0, 1, 2, 3]), 4)).toBeNull();
    expect(middlePlot(new Set(Array.from({ length: PLOTS }, (_, i) => i)), PLOTS, COLS)).toBeNull();
    // six across on narrow screens: the middle of that shape
    expect(middlePlot(new Set(), PLOTS, 6, () => 0)).toBe(4 * 6 + 2);
    expect(middlePlot(new Set(), PLOTS, COLS, () => 0)).toBe(2 * 12 + 5);
  });

  it('signed out: asks to sign in, then plants in the same plot of the same patch once back', async () => {
    const r = rig();
    await r.run();
    document.querySelector<HTMLButtonElement>('[data-kind="tulip"]')!.click();
    plot(9).click();
    plantButton().click();
    await flush();
    expect(document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!.hasAttribute('open')).toBe(true);
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(COPY.lede);
    const input = document.querySelector<HTMLInputElement>('input[name="handle"]')!;
    input.value = 'me.test';
    document.querySelector('form[data-blog-signin-form]')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    document.querySelector<HTMLButtonElement>('[data-blog-signin-go]')!.click();
    await flush();
    expect(r.went).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY)!)).toMatchObject({ kind: 'plant', returnTo: '/' });
    expect(sessionStorage.getItem(KIND_KEY)).toBe('tulip');
    expect(sessionStorage.getItem(PLOT_KEY)).toBe('9');
    expect(sessionStorage.getItem(PATCH_KEY)).toBe('2026-autumn');

    // back on the home page, signed in
    const back = rig({ signedIn: true });
    await back.run();
    expect(back.asked).toEqual(['?patch=2026-autumn']);
    expect(back.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ kind: 'tulip', plot: 9, patch: { uri: autumn.uri } });
    expect(plot(9).classList.contains('is-yours')).toBe(true);
    for (const key of [PENDING_KEY, KIND_KEY, PLOT_KEY, PATCH_KEY]) expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('back from signing in without a stored plot, it plants near the middle', async () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ kind: 'plant', returnTo: '/', at: NOW }));
    const back = rig({ signedIn: true });
    await back.run();
    expect(back.asked).toEqual(['']);
    const want = middlePlot(new Set([20]), PLOTS, COLS, () => 0);
    expect(back.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ kind: 'sunflower', plot: want });
  });

  it('an older sign-in without flower permission is asked to sign in again', async () => {
    const r = rig({ signedIn: true, failCreate: 403 });
    await r.run();
    plot(0).click();
    plantButton().click();
    await flush();
    expect(document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!.hasAttribute('open')).toBe(true);
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(COPY.consent);
  });

  it('tending writes a tend record pointing at the flower', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const session = {
      did: ME,
      pds: PDS,
      fetch: async (_path: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init!.body)));
        return Response.json({ uri: `at://${ME}/${TEND_NSID}/3t`, cid: 'bafytend' });
      },
      signOut: async () => undefined,
    } as Session;
    expect(await tend(session, { uri: friendRose.uri, cid: friendRose.cid }, 'water', new Date(NOW))).toEqual({ uri: `at://${ME}/${TEND_NSID}/3t`, cid: 'bafytend' });
    expect(calls).toEqual([{ repo: ME, collection: TEND_NSID, record: { $type: TEND_NSID, subject: { uri: friendRose.uri, cid: friendRose.cid }, action: 'water', createdAt: new Date(NOW).toISOString() } }]);
  });

  it('season tabs: the recent patches, the next to open, and a closed one pressed', async () => {
    const r = rig({ summerFlowers: [{ ...friendRose, plantedAt: '2026-08-01T00:00:00Z' }] });
    await r.run();
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-garden-tabs] [role="tab"]')];
    expect(document.querySelector<HTMLElement>('[data-garden-tabs]')!.hidden).toBe(false);
    expect(tabs().map((t) => t.textContent)).toEqual([`summer 2026${COPY.tabs.closed}`, `autumn 2026${COPY.tabs.open}`, `winter 2026${COPY.tabs.soon('dec 1')}`]);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs()[2]!.disabled).toBe(true);
    expect(tabs()[1]!.getAttribute('aria-controls')).toBe('garden-plots');

    tabs()[0]!.click();
    await flush();
    expect(r.asked.at(-1)).toBe('?patch=2026-summer');
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(document.querySelector('[data-garden-plots]')!.hasAttribute('data-pressed')).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-garden-kinds]')!.hidden).toBe(true);
    expect(plantButton().hidden).toBe(true);
    expect(statusText()).toBe(COPY.closed('summer 2026'));

    // arrows move along the tabs that can be opened; Enter (a click) shows that patch
    tabs()[0]!.focus();
    tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs()[1]);
    tabs()[1]!.click();
    await flush();
    expect(r.asked.at(-1)).toBe('?patch=2026-autumn');
    expect(document.querySelector('[data-garden-plots]')!.hasAttribute('data-pressed')).toBe(false);
    expect(plantButton().hidden).toBe(false);
  });

  it('tapping a flower opens its card; yours links to your garden', async () => {
    rememberReader('me.test');
    const mine = { ...friendRose, did: ME, rkey: '3kmine', uri: `at://${ME}/${SPROUT_NSID}/3kmine`, handle: 'me.test', kind: 'violet', plot: 7 };
    await rig({ flowers: [friendRose, mine] }).run();
    const card = () => document.querySelector<HTMLElement>('[data-garden-card]')!;
    expect(card().hidden).toBe(true);

    plot(20).click();
    expect(card().hidden).toBe(false);
    expect(document.activeElement).toBe(card());
    expect(card().querySelector('#garden-card-title')!.textContent).toBe(COPY.theirs('friend.test', 'rose'));
    expect(card().querySelector('.home-card__meta')!.textContent).toBe(COPY.inBloom(describeBloom('rose', flowerVariant(friendRose as never)), true));
    expect(card().querySelector('[data-garden-water]')!.textContent).toBe(COPY.water);
    expect(card().querySelector('a')!.getAttribute('href')).toBe('/garden/friend.test');
    card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card().hidden).toBe(true);
    expect(document.activeElement).toBe(plot(20));

    plot(7).click();
    expect(card().querySelector('#garden-card-title')!.textContent).toBe(COPY.yours('violet'));
    expect(card().querySelector('[data-garden-water]')).toBeNull();
    expect(card().querySelector('a')!.getAttribute('href')).toBe('/garden/me.test/flowers');
    expect(document.querySelector<HTMLElement>('[data-garden-mine]')!.hidden).toBe(false);
    expect(document.querySelector('[data-garden-mine]')!.getAttribute('href')).toBe('/garden/me.test/flowers');

    // an empty plot closes it, and so does the close button
    plot(3).click();
    expect(card().hidden).toBe(true);
    plot(20).click();
    card().querySelector<HTMLButtonElement>('[data-garden-card-close]')!.click();
    expect(card().hidden).toBe(true);
  });

  it('watering a neighbour’s flower writes a tend record, once a day', async () => {
    const r = rig({ signedIn: true, flowers: [{ ...friendRose, thirsty: true, lastTended: null }] });
    await r.run();
    plot(20).click();
    const card = () => document.querySelector<HTMLElement>('[data-garden-card]')!;
    expect(card().querySelector('.home-card__note')!.textContent).toBe(COPY.thirstyFor(3));
    card().querySelector<HTMLButtonElement>('[data-garden-water]')!.click();
    await flush();
    const made = r.calls.find((c) => c.path.endsWith('createRecord'))!.body!;
    expect(made.collection).toBe(TEND_NSID);
    expect(made.record).toMatchObject({ $type: TEND_NSID, subject: { uri: friendRose.uri, cid: friendRose.cid }, action: 'water' });
    expect(card().querySelector('[data-garden-card-status]')!.textContent).toBe(COPY.watered(COPY.theirs('friend.test', 'rose')));
    expect(card().querySelector('.home-card__note')).toBeNull();
    expect(plot(20).classList.contains('is-thirsty')).toBe(false);
    const water = card().querySelector<HTMLButtonElement>('[data-garden-water]')!;
    expect([water.disabled, water.textContent]).toEqual([true, COPY.wateredToday]);
    expect(sessionStorage.getItem(TEND_KEY)).toBeNull();

    // still resting on the next visit today
    await rig({ signedIn: true }).run();
    plot(20).click();
    expect(document.querySelector<HTMLButtonElement>('[data-garden-water]')!.disabled).toBe(true);
  });

  it('signed out: watering asks to sign in, then waters once back', async () => {
    const r = rig();
    await r.run();
    plot(20).click();
    document.querySelector<HTMLButtonElement>('[data-garden-water]')!.click();
    await flush();
    expect(document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!.hasAttribute('open')).toBe(true);
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(COPY.tendLede);
    document.querySelector<HTMLInputElement>('input[name="handle"]')!.value = 'me.test';
    document.querySelector('form[data-blog-signin-form]')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    document.querySelector<HTMLButtonElement>('[data-blog-signin-go]')!.click();
    await flush();
    expect(r.went).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY)!)).toMatchObject({ kind: 'tend', returnTo: '/' });
    expect(JSON.parse(sessionStorage.getItem(TEND_KEY)!)).toMatchObject({ uri: friendRose.uri, patch: '2026-autumn' });

    const back = rig({ signedIn: true });
    await back.run();
    expect(back.asked[0]).toBe('?patch=2026-autumn');
    expect(back.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ subject: { uri: friendRose.uri } });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(TEND_KEY)).toBeNull();
    expect(back.calls.some((c) => (c.body?.collection as string) === SPROUT_NSID)).toBe(false);
  });

  it('a pressed flower’s card says so, and has nothing to water', async () => {
    await rig({ patch: summer, flowers: [{ ...friendRose, plantedAt: '2026-08-31T00:00:00Z' }] }).run();
    plot(20).click();
    expect(document.querySelector('.home-card__meta')!.textContent).toBe(COPY.inBloom(describeBloom('rose', flowerVariant(friendRose as never)), false));
    expect(document.querySelector('[data-garden-water]')).toBeNull();
  });

  it('elsewhere (previews) it says planting works on atpota.to', async () => {
    const r = rig({ auth: null });
    await r.run();
    plot(0).click();
    plantButton().click();
    await flush();
    expect(statusText()).toBe(COPY.otherHost);
  });

  it('says so when the patch does not load', async () => {
    document.body.innerHTML = section('home-patch') + DIALOG;
    await initGarden({ auth: null, fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch });
    expect(document.querySelector<HTMLElement>('[data-garden]')!.dataset.state).toBe('error');
    expect(statusText()).toBe(COPY.loadFailed);
    expect(plantButton().disabled).toBe(true);
  });
});
