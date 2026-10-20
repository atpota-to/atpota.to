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
  freePlotFrom,
  GARDEN_SUBJECT,
  GRID_COLS,
  initGarden,
  KIND_KEY,
  MAX_PLOTS,
  middlePlot,
  MIN_ROWS,
  PLOT_KEY,
  rowsFor,
  SPROUT_NSID,
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
  const friendRose = { did: FRIEND, rkey: '3kfriend', handle: 'friend.test', kind: 'rose', plot: 20, plantedAt: '2026-10-10T00:00:00Z' };

  interface Rig {
    calls: Array<{ path: string; body: Record<string, unknown> | null }>;
    went: Prepared[];
    owned: string[];
    run: () => Promise<void>;
  }

  function rig(opts: { signedIn?: boolean; failCreate?: number; auth?: null; flowers?: unknown[]; rows?: number } = {}): Rig {
    document.body.innerHTML = section('home-patch') + DIALOG;
    const calls: Rig['calls'] = [];
    const went: Prepared[] = [];
    const owned: string[] = [];
    let n = 0;
    const session: Session = {
      did: ME,
      pds: PDS,
      fetch: async (path, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ path, body });
        if (path.endsWith('createRecord')) {
          if (opts.failCreate) return Response.json({ error: 'Nope' }, { status: opts.failCreate });
          const uri = `at://${ME}/${SPROUT_NSID}/3new${++n}`;
          owned.push(uri);
          return Response.json({ uri, cid: 'c' });
        }
        owned.splice(owned.indexOf(`at://${ME}/${SPROUT_NSID}/${String(body!.rkey)}`), 1);
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
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://atpota.to');
      if (url.pathname === '/api/garden') return Response.json({ flowers, total: flowers.length, cols: GRID_COLS, rows: opts.rows ?? MIN_ROWS });
      if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
      if (url.origin === PDS) return Response.json({ records: owned.map((uri) => ({ uri, value: { subject: GARDEN_SUBJECT } })) });
      return new Response('unexpected', { status: 599 });
    }) as typeof fetch;
    return {
      calls,
      went,
      owned,
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

  it('lays out the plots, with everyone in the plot they picked', async () => {
    await rig().run();
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(MIN_ROWS * GRID_COLS);
    expect(document.querySelector('[data-garden-count]')!.textContent).toBe(COPY.count(1, MIN_ROWS * GRID_COLS));
    const rose = plot(20);
    expect(rose.classList.contains('home-plot--planted')).toBe(true);
    expect(rose.querySelector('svg.home-flower')).not.toBeNull();
    expect(rose.querySelector('.home-plot__tag')!.textContent).toBe('@friend.test');
    expect(rose.getAttribute('aria-label')).toBe(COPY.flowerPlot("@friend.test's", 'rose', 'bloom'));
    // the same flower looks the same every time
    const first = rose.querySelector('svg')!.outerHTML;
    await rig().run();
    expect(plot(20).querySelector('svg')!.outerHTML).toBe(first);
    // the kinds picker shows each flower
    expect(document.querySelectorAll('[data-garden-kinds] [data-kind] svg.home-flower')).toHaveLength(6);
  });

  it('grows the grid as it fills, always leaving a free plot', async () => {
    const full = Array.from({ length: 60 }, (_, i) => ({ ...friendRose, did: `did:plc:${String(i).padStart(24, 'c')}`, plot: i }));
    await rig({ flowers: full, rows: 5 }).run();
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(6 * GRID_COLS);
    expect(rowsFor(full)).toBe(6);
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
    expect(Number(picked.dataset.plot)).toBe(middlePlot(new Set([20]), MIN_ROWS, () => 0));
  });

  it('arrow keys move between the plots', async () => {
    await rig().run();
    plot(0).focus();
    plot(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(plot(1));
    plot(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(plot(1 + GRID_COLS));
    expect(plot(1 + GRID_COLS).tabIndex).toBe(0);
    expect(plot(0).tabIndex).toBe(-1);
    // from whichever plot has focus
    plot(30).focus();
    plot(30).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(plot(29));
    expect(document.querySelectorAll('[data-plot][tabindex="0"]')).toHaveLength(1);
  });

  it('signed in: plants the picked flower in your repo in the picked plot, moving an old one', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    r.owned.push(`at://${ME}/${SPROUT_NSID}/3old`);
    document.querySelector<HTMLButtonElement>('[data-kind="violet"]')!.click();
    plot(7).click();
    plantButton().click();
    await flush();
    expect(r.calls.map((c) => c.path.split('.').pop())).toEqual(['deleteRecord', 'createRecord']);
    const created = r.calls[1]!.body!;
    expect(created.collection).toBe(SPROUT_NSID);
    expect(created.record).toMatchObject({ $type: SPROUT_NSID, subject: GARDEN_SUBJECT, kind: 'violet', plot: 7 });
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
    expect(r.owned).toEqual([]);
    expect(document.querySelector('.is-yours')).toBeNull();
    expect(plot(7).classList.contains('home-plot--empty')).toBe(true);
    expect(statusText()).toBe(COPY.dug);
  });

  it('a plot taken while the page was open goes to the next free one', () => {
    expect(freePlotFrom(20, new Set([20, 21]))).toBe(22);
    expect(freePlotFrom(4, new Set([20]))).toBe(4);
    expect(freePlotFrom(MAX_PLOTS - 1, new Set([MAX_PLOTS - 1]))).toBe(0);
    expect(middlePlot(new Set(Array.from({ length: 60 }, (_, i) => i)), 5)).toBeNull();
    // six across on narrow screens: the middle of that shape
    expect(middlePlot(new Set(), 5, () => 0, 6)).toBe(4 * 6 + 2);
    expect(middlePlot(new Set(), 5, () => 0)).toBe(2 * 12 + 5);
  });

  it('signed out: asks to sign in, then plants in the same plot once back', async () => {
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

    // back on the home page, signed in
    const back = rig({ signedIn: true });
    await back.run();
    expect(back.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ kind: 'tulip', plot: 9 });
    expect(plot(9).classList.contains('is-yours')).toBe(true);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(KIND_KEY)).toBeNull();
    expect(sessionStorage.getItem(PLOT_KEY)).toBeNull();
  });

  it('back from signing in without a stored plot, it plants near the middle', async () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ kind: 'plant', returnTo: '/', at: NOW }));
    const back = rig({ signedIn: true });
    await back.run();
    const want = middlePlot(new Set([20]), MIN_ROWS, () => 0);
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
    // still plantable: the empty grid is there
    expect(document.querySelectorAll('[data-plot]')).toHaveLength(MIN_ROWS * GRID_COLS);
  });
});
