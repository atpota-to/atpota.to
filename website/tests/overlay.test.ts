// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT, FOLLOW, HANDLE_MAX, atHandle, commandOf, createNames, eventFor, jetstreamUrl, listen, resolveActor } from '../src/overlay/chat.js';
import { createGate, followLine, helloLine, weatherLine } from '../src/overlay/lines.js';
import { readParams } from '../src/overlay/params.js';
import { LINE_GAP_MS, LINE_MS, MAX_LINES, bobMs, enqueue, mountOverlayPoe } from '../src/overlay/poe.js';
import { MASCOT_URLS } from '../src/scripts/mascot.js';
import type { Reading } from '../src/scripts/weather.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');

const STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';
const commit = (did: string, collection: string, record: Record<string, unknown>, operation = 'create') => ({ kind: 'commit', did, time_us: 1, commit: { operation, collection, record } });

describe('overlay params', () => {
  it('shows both pieces, on the right, in the light theme, by default', () => {
    const p = readParams('');
    expect([...p.show].sort()).toEqual(['poe', 'weather']);
    expect(p).toMatchObject({ streamer: null, chat: true, follows: true, alerts: true, side: 'right', theme: 'light', demo: false });
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

  it('asks Jetstream for chat, and follows only when wanted', () => {
    const both = new URL(jetstreamUrl('wss://j.example/subscribe', true, 42));
    expect(both.searchParams.getAll('wantedCollections')).toEqual([CHAT, FOLLOW]);
    expect(both.searchParams.get('cursor')).toBe('42');
    expect(new URL(jetstreamUrl('wss://j.example/subscribe', false)).searchParams.getAll('wantedCollections')).toEqual([CHAT]);
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

  it('resolves a handle to a DID, and looks each handle up once', async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('resolveHandle') ? { did: STREAMER } : { handle: 'dame.is' }))) as unknown as typeof fetch;
    expect(await resolveActor('dame.is', fetchImpl)).toBe(STREAMER);
    expect(await resolveActor(STREAMER, fetchImpl)).toBe(STREAMER);
    const names = createNames(fetchImpl);
    expect(await names('did:plc:a')).toBe('@dame.is');
    expect(await names('did:plc:a')).toBe('@dame.is');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('what poe says', () => {
  const reading: Reading = { perSecond: { posts: 30, likes: 250, reposts: 40, follows: 20 }, condition: 'breezy', records: { perSecond: 452.4, bluesky: 450, elsewhere: 2.4 }, diversity: { index: 1.27, level: 'low', apps: 4, collections: 16 } };

  it('reads the weather out, or says it cannot', () => {
    const line = weatherLine(reading, '@dame.is');
    expect(line.label).toBe('weather report for @dame.is');
    expect(line.sub).toContain('452 new records a second');
    expect(line.sub).toContain('diversity index 1.3, low');
    expect(weatherLine(null, null).text).toContain('hard to read');
  });

  it('has a name for people without a handle', () => {
    expect(helloLine(null, () => 0).text).toContain('friend');
    expect(followLine(null).text).toContain('someone');
    expect(followLine('@a.b').rank).toBeGreaterThan(helloLine('@a.b').rank!);
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

describe('the overlay potato', () => {
  afterEach(() => vi.useRealTimers());

  it('says lines one at a time, with a face, through textContent', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-ov-poe></div>';
    const host = document.querySelector<HTMLElement>('[data-ov-poe]')!;
    const poe = mountOverlayPoe(host);
    const bubble = host.querySelector<HTMLElement>('.ov-bubble')!;
    const img = host.querySelector<HTMLImageElement>('.ov-potato__img')!;
    expect(bubble.hidden).toBe(true);
    poe.say({ label: 'in the chat', text: '<b>hi</b>', face: 'kawaii' });
    poe.say({ text: 'second' });
    expect(bubble.hidden).toBe(false);
    expect(bubble.querySelector('b')).toBeNull();
    expect(bubble.textContent).toContain('<b>hi</b>');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    vi.advanceTimersByTime(LINE_MS + LINE_GAP_MS);
    expect(bubble.textContent).toContain('second');
    expect(host.querySelector<HTMLElement>('.ov-bubble__label')!.hidden).toBe(true);
    vi.advanceTimersByTime(LINE_MS + LINE_GAP_MS);
    expect(bubble.hidden).toBe(true);
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
    for (const hook of ['data-weather-tile', 'data-weather-records', 'data-weather-cond', 'data-weather-spark', 'data-weather-sky', 'data-weather-index', 'data-ov-app', 'data-ov-poe']) expect(html).toContain(hook);
  });
});
