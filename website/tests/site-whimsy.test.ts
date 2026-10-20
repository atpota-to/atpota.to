// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth, Prepared, Session } from '../src/blog/auth.js';
import { PENDING_KEY } from '../src/blog/state.js';
import { createStore } from '../src/poe/storage.js';
import { burst, cheer } from '../src/scripts/burst.js';
import { COPY, flowerSpot, initGarden, KIND_KEY, SPROUT_NSID, GARDEN_SUBJECT } from '../src/scripts/garden.js';
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
  const PDS = 'https://pds.me.test';

  interface Rig {
    calls: Array<{ path: string; body: Record<string, unknown> | null }>;
    went: Prepared[];
    owned: string[];
    store: ReturnType<typeof createStore>;
    run: () => Promise<void>;
  }

  function rig(opts: { signedIn?: boolean; failCreate?: number; auth?: null; flowers?: unknown[] } = {}): Rig {
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
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://atpota.to');
      if (url.pathname === '/api/garden') return Response.json({ flowers: opts.flowers ?? [{ did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: 'friend.test', kind: 'rose', plantedAt: '2026-10-19T00:00:00Z' }], total: 1 });
      if (url.origin === 'https://public.api.bsky.app') return Response.json({ did: ME, handle: 'me.test', displayName: 'Me' });
      if (url.origin === PDS) return Response.json({ records: owned.map((uri) => ({ uri, value: { subject: GARDEN_SUBJECT } })) });
      return new Response('unexpected', { status: 599 });
    }) as typeof fetch;
    const store = createStore(() => window.sessionStorage);
    return {
      calls,
      went,
      owned,
      store,
      run: () => initGarden({ auth: opts.auth === null ? null : auth, fetchImpl, sessionStore: store, localStore: createStore(() => window.localStorage) }),
    };
  }

  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('grows everyone in the same spot each time', async () => {
    const r = rig();
    await r.run();
    const flowers = document.querySelectorAll('.home-flower');
    expect(flowers).toHaveLength(1);
    expect(flowers[0]!.classList.contains('home-flower--rose')).toBe(true);
    expect(flowers[0]!.querySelector('.home-flower__tag')!.textContent).toBe('@friend.test');
    expect(document.querySelector('[data-garden-count]')!.textContent).toBe('1 flower');
    expect(flowerSpot('did:plc:x')).toEqual(flowerSpot('did:plc:x'));
    const spot = flowerSpot('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(spot.x).toBeGreaterThanOrEqual(4);
    expect(spot.x).toBeLessThanOrEqual(96);
  });

  it('signed in: plants the picked flower in your repo, swapping an old one', async () => {
    const r = rig({ signedIn: true });
    await r.run();
    r.owned.push(`at://${ME}/${SPROUT_NSID}/3old`);
    document.querySelector<HTMLButtonElement>('[data-kind="violet"]')!.click();
    expect(document.querySelector('[data-garden-plant]')!.textContent).toBe('plant a violet');
    document.querySelector<HTMLButtonElement>('[data-garden-plant]')!.click();
    await flush();
    expect(r.calls.map((c) => c.path.split('.').pop())).toEqual(['deleteRecord', 'createRecord']);
    const created = r.calls[1]!.body!;
    expect(created.collection).toBe(SPROUT_NSID);
    expect(created.record).toMatchObject({ $type: SPROUT_NSID, subject: GARDEN_SUBJECT, kind: 'violet' });
    const mine = document.querySelector('.home-flower.is-yours')!;
    expect(mine.classList.contains('home-flower--violet')).toBe(true);
    expect(mine.textContent).toBe(COPY.yours('me.test'));
    expect(document.querySelector('[data-garden-status]')!.textContent).toBe(COPY.replanted('violet'));
    expect(document.querySelector<HTMLElement>('[data-garden-dig]')!.hidden).toBe(false);
    expect(readReader()).toBe('me.test');

    document.querySelector<HTMLButtonElement>('[data-garden-dig]')!.click();
    await flush();
    expect(r.owned).toEqual([]);
    expect(document.querySelector('.home-flower.is-yours')).toBeNull();
    expect(document.querySelector('[data-garden-status]')!.textContent).toBe(COPY.dug);
  });

  it('signed out: asks to sign in, then plants once back from signing in', async () => {
    const r = rig();
    await r.run();
    document.querySelector<HTMLButtonElement>('[data-kind="tulip"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-garden-plant]')!.click();
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

    // back on the home page, signed in
    const back = rig({ signedIn: true });
    await back.run();
    expect(back.calls.find((c) => c.path.endsWith('createRecord'))!.body!.record).toMatchObject({ kind: 'tulip' });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(sessionStorage.getItem(KIND_KEY)).toBeNull();
  });

  it('an older sign-in without flower permission is asked to sign in again', async () => {
    const r = rig({ signedIn: true, failCreate: 403 });
    await r.run();
    document.querySelector<HTMLButtonElement>('[data-garden-plant]')!.click();
    await flush();
    expect(document.querySelector<HTMLDialogElement>('dialog[data-blog-signin]')!.hasAttribute('open')).toBe(true);
    expect(document.querySelector('[data-blog-signin-lede]')!.textContent).toBe(COPY.consent);
  });

  it('elsewhere (previews) it says planting works on atpota.to', async () => {
    const r = rig({ auth: null });
    await r.run();
    document.querySelector<HTMLButtonElement>('[data-garden-plant]')!.click();
    await flush();
    expect(document.querySelector('[data-garden-status]')!.textContent).toBe(COPY.otherHost);
  });

  it('says so when the patch does not load', async () => {
    document.body.innerHTML = section('home-patch') + DIALOG;
    await initGarden({ auth: null, fetchImpl: (async () => new Response('down', { status: 503 })) as typeof fetch });
    expect(document.querySelector<HTMLElement>('[data-garden]')!.dataset.state).toBe('error');
    expect(document.querySelector('[data-garden-status]')!.textContent).toBe(COPY.loadFailed);
  });
});
