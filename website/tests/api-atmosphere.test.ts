import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/atmosphere.js';
import {
  CACHE_OK,
  COLLECTIONS,
  conditionFor,
  createAtmosphereHandlers,
  JETSTREAMS,
  jetstreamUrl,
  metricOf,
  sample,
  type SocketLike,
} from '../server/atmosphere.js';

// /api/atmosphere with a scripted fake Jetstream: each socket opens, then emits the
// messages it was given, spread over the sample window.

const commit = (collection: string, operation = 'create') => JSON.stringify({ did: 'did:plc:x', kind: 'commit', commit: { operation, collection } });

class FakeSocket implements SocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

type Script = { fail?: 'error' | 'never-open'; messages?: string[] };

function opener(scripts: Script[]) {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const open = (url: string) => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    const script = scripts[urls.length - 1] ?? {};
    setTimeout(() => {
      if (script.fail === 'error') return socket.onerror?.({});
      if (script.fail === 'never-open') return;
      socket.onopen?.({});
      (script.messages ?? []).forEach((data, i) => setTimeout(() => socket.onmessage?.({ data }), 10 + i));
    }, 5);
    return socket;
  };
  return { open, urls, sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the firehose', () => {
  it('asks Jetstream for exactly the four collections', () => {
    const url = new URL(jetstreamUrl(JETSTREAMS[0]));
    expect(url.searchParams.getAll('wantedCollections').sort()).toEqual(Object.values(COLLECTIONS).sort());
  });

  it('counts only new records in the collections it watches', () => {
    expect(metricOf(commit('app.bsky.feed.post'))).toBe('posts');
    expect(metricOf(commit('app.bsky.feed.like'))).toBe('likes');
    expect(metricOf(commit('app.bsky.feed.repost'))).toBe('reposts');
    expect(metricOf(commit('app.bsky.graph.follow'))).toBe('follows');
    expect(metricOf(commit('app.bsky.feed.like', 'delete'))).toBeNull();
    expect(metricOf(commit('app.bsky.graph.block'))).toBeNull();
    expect(metricOf(JSON.stringify({ kind: 'identity' }))).toBeNull();
    expect(metricOf('not json')).toBeNull();
    expect(metricOf(42)).toBeNull();
  });

  it('names the weather from posts a second', () => {
    expect(conditionFor(5)).toBe('calm');
    expect(conditionFor(12)).toBe('light');
    expect(conditionFor(23)).toBe('breezy');
    expect(conditionFor(30)).toBe('gusty');
    expect(conditionFor(80)).toBe('stormy');
  });

  it('turns a few seconds of messages into rates per second', async () => {
    vi.useFakeTimers();
    let t = 0;
    const net = opener([{ messages: [...Array(6).fill(commit('app.bsky.feed.post')), ...Array(30).fill(commit('app.bsky.feed.like')), commit('app.bsky.graph.follow')] }]);
    const reading = sample(net.open, 'wss://x', () => t, 2000);
    await vi.advanceTimersByTimeAsync(5);
    t = 0;
    await vi.advanceTimersByTimeAsync(1995);
    t = 2000;
    await vi.advanceTimersByTimeAsync(10);
    const r = await reading;
    expect(r.perSecond).toEqual({ posts: 3, likes: 15, reposts: 0, follows: 0.5 });
    expect(r.condition).toBe('calm');
    expect(net.sockets[0]!.closed).toBe(true);
  });

  it('refuses a silent stream, an error, or a socket that never opens', async () => {
    vi.useFakeTimers();
    for (const script of [{ messages: [] }, { fail: 'error' as const }, { fail: 'never-open' as const }]) {
      const net = opener([script]);
      const reading = sample(net.open, 'wss://x', () => 0, 1000, 3000);
      const settled = reading.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(4000);
      expect(await settled).toBe('rejected');
    }
  });
});

describe('/api/atmosphere', () => {
  it('answers with the reading, cached for a minute at the CDN', async () => {
    vi.useFakeTimers();
    const net = opener([{ messages: [commit('app.bsky.feed.post'), commit('app.bsky.feed.like')] }]);
    const h = createAtmosphereHandlers({ open: net.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const pending = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1100);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const body = (await res.json()) as { perSecond: Record<string, number>; condition: string };
    expect(Object.keys(body.perSecond).sort()).toEqual(['follows', 'likes', 'posts', 'reposts']);
    expect(body.condition).toBe('calm');
  });

  it('falls back to the second Jetstream, and says 503 when both fail', async () => {
    vi.useFakeTimers();
    const net = opener([{ fail: 'error' }, { messages: [commit('app.bsky.feed.post')] }]);
    const h = createAtmosphereHandlers({ open: net.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const ok = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1200);
    expect((await ok).status).toBe(200);
    expect(net.urls.map((u) => u.split('?')[0])).toEqual([...JETSTREAMS]);

    const down = opener([{ fail: 'error' }, { fail: 'error' }]);
    const h2 = createAtmosphereHandlers({ open: down.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const bad = h2.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(100);
    const res = await bad;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/atmosphere', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});
