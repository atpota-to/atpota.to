// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT, FOLLOW, HANDLE_MAX, LIVESTREAM, NOBODY, atHandle, avatarUrl, commandOf, createNames, eventFor, jetstreamUrl, listen, resolveActor } from '../src/overlay/chat.js';
import { appsLine, createGate, endedLine, followLine, forecastLine, helloLine, liveLine, petLine, weatherLine } from '../src/overlay/lines.js';
import { readParams, toSearch } from '../src/overlay/params.js';
import { LINE_GAP_MS, LINE_MS, MAX_LINES, bobMs, enqueue, mountOverlayPoe } from '../src/overlay/poe.js';
import { AGAIN_MS, createRegulars } from '../src/overlay/regulars.js';
import { init as initSetup, overlayUrl, paramsFrom } from '../src/overlay/setup.js';
import { TUNES } from '../src/overlay/sounds.js';
import { WAKE_MS } from '../src/poe/idle.js';
import { MASCOT_URLS } from '../src/scripts/mascot.js';
import type { Reading } from '../src/scripts/weather.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');

const STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';
const commit = (did: string, collection: string, record: Record<string, unknown>, operation = 'create', rkey = '3m4abc') => ({ kind: 'commit', did, time_us: 1, commit: { operation, collection, rkey, record } });
const who = (handle: string | null, avatar: string | null = null) => ({ handle, avatar });

describe('overlay params', () => {
  it('shows both pieces, on the right, in the light theme, by default', () => {
    const p = readParams('');
    expect([...p.show].sort()).toEqual(['poe', 'weather']);
    expect(p).toMatchObject({ streamer: null, chat: true, follows: true, alerts: true, ignore: [], volume: 40, nap: 5, side: 'right', theme: 'light', demo: false });
  });

  it('reads sound, naps and who to ignore', () => {
    expect(readParams('?sound=off').volume).toBe(0);
    expect(readParams('?volume=250').volume).toBe(100);
    expect(readParams('?volume=nope').volume).toBe(40);
    expect(readParams('?nap=off').nap).toBe(0);
    expect(readParams('?nap=12').nap).toBe(12);
    expect(readParams('?ignore=@Bot.bsky.social,did:plc:abc,,<x>,bot.bsky.social').ignore).toEqual(['bot.bsky.social', 'did:plc:abc']);
    expect([...readParams('?show=strip,poe').show]).toEqual(['strip', 'poe']);
  });

  it('writes settings back as a URL, leaving defaults out', () => {
    expect(toSearch(readParams(''))).toBe('');
    const search = '?show=poe,strip&streamer=dame.is&follows=off&ignore=bot.bsky.social&volume=70&nap=off&side=left&theme=dark';
    expect(toSearch(readParams(search))).toBe(search);
    expect(toSearch({ ...readParams(''), demo: true, volume: 0 })).toBe('?sound=off&demo');
    const again = readParams(toSearch(readParams(search)));
    expect(again).toEqual(readParams(search));
  });

  it('reads each setting, and ignores what it does not know', () => {
    const p = readParams('?show=poe,cats&streamer=@Dame.is&follows=off&alerts=no&side=left&theme=dark&demo');
    expect([...p.show]).toEqual(['poe']);
    expect(p).toMatchObject({ streamer: 'dame.is', chat: true, follows: false, alerts: false, side: 'left', theme: 'dark', demo: true });
    expect(readParams(`?streamer=${STREAMER}`).streamer).toBe(STREAMER);
    expect(readParams('?streamer=<script>').streamer).toBeNull();
    expect(readParams('?show=nothing').show.size).toBe(2);
  });
});

describe('the stream', () => {
  it('finds commands at the start of a message only', () => {
    expect(commandOf('!weather')).toBe('weather');
    expect(commandOf('  !PET poe')).toBe('pet');
    expect(commandOf('!poe')).toBe('poe');
    expect(commandOf('!Forecast please')).toBe('forecast');
    expect(commandOf('!apps')).toBe('apps');
    expect(commandOf('what is the !weather')).toBeNull();
    expect(commandOf('!weatherman')).toBeNull();
  });

  it("keeps chat in the streamer's chat and follows of the streamer", () => {
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER, text: 'hi' }), STREAMER)).toEqual({ kind: 'chat', did: 'did:plc:a', command: null });
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER, text: '!pet' }), STREAMER)).toEqual({ kind: 'chat', did: 'did:plc:a', command: 'pet' });
    expect(eventFor(commit('did:plc:a', FOLLOW, { subject: STREAMER }), STREAMER)).toEqual({ kind: 'follow', did: 'did:plc:a' });
  });

  it("drops other streams, other people's follows, deletes and anything odd", () => {
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: 'did:plc:other', text: 'hi' }), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', FOLLOW, { subject: 'did:plc:other' }), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, FOLLOW, { subject: STREAMER }), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER, text: 'hi' }, 'delete'), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER }), STREAMER)).toBeNull();
    expect(eventFor({ kind: 'identity', did: 'did:plc:a' }, STREAMER)).toBeNull();
    expect(eventFor('nope', STREAMER)).toBeNull();
  });

  it("hears the streamer's stream start and end, and nobody else's", () => {
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: ' potatoes all day ', createdAt: 'x' }, 'create', 'r1'), STREAMER)).toEqual({ kind: 'live', rkey: 'r1', title: 'potatoes all day' });
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: '' }, 'create', 'r1'), STREAMER)).toEqual({ kind: 'live', rkey: 'r1', title: null });
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: 'x', lastSeenAt: 'y' }, 'update', 'r1'), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: 'x', endedAt: 'z' }, 'update', 'r1'), STREAMER)).toEqual({ kind: 'ended', rkey: 'r1' });
    expect(eventFor(commit('did:plc:other', LIVESTREAM, { title: 'x' }), STREAMER)).toBeNull();
  });

  it('asks Jetstream for chat and streams, and follows only when wanted', () => {
    const both = new URL(jetstreamUrl('wss://j.example/subscribe', true, 42));
    expect(both.searchParams.getAll('wantedCollections')).toEqual([CHAT, LIVESTREAM, FOLLOW]);
    expect(both.searchParams.get('cursor')).toBe('42');
    expect(new URL(jetstreamUrl('wss://j.example/subscribe', false)).searchParams.getAll('wantedCollections')).toEqual([CHAT, LIVESTREAM]);
  });

  it('listens, hands over events, and reconnects to the other host after a drop', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((m: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    }
    const events: unknown[] = [];
    const l = listen(STREAMER, true, (e) => events.push(e), FakeSocket as unknown as new (url: string) => WebSocket);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ ...commit('did:plc:a', CHAT, { streamer: STREAMER, text: 'hi' }), time_us: 99 }) });
    sockets[0]!.onmessage?.({ data: 'not json' });
    expect(events).toEqual([{ kind: 'chat', did: 'did:plc:a', command: null }]);
    sockets[0]!.close();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain('us-west');
    expect(new URL(sockets[1]!.url).searchParams.get('cursor')).toBe('99');
    l.stop();
    expect(sockets[1]!.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(2);
    vi.useRealTimers();
  });

  it('says handles with an @, cut short, and never an invalid one', () => {
    expect(atHandle('dame.is')).toBe('@dame.is');
    expect(atHandle('handle.invalid')).toBeNull();
    expect(atHandle('<b>hi</b>')).toBeNull();
    expect(atHandle('a'.repeat(60) + '.bsky.social')!.length).toBe(HANDLE_MAX + 1);
  });

  it('only puts avatars from bluesky\'s CDN on stream', () => {
    expect(avatarUrl('https://cdn.bsky.app/img/avatar/plain/did:plc:a/bafk@jpeg')).toContain('cdn.bsky.app');
    expect(avatarUrl('http://cdn.bsky.app/x')).toBeNull();
    expect(avatarUrl('https://evil.example/x.png')).toBeNull();
    expect(avatarUrl('javascript:alert(1)')).toBeNull();
    expect(avatarUrl(undefined)).toBeNull();
  });

  it('resolves a handle to a DID, and looks each person up once', async () => {
    const avatar = 'https://cdn.bsky.app/img/avatar/plain/did:plc:a/x@jpeg';
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('resolveHandle') ? { did: STREAMER } : { handle: 'dame.is', avatar }))) as unknown as typeof fetch;
    expect(await resolveActor('dame.is', fetchImpl)).toBe(STREAMER);
    expect(await resolveActor(STREAMER, fetchImpl)).toBe(STREAMER);
    const names = createNames(fetchImpl);
    expect(await names('did:plc:a')).toEqual({ handle: '@dame.is', avatar });
    expect(await names('did:plc:a')).toEqual({ handle: '@dame.is', avatar });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const broken = createNames((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    expect(await broken('did:plc:b')).toEqual(NOBODY);
  });
});

describe('what poe says', () => {
  const reading: Reading = { perSecond: { posts: 30, likes: 250, reposts: 40, follows: 20 }, condition: 'breezy', records: { perSecond: 452.4, bluesky: 450, elsewhere: 2.4 }, diversity: { index: 1.27, level: 'low', apps: 4, collections: 16 } };

  it('reads the weather out, or says it cannot', () => {
    const line = weatherLine(reading, who('@dame.is'));
    expect(line.label).toBe('weather report for @dame.is');
    expect(line.sub).toContain('452 new records a second');
    expect(line.sub).toContain('diversity index 1.3, low');
    expect(weatherLine(null, NOBODY).text).toContain('hard to read');
  });

  it('names the busiest apps outside bluesky', () => {
    const apps = [
      { domain: 'tangled.sh', perSecond: 3.2, count: 190, collections: [] },
      { domain: 'whtwnd.com', perSecond: 1, count: 60, collections: [] },
      { domain: 'smokesignal.events', perSecond: 0.5, count: 30, collections: [] },
      { domain: 'fourth.app', perSecond: 0.1, count: 6, collections: [] },
    ];
    const line = appsLine({ ...reading, apps }, NOBODY);
    expect(line.text).toBe('busiest outside bluesky: tangled.sh, whtwnd.com and smokesignal.events');
    expect(line.sub).toContain('tangled.sh 3.2/sec');
    expect(line.sub).not.toContain('fourth.app');
    expect(appsLine({ ...reading, apps: [] }, NOBODY).text).toContain('all bluesky');
  });

  it('reads the forecast, or says it is still learning', () => {
    const hour = (h: number, condition: 'calm' | 'breezy') => ({ t: `2026-10-21T${String(h).padStart(2, '0')}:00:00Z`, perSecond: 400, low: 350, high: 450, condition, chance: { gusts: 0, storm: 0 } });
    const f = { madeAt: '2026-10-21T10:00:00Z', basis: { hours: 300, days: 14 }, hours: [hour(11, 'breezy'), hour(12, 'breezy'), hour(13, 'calm')], sun: [] };
    expect(forecastLine(f, who('@dame.is')).label).toBe('forecast for @dame.is');
    expect(forecastLine(f, NOBODY).text.length).toBeGreaterThan(5);
    expect(forecastLine({ ...f, learning: true }, NOBODY).text).toContain('still learning');
    expect(forecastLine(null, NOBODY).text).toContain('hard to read');
  });

  it('has a name for people without a handle, and shows avatars', () => {
    expect(helloLine(NOBODY, false, () => 0).text).toContain('friend');
    expect(helloLine(who('@a.b'), true, () => 0).text).toContain('welcome back');
    expect(followLine(NOBODY).text).toContain('someone');
    expect(followLine(who('@a.b')).rank).toBeGreaterThan(helloLine(who('@a.b')).rank!);
    expect(followLine(who('@a.b', 'https://cdn.bsky.app/x')).avatar).toBe('https://cdn.bsky.app/x');
  });

  it('says when a pet counts on the leaderboard', () => {
    expect(petLine(NOBODY).sub).toBeUndefined();
    expect(petLine(NOBODY, true).sub).toContain('leaderboard');
  });

  it("cheers the stream going live, with the streamer's title, and waves it off", () => {
    expect(liveLine('potato hour').sub).toBe('potato hour');
    expect(liveLine(null).sub).toBeUndefined();
    expect(liveLine(null).rank).toBeGreaterThan(followLine(NOBODY).rank!);
    expect(endedLine().text).toContain('thanks for watching');
  });

  it('has a tune for every sound', () => {
    for (const tune of Object.values(TUNES)) {
      expect(tune.notes.length).toBeGreaterThan(0);
      for (const [f, start, length] of tune.notes) expect(f > 0 && start >= 0 && length > 0).toBe(true);
    }
  });

  it('gates each key for its time', () => {
    let t = 0;
    const gate = createGate(() => t);
    expect(gate('pet', 1000)).toBe(true);
    expect(gate('pet', 1000)).toBe(false);
    expect(gate('poe', 1000)).toBe(true);
    t = 1000;
    expect(gate('pet', 1000)).toBe(true);
    expect(gate('follow', Infinity)).toBe(true);
    t = 1e12;
    expect(gate('follow', Infinity)).toBe(false);
  });

  it('bobs faster when the atmosphere is busy, within limits', () => {
    expect(bobMs(450)).toBe(3200);
    expect(bobMs(900)).toBeLessThan(bobMs(450));
    expect(bobMs(100_000)).toBe(1400);
    expect(bobMs(1)).toBe(5000);
    expect(bobMs(0)).toBe(3200);
  });

  it('keeps the most important lines, in the order they came', () => {
    let q: ReturnType<typeof enqueue> = [];
    for (let i = 0; i < MAX_LINES; i++) q = enqueue(q, { text: `hello ${i}`, rank: 1 }, 0, i);
    q = enqueue(q, { text: 'follow', rank: 3 }, 0, 10);
    expect(q.map((x) => x.line.text)).toEqual(['hello 1', 'hello 2', 'hello 3', 'follow']);
  });
});

describe('regulars', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
  };

  it('says hello once, then welcome back after a while, and remembers across reloads', () => {
    let t = 0;
    const storage = memory();
    const a = createRegulars(STREAMER, storage, () => t);
    expect(a.greet('did:plc:a')).toBe('hello');
    expect(a.greet('did:plc:a')).toBeNull();
    t = 60_000;
    // the source reloads mid-stream: no second hello
    expect(createRegulars(STREAMER, storage, () => t).greet('did:plc:a')).toBeNull();
    t += AGAIN_MS;
    expect(createRegulars(STREAMER, storage, () => t).greet('did:plc:a')).toBe('welcome-back');
    expect(createRegulars('did:plc:another', storage, () => t).greet('did:plc:a')).toBe('hello');
  });

  it('keeps going without storage', () => {
    const r = createRegulars(STREAMER, null);
    expect(r.greet('did:plc:a')).toBe('hello');
    expect(r.greet('did:plc:a')).toBeNull();
  });
});

describe('the setup page', () => {
  it('turns the form into the overlay URL', () => {
    document.body.innerHTML = read('../overlay/setup.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    const form = document.querySelector<HTMLFormElement>('[data-ovs-form]')!;
    expect(overlayUrl(paramsFrom(form), 'https://atpota.to')).toBe('https://atpota.to/overlay');
    form.querySelector<HTMLInputElement>('[name="streamer"]')!.value = '@Dame.is';
    form.querySelector<HTMLInputElement>('[value="strip"]')!.checked = true;
    form.querySelector<HTMLInputElement>('[value="weather"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="follows"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="side"][value="left"]')!.checked = true;
    form.querySelector<HTMLInputElement>('[name="volume"]')!.value = '0';
    form.querySelector<HTMLSelectElement>('[name="nap"]')!.value = '10';
    form.querySelector<HTMLTextAreaElement>('[name="ignore"]')!.value = 'bot.bsky.social\n@other.bsky.social, nonsense!';
    expect(overlayUrl(paramsFrom(form), 'https://atpota.to')).toBe('https://atpota.to/overlay?show=poe,strip&streamer=dame.is&follows=off&ignore=bot.bsky.social,other.bsky.social&sound=off&nap=10&side=left');
  });
});

describe('the setup page on a phone', () => {
  it('opens the preview full screen, and closes it with the button, a tap or Escape', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    document.body.innerHTML = read('../overlay/setup.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    initSetup(document);
    const preview = document.querySelector<HTMLElement>('[data-ovs-preview]')!;
    const full = document.querySelector<HTMLButtonElement>('[data-ovs-full]')!;
    full.click();
    expect(preview.classList.contains('is-full')).toBe(true);
    expect(document.documentElement.classList.contains('ovs-full-open')).toBe(true);
    expect(full.textContent).toBe('close');
    full.click();
    expect(preview.classList.contains('is-full')).toBe(false);
    full.click();
    preview.click();
    expect(preview.classList.contains('is-full')).toBe(false);
    full.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(preview.classList.contains('is-full')).toBe(false);
    expect(document.documentElement.classList.contains('ovs-full-open')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('the overlay potato', () => {
  afterEach(() => vi.useRealTimers());

  it('says lines one at a time, with a face, through textContent', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-ov-poe></div>';
    const host = document.querySelector<HTMLElement>('[data-ov-poe]')!;
    const poe = mountOverlayPoe(host, { napMs: 0 });
    const bubble = host.querySelector<HTMLElement>('.ov-bubble')!;
    const img = host.querySelector<HTMLImageElement>('.ov-potato__img')!;
    expect(bubble.hidden).toBe(true);
    poe.say({ label: 'in the chat', text: '<b>hi</b>', face: 'kawaii', avatar: 'https://cdn.bsky.app/a' });
    poe.say({ text: 'second' });
    expect(bubble.hidden).toBe(false);
    expect(bubble.querySelector('b')).toBeNull();
    expect(bubble.textContent).toContain('<b>hi</b>');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    expect(host.querySelector<HTMLImageElement>('.ov-bubble__avatar')!.hidden).toBe(false);
    vi.advanceTimersByTime(LINE_MS + LINE_GAP_MS);
    expect(bubble.textContent).toContain('second');
    expect(host.querySelector<HTMLImageElement>('.ov-bubble__avatar')!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('.ov-bubble__label')!.hidden).toBe(true);
    vi.advanceTimersByTime(LINE_MS + LINE_GAP_MS);
    expect(bubble.hidden).toBe(true);
  });

  it('naps when the stream is quiet, and wakes with a start before it talks', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-ov-poe></div>';
    const host = document.querySelector<HTMLElement>('[data-ov-poe]')!;
    const played: string[] = [];
    const poe = mountOverlayPoe(host, { napMs: 60_000, sounds: { play: (s) => played.push(s) } });
    const potato = host.querySelector<HTMLElement>('.ov-potato')!;
    const img = host.querySelector<HTMLImageElement>('.ov-potato__img')!;
    vi.advanceTimersByTime(50_000);
    poe.stir();
    vi.advanceTimersByTime(50_000);
    expect(potato.dataset.napping).toBeUndefined();
    vi.advanceTimersByTime(30_000);
    expect(potato.dataset.napping).toBe('true');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.sleepy);
    expect(played).toContain('yawn');
    poe.say({ text: 'hello', sound: 'hello' });
    expect(potato.dataset.napping).toBeUndefined();
    expect(potato.dataset.startled).toBe('true');
    expect(host.querySelector<HTMLElement>('.ov-bubble')!.hidden).toBe(true);
    vi.advanceTimersByTime(WAKE_MS);
    expect(host.querySelector<HTMLElement>('.ov-bubble')!.hidden).toBe(false);
    expect(played).toContain('hello');
  });

  it('sets its breathing pace', () => {
    document.body.innerHTML = '<div data-ov-poe></div>';
    const host = document.querySelector<HTMLElement>('[data-ov-poe]')!;
    mountOverlayPoe(host).setPace(900);
    expect(host.querySelector<HTMLElement>('.ov-potato')!.style.getPropertyValue('--bob')).toBe(`${bobMs(900)}ms`);
  });
});

describe('the overlay page', () => {
  it('is built, kept out of search, and has the weather hooks renderReading fills in', () => {
    expect(read('../vite.config.ts')).toContain("overlay: r('./overlay/index.html')");
    const html = read('../overlay/index.html');
    expect(html).toContain('<meta name="robots" content="noindex">');
    for (const hook of ['data-ov-card', 'data-ov-strip', 'data-weather-records', 'data-weather-cond', 'data-weather-spark', 'data-weather-sky', 'data-weather-index', 'data-ov-app', 'data-ov-poe']) expect(html).toContain(hook);
  });

  it('has a setup page, built and wired to its page module', () => {
    expect(read('../vite.config.ts')).toContain("overlaySetup: r('./overlay/setup.html')");
    expect(read('../overlay/setup.html')).toContain('<body data-page="overlay-setup">');
    expect(read('../src/scripts/main.ts')).toContain("'overlay-setup': () => import('../overlay/setup')");
  });
});
