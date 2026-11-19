// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT, FOLLOW, GATE, HANDLE_MAX, LIVESTREAM, OVERLAY, SCENE, NOBODY, atHandle, avatarUrl, commandOf, createNames, eventFor, jetstreamUrl, listen, resolveActor } from '../src/overlay/chat.js';
import { appsLine, createGate, endedLine, followLine, forecastLine, helloLine, liveLine, petLine, weatherLine } from '../src/overlay/lines.js';
import { readParams, readWidgets, toSearch, writeWidgets } from '../src/overlay/params.js';
import { DEFAULT_CONFIG, fromRecord, OVERLAY_NSID, SLOTS, toRecord, WIDGET_HOME, WIDGET_KINDS, withOverrides, type OverlayConfig } from '../src/overlay/config.js';
import { createLayout } from '../src/overlay/layout.js';
import { RECORD_COLLECTIONS } from '../src/overlay/records.js';
import { AT_CENTER_X, mirrorSvg, VIEW_WIDTH } from '../src/overlay/mirror.js';
import { didDocumentUrl, pdsOf, readPublicConfig } from '../src/overlay/store.js';
import { createVisitors, pathFor, place, VISITOR_KINDS, visitorsFor } from '../src/overlay/visitors.js';
import { LINE_GAP_MS, LINE_MS, MAX_LINES, bobMs, enqueue, mountOverlayPoe } from '../src/overlay/poe.js';
import { AGAIN_MS, createRegulars } from '../src/overlay/regulars.js';
import { buildAllWidgetRows, configFrom, fillForm, init as initSetup } from '../src/overlay/setup.js';
import { TUNES } from '../src/overlay/sounds.js';
import { WAKE_MS } from '../src/poe/idle.js';
import { MASCOT_URLS } from '../src/scripts/mascot.js';
import type { Reading } from '../src/scripts/weather.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');

const STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';
const commit = (did: string, collection: string, record: Record<string, unknown>, operation = 'create', rkey = '3m4abc') => ({ kind: 'commit', did, time_us: 1, commit: { operation, collection, rkey, record } });
const who = (handle: string | null, avatar: string | null = null) => ({ handle, avatar });

describe('overlay config and its address', () => {
  it('has no overrides without settings, so the record or the defaults rule', () => {
    const p = readParams('');
    expect(p).toEqual({ streamer: null, layout: 'self', demo: false, who: null, overrides: {} });
    expect(withOverrides(DEFAULT_CONFIG, p.overrides)).toEqual(DEFAULT_CONFIG);
  });

  it('reads widgets with their slot and size, each kind once, the strip on an edge', () => {
    expect(readWidgets('card:tl:120,apps:tr:80,card:br:100,cats:tl:100,strip:tr:100')).toEqual([
      { kind: 'card', slot: 'top-left', scale: 120 },
      { kind: 'apps', slot: 'top-right', scale: 80 },
      { kind: 'strip', slot: 'top-center', scale: 100 },
    ]);
    expect(readWidgets('none')).toEqual([]);
    expect(readWidgets('pulse:nowhere:9000')).toEqual([{ kind: 'pulse', slot: WIDGET_HOME.pulse, scale: 200 }]);
    expect(writeWidgets(readWidgets('badge:bc:70'))).toBe('badge:bc:70');
  });

  it('reads Poe, sound, naps and who to ignore, and the older show= and side=', () => {
    expect(readParams('?poe=left:120').overrides.poe).toEqual({ show: true, side: 'left', scale: 120 });
    expect(readParams('?poe=off').overrides.poe).toEqual({ show: false });
    expect(readParams('?sound=off').overrides.volume).toBe(0);
    expect(readParams('?volume=250').overrides.volume).toBe(100);
    expect(readParams('?volume=nope').overrides.volume).toBeUndefined();
    expect(readParams('?nap=off').overrides.nap).toBe(0);
    expect(readParams('?visitors=off&chat=on').overrides).toMatchObject({ visitors: false, chat: true });
    expect(readParams('?ignore=@Bot.bsky.social,did:plc:abc,,<x>,bot.bsky.social').overrides.ignore).toEqual(['bot.bsky.social', 'did:plc:abc']);
    const old = readParams('?show=poe,strip&side=left&theme=dark&streamer=@Dame.is&demo');
    expect(old.streamer).toBe('dame.is');
    expect(old.demo).toBe(true);
    expect(withOverrides(DEFAULT_CONFIG, old.overrides)).toMatchObject({ poe: { show: true, side: 'left', scale: 100 }, widgets: [{ kind: 'strip', slot: 'bottom-center', scale: 100 }], theme: 'dark' });
    expect(readParams('?streamer=<script>').streamer).toBeNull();
  });

  it('writes a whole config as an address and reads it back the same', () => {
    expect(toSearch(DEFAULT_CONFIG)).toBe('');
    const c: OverlayConfig = {
      poe: { show: true, side: 'left', scale: 140 },
      widgets: [
        { kind: 'apps', slot: 'top-right', scale: 90 },
        { kind: 'strip', slot: 'bottom-center', scale: 100 },
      ],
      chat: true,
      follows: false,
      alerts: true,
      visitors: false,
      ignore: ['bot.bsky.social'],
      volume: 70,
      nap: 0,
      theme: 'dark',
    };
    const search = toSearch(c, { streamer: 'dame.is', demo: true });
    expect(search).toBe('?streamer=dame.is&w=apps:tr:90,strip:bc:100&poe=left:140&follows=off&visitors=off&ignore=bot.bsky.social&volume=70&nap=off&theme=dark&demo');
    expect(withOverrides(DEFAULT_CONFIG, readParams(search).overrides)).toEqual(c);
  });

  it('keeps what checks out of a record, and the defaults for the rest', () => {
    const c = fromRecord({ poe: { show: false, side: 'sideways', scale: 9000 }, widgets: [{ kind: 'pulse', slot: 'top-center', scale: 60 }, { kind: 'evil' }], volume: 1.5, nap: 10, theme: 'dark', ignore: ['@A.bsky.social', 42, '<x>'] });
    expect(c).toEqual({ ...DEFAULT_CONFIG, poe: { show: false, side: 'right', scale: 200 }, widgets: [{ kind: 'pulse', slot: 'top-center', scale: 60 }], nap: 10, theme: 'dark', ignore: ['a.bsky.social'] });
    expect(fromRecord('junk')).toEqual(DEFAULT_CONFIG);
    expect(fromRecord({}).widgets).toEqual(DEFAULT_CONFIG.widgets);
  });

  it("saves a record the lexicon's required fields are all in", () => {
    const lexicon = JSON.parse(read('../lexicons/to/atpota/poe/overlay.json'));
    expect(lexicon.id).toBe(OVERLAY_NSID);
    expect(lexicon.defs.main.key).toBe('any');
    const record = toRecord(DEFAULT_CONFIG, '2026-10-21T00:00:00.000Z', new Date('2026-10-22T00:00:00Z'));
    for (const field of lexicon.defs.main.record.required) expect(record).toHaveProperty(field);
    expect(record).toMatchObject({ $type: OVERLAY_NSID, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' });
    expect(fromRecord(record)).toEqual(DEFAULT_CONFIG);
    expect(lexicon.defs.widget.properties.kind.knownValues).toEqual([...WIDGET_KINDS]);
    expect(lexicon.defs.widget.properties.slot.knownValues).toEqual([...SLOTS]);
  });
});

describe('the record in the repo', () => {
  const doc = { id: STREAMER, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.atpota.to' }] };
  const fetchWith = (record: { status: number; body: unknown }) =>
    vi.fn(async (url: string) => (url.startsWith('https://plc.directory/') ? new Response(JSON.stringify(doc)) : new Response(JSON.stringify(record.body), { status: record.status }))) as unknown as typeof fetch;

  it('reads anyone\'s settings from the PDS their DID document names', async () => {
    const f = fetchWith({ status: 200, body: { value: { poe: { show: true, side: 'left', scale: 100 }, widgets: [], createdAt: '2026-10-01T00:00:00Z' } } });
    const saved = await readPublicConfig(STREAMER, f);
    expect(saved?.config.poe.side).toBe('left');
    expect(saved?.createdAt).toBe('2026-10-01T00:00:00Z');
    expect(String((f as unknown as { mock: { calls: string[][] } }).mock.calls[1]![0])).toBe(`https://pds.atpota.to/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(STREAMER)}&collection=to.atpota.poe.overlay&rkey=self`);
  });

  it('is null without a record, and undefined when it cannot be read', async () => {
    expect(await readPublicConfig(STREAMER, fetchWith({ status: 400, body: { error: 'RecordNotFound' } }))).toBeNull();
    expect(await readPublicConfig(STREAMER, fetchWith({ status: 500, body: {} }))).toBeUndefined();
    expect(await readPublicConfig('did:nope:x', fetchWith({ status: 200, body: {} }))).toBeUndefined();
    expect(pdsOf({ ...doc, service: [{ ...doc.service[0], serviceEndpoint: 'http://insecure.example' }] }, STREAMER)).toBeNull();
    expect(didDocumentUrl('did:web:example.com')).toBe('https://example.com/.well-known/did.json');
  });
});

describe('poe facing right', () => {
  it('mirrors every part but the tummy @, which moves over and still reads right', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 515 419"><path fill="#39b54a" d="M1"/><path fill="#a58650" d="M2"/><path fill="#725b36" d="M3"/><path fill="#a58650" d="M4"/></svg>';
    const out = new DOMParser().parseFromString(mirrorSvg(svg), 'image/svg+xml').documentElement;
    const [mirrored, at] = [...out.children];
    expect(mirrored!.getAttribute('transform')).toBe('matrix(-1 0 0 1 515 0)');
    expect([...mirrored!.children].map((p) => p.getAttribute('d'))).toEqual(['M1', 'M2', 'M3']);
    expect(at!.getAttribute('transform')).toBe(`translate(${(VIEW_WIDTH - 2 * AT_CENTER_X).toFixed(1)} 0)`);
    expect([...at!.children].map((p) => p.getAttribute('d'))).toEqual(['M4']);
  });

  it('mirrors a drawing without a face whole (the arm)', () => {
    const out = mirrorSvg('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#39b54a" d="M1"/></svg>');
    expect(out).toContain('matrix(-1 0 0 1 515 0)');
    expect(out).not.toContain('translate(');
  });
});

describe('the layout', () => {
  it('puts each widget in its slot at its size, hides the rest, and sets Poe\'s corner', () => {
    document.body.innerHTML = read('../overlay/index.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    const layout = createLayout(document);
    const shown = layout.apply({ ...DEFAULT_CONFIG, poe: { show: true, side: 'left', scale: 150 }, widgets: [{ kind: 'apps', slot: 'top-right', scale: 80 }, { kind: 'badge', slot: 'top-right', scale: 100 }] });
    expect([...shown]).toEqual(['apps', 'badge']);
    const slot = document.querySelector<HTMLElement>('[data-ov-slot="top-right"]')!;
    expect([...slot.children].map((c) => (c as HTMLElement).dataset.ovWidget)).toEqual(['apps', 'badge']);
    expect(slot.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-ov-slot="top-left"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-ov-widget="card"]')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-ov-widget="apps"]')!.style.getPropertyValue('zoom')).toBe('0.8');
    expect(document.body.dataset.side).toBe('left');
    expect(document.documentElement.style.getPropertyValue('--ov-poe-width')).toBe('450px');
  });
});

describe('visitors', () => {
  it('come by day or by night as they would on the hill', () => {
    expect(visitorsFor(new Date(2026, 9, 21, 23))).toContain('moth');
    expect(visitorsFor(new Date(2026, 9, 21, 12))).not.toContain('moth');
    expect(visitorsFor(new Date(2026, 9, 21, 12))).toContain('butterfly');
  });

  it('follow a path from start to end, from the side facing into the screen', () => {
    for (const kind of VISITOR_KINDS) {
      const { steps, visit } = pathFor(kind, 300, () => 0.5);
      expect(steps[0]!.at).toBe(0);
      expect(steps[steps.length - 1]!.at).toBe(1);
      for (let i = 1; i < steps.length; i++) expect(steps[i]!.at).toBeGreaterThanOrEqual(steps[i - 1]!.at);
      expect(visit.notice).toBeLessThan(visit.ms);
    }
    // into the screen is to the left of a right-hand Poe, and to the right of a left-hand one
    expect(place({ x: 600, y: 0, face: -1, at: 0 }, 300, 'right', 40)).toBe('translate(-320.0px, 0.0px) scaleX(1)');
    expect(place({ x: 600, y: 0, face: -1, at: 0 }, 300, 'left', 40)).toBe('translate(580.0px, 0.0px) scaleX(-1)');
  });

  it('visit, and Poe notices', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-ov-poe></div>';
    const corner = document.querySelector<HTMLElement>('[data-ov-poe]')!;
    const react = vi.fn();
    const v = createVisitors({ corner, react, side: 'right', scale: 1, now: () => new Date(2026, 9, 21, 12) });
    v.visit('worm');
    expect(corner.querySelector('.ov-visit--worm')).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(react).toHaveBeenCalledWith('happy', 3500);
    vi.advanceTimersByTime(10_000);
    expect(corner.querySelector('.ov-visit--worm')).toBeNull();
    v.setEnabled(false);
    expect(corner.querySelector<HTMLElement>('.ov-visitors')!.hidden).toBe(true);
    vi.useRealTimers();
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
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER, text: 'hi' }), STREAMER)).toEqual({ kind: 'chat', did: 'did:plc:a', rkey: '3m4abc', text: 'hi', command: null });
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER, text: '!pet' }), STREAMER)).toEqual({ kind: 'chat', did: 'did:plc:a', rkey: '3m4abc', text: '!pet', command: 'pet' });
    expect(eventFor(commit('did:plc:a', FOLLOW, { subject: STREAMER }), STREAMER)).toEqual({ kind: 'follow', did: 'did:plc:a' });
  });

  it("drops other streams, other people's follows, deletes and anything odd", () => {
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: 'did:plc:other', text: 'hi' }), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', FOLLOW, { subject: 'did:plc:other' }), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, FOLLOW, { subject: STREAMER }), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', FOLLOW, { subject: STREAMER }, 'delete'), STREAMER)).toBeNull();
    expect(eventFor(commit('did:plc:a', CHAT, { streamer: STREAMER }), STREAMER)).toBeNull();
    expect(eventFor({ kind: 'identity', did: 'did:plc:a' }, STREAMER)).toBeNull();
    expect(eventFor('nope', STREAMER)).toBeNull();
  });

  it('hears chat taken back, messages the streamer hides, and changes to their own records', () => {
    expect(eventFor({ kind: 'commit', did: 'did:plc:a', commit: { operation: 'delete', collection: CHAT, rkey: 'm1' } }, STREAMER)).toEqual({ kind: 'unchat', did: 'did:plc:a', rkey: 'm1' });
    expect(eventFor(commit(STREAMER, GATE, { hiddenMessage: 'at://did:plc:a/place.stream.chat.message/m1' }), STREAMER)).toEqual({ kind: 'hide', did: 'did:plc:a', rkey: 'm1' });
    // only the streamer hides messages in their chat
    expect(eventFor(commit('did:plc:other', GATE, { hiddenMessage: 'at://did:plc:a/place.stream.chat.message/m1' }), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, GATE, { hiddenMessage: 'at://did:plc:a/app.bsky.feed.post/m1' }), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, 'im.flushing.right.now', { text: 'x', emoji: 'y' }), STREAMER)).toEqual({ kind: 'record', collection: 'im.flushing.right.now' });
    expect(eventFor({ kind: 'commit', did: STREAMER, commit: { operation: 'delete', collection: 'fm.teal.feed.play', rkey: 'p' } }, STREAMER)).toEqual({ kind: 'record', collection: 'fm.teal.feed.play' });
    expect(eventFor(commit('did:plc:other', 'im.flushing.right.now', { text: 'x', emoji: 'y' }), STREAMER)).toBeNull();
  });

  it("hears the streamer's stream start and end, and nobody else's", () => {
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: ' potatoes all day ', createdAt: 'x' }, 'create', 'r1'), STREAMER)).toEqual({ kind: 'live', rkey: 'r1', title: 'potatoes all day' });
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: '' }, 'create', 'r1'), STREAMER)).toEqual({ kind: 'live', rkey: 'r1', title: null });
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: 'x', lastSeenAt: 'y' }, 'update', 'r1'), STREAMER)).toBeNull();
    expect(eventFor(commit(STREAMER, LIVESTREAM, { title: 'x', endedAt: 'z' }, 'update', 'r1'), STREAMER)).toEqual({ kind: 'ended', rkey: 'r1' });
    expect(eventFor(commit('did:plc:other', LIVESTREAM, { title: 'x' }), STREAMER)).toBeNull();
  });

  it('asks Jetstream for chat, streams and overlay settings, and follows only when wanted', () => {
    const both = new URL(jetstreamUrl('wss://j.example/subscribe', true, 42));
    expect(both.searchParams.getAll('wantedCollections')).toEqual([CHAT, LIVESTREAM, OVERLAY, SCENE, GATE, ...RECORD_COLLECTIONS, FOLLOW]);
    expect(both.searchParams.get('cursor')).toBe('42');
    expect(new URL(jetstreamUrl('wss://j.example/subscribe', false)).searchParams.getAll('wantedCollections')).toEqual([CHAT, LIVESTREAM, OVERLAY, SCENE, GATE, ...RECORD_COLLECTIONS]);
  });

  it("hears the streamer's own saved settings, and nobody else's", () => {
    const value = { poe: { show: true, side: 'left', scale: 100 } };
    expect(eventFor(commit(STREAMER, OVERLAY, value, 'update', 'self'), STREAMER)).toEqual({ kind: 'config', rkey: 'self', value });
    expect(eventFor(commit(STREAMER, OVERLAY, value, 'create', 'self'), STREAMER)).toEqual({ kind: 'config', rkey: 'self', value });
    expect(eventFor(commit('did:plc:other', OVERLAY, value, 'update', 'self'), STREAMER)).toBeNull();
    // another of their layouts: the overlay showing that one follows it (index.ts)
    expect(eventFor(commit(STREAMER, OVERLAY, value, 'update', 'other'), STREAMER)).toEqual({ kind: 'config', rkey: 'other', value });
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
    expect(events).toEqual([{ kind: 'chat', did: 'did:plc:a', rkey: '3m4abc', text: 'hi', command: null }]);
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
  const page = () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    document.body.innerHTML = read('../overlay/setup.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    return document.querySelector<HTMLElement>('[data-ovs]')!;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('puts a config in the form and reads the same one back', () => {
    page();
    const form = document.querySelector<HTMLFormElement>('[data-ovs-form]')!;
    buildAllWidgetRows(form);
    const c: OverlayConfig = { ...DEFAULT_CONFIG, poe: { show: true, side: 'left', scale: 120 }, widgets: [{ kind: 'card', slot: 'top-right', scale: 90 }, { kind: 'strip', slot: 'top-center', scale: 100 }], follows: false, ignore: ['bot.bsky.social'], volume: 0, nap: 10, theme: 'dark' };
    fillForm(form, c);
    expect(configFrom(form)).toEqual(c);
  });

  it("can't be used without signing in", async () => {
    const root = page();
    await initSetup({ auth: null });
    expect(root.dataset.state).toBe('unavailable');
    const again = page();
    await initSetup({ auth: { eager: false } as never });
    expect(again.dataset.state).toBe('signed-out');
    expect(document.querySelector<HTMLElement>('[data-ovs-editor]')!.hidden).toBe(true);
  });

  it('opens the preview full screen, and closes it with the button, a tap or Escape', async () => {
    page();
    await initSetup({ auth: null });
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
    for (const hook of ['data-ov-widget="card"', 'data-ov-widget="strip"', 'data-ov-widget="badge"', 'data-ov-widget="apps"', 'data-ov-widget="forecast"', 'data-ov-widget="pulse"', 'data-ov-slot="top-left"', 'data-weather-records', 'data-weather-cond', 'data-weather-spark', 'data-weather-sky', 'data-weather-index', 'data-ov-app', 'data-ov-poe']) expect(html).toContain(hook);
  });

  it('has a setup page, built and wired to its page module', () => {
    expect(read('../vite.config.ts')).toContain("overlaySetup: r('./overlay/setup.html')");
    expect(read('../overlay/setup.html')).toContain('<body data-page="overlay-setup">');
    expect(read('../src/scripts/main.ts')).toContain("'overlay-setup': () => import('../overlay/setup')");
  });
});
