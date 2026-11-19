// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanWidgets, fromRecord, styleFor, toRecord, WIDGET_KINDS, WIDGET_STYLES } from '../src/overlay/config.js';
import { createLayout } from '../src/overlay/layout.js';
import { DEMO_CHAT, hueOf, KEEP, mountOnscreenChat, POP_FADE_MS, POP_MS } from '../src/overlay/onscreen.js';
import { readParams, readWidgets, toSearch, writeWidgets } from '../src/overlay/params.js';
import {
  activityOf,
  agoText,
  coverUrl,
  drawFlushes,
  drawMusic,
  drawStatus,
  flushesOf,
  flushStats,
  line,
  mountRecords,
  musicStats,
  nowPlaying,
  playOf,
  playsFrom,
  vitalsOf,
} from '../src/overlay/records.js';
import { fromSceneRecord, SCENE_DEFAULTS, SCENE_KINDS } from '../src/overlay/scenes.js';
import { buildAllWidgetRows, configFrom, fillForm } from '../src/overlay/setup.js';
import { createTidClock, mountTid, readTid, s32, tidAt, tidTimeText } from '../src/overlay/tid.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const page = () => {
  document.documentElement.innerHTML = read('../overlay/index.html').replace(/^<!DOCTYPE html>/i, '');
  return document;
};
const rec = (rkey: string, value: Record<string, unknown>) => ({ uri: `at://did:plc:me/x/${rkey}`, rkey, value });
const NOW = new Date(2026, 9, 22, 15, 0, 0).getTime();
const hours = (n: number) => NOW - n * 3_600_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('the TID clock', () => {
  it('writes and reads TIDs as atproto does', () => {
    expect(s32(0, 2)).toBe('22');
    expect(s32(31, 2)).toBe('2z');
    const tid = tidAt(1_700_000_000_000_000, 0);
    expect(tid).toBe('3ke6kg3wk2222');
    // a real record key, made by a teal.fm scrobbler for a play at 10:39:18Z
    expect(Math.abs(readTid('3myhhwwuq3zmw')!.us / 1000 - Date.parse('2026-10-22T10:39:18Z'))).toBeLessThan(5 * 60_000);
    expect(readTid(tid)).toEqual({ us: 1_700_000_000_000_000, clock: 0 });
    expect(readTid(tidAt(1_700_000_000_123_456, 1023))).toEqual({ us: 1_700_000_000_123_456, clock: 1023 });
    expect(readTid('nope')).toBeNull();
    expect(readTid('zzzzzzzzzzzzz')).toBeNull();
  });

  it('never says the same TID twice, and sorts in time', () => {
    const next = createTidClock(() => 1_700_000_000_000_000, 7);
    const a = next();
    const b = next();
    expect(b.us).toBe(a.us + 1);
    expect(b.tid > a.tid).toBe(true);
  });

  it('says the time to the microsecond', () => {
    const us = new Date(2026, 9, 22, 14, 3, 12).getTime() * 1000 + 345_678;
    expect(tidTimeText(us)).toBe('14:03:12.345678');
  });

  it('ticks every display on the page, one span a character, glowing the ones that changed', () => {
    vi.useFakeTimers();
    const doc = page();
    let us = 1_700_000_000_000_000;
    doc.querySelector<HTMLElement>('[data-ov-widget="tid"]')!.hidden = false;
    const clock = mountTid(doc, { next: () => ({ tid: tidAt((us += 1), 5), us }) });
    const tid = doc.querySelector<HTMLElement>('[data-ov-widget="tid"] [data-ov-tid]')!;
    expect(tid.children).toHaveLength(13);
    expect(tid.getAttribute('aria-label')).toBe(tidAt(1_700_000_000_000_001, 5));
    clock.tick();
    expect(tid.textContent).toBe(tidAt(1_700_000_000_000_002, 5));
    expect(tid.querySelectorAll('.is-new')).toHaveLength(1);
    expect(doc.querySelector('[data-ov-widget="tid"] [data-ov-tid-time]')!.textContent).toBe(tidTimeText(1_700_000_000_000_002));
  });
});

describe('widget styles', () => {
  it('every styled kind has a default, and only those kinds carry a style', () => {
    for (const kind of WIDGET_KINDS) {
      const styles = WIDGET_STYLES[kind];
      expect(styleFor(kind, 'nope')).toBe(styles ? Object.keys(styles)[0] : undefined);
    }
    expect(cleanWidgets([{ kind: 'card', slot: 'top-left', scale: 100, style: 'side' }])).toEqual([{ kind: 'card', slot: 'top-left', scale: 100 }]);
    expect(cleanWidgets([{ kind: 'music', slot: 'top-left', scale: 100, style: 'history' }])).toEqual([{ kind: 'music', slot: 'top-left', scale: 100, style: 'history' }]);
    expect(cleanWidgets([{ kind: 'music', slot: 'top-left', scale: 100, style: 'toString' }])[0]!.style).toBe('now');
  });

  it('puts the chat strip on a side, the right unless its slot is on the left', () => {
    expect(cleanWidgets([{ kind: 'chat', slot: 'bottom-left', scale: 100, style: 'side' }])[0]!.slot).toBe('top-left');
    expect(cleanWidgets([{ kind: 'chat', slot: 'bottom-center', scale: 100, style: 'side' }])[0]!.slot).toBe('top-right');
    expect(cleanWidgets([{ kind: 'chat', slot: 'bottom-left', scale: 100, style: 'pop' }])[0]!.slot).toBe('bottom-left');
  });

  it('round-trips through the record and the address, leaving default styles out of it', () => {
    const widgets = cleanWidgets([
      { kind: 'tid', slot: 'top-center', scale: 100, style: 'mini' },
      { kind: 'flushes', slot: 'top-left', scale: 90 },
      { kind: 'chat', slot: 'top-right', scale: 100, style: 'side' },
    ]);
    expect(writeWidgets(widgets)).toBe('tid:tc:100:mini,flushes:tl:90,chat:tr:100:side');
    expect(readWidgets(writeWidgets(widgets))).toEqual(widgets);
    const c = { ...fromRecord({}), widgets };
    expect(fromRecord(toRecord(c, '2026-01-01T00:00:00.000Z', new Date())).widgets).toEqual(widgets);
    expect(readParams(toSearch(c, { demo: true, who: 'dame.is' }))).toMatchObject({ demo: true, who: 'dame.is' });
  });

  it('the layout marks each widget with its style', () => {
    const doc = page();
    const layout = createLayout(doc);
    const shown = layout.apply({ ...fromRecord({}), widgets: cleanWidgets([{ kind: 'music', slot: 'bottom-left', scale: 100, style: 'mini' }, { kind: 'card', slot: 'top-left', scale: 100 }]) });
    expect([...shown]).toEqual(['music', 'card']);
    const music = doc.querySelector<HTMLElement>('[data-ov-widget="music"]')!;
    expect(music.dataset.style).toBe('mini');
    expect(music.parentElement!.dataset.ovSlot).toBe('bottom-left');
    expect(doc.querySelector<HTMLElement>('[data-ov-widget="card"]')!.dataset.style).toBeUndefined();
  });

  it('the setup form has a style for the kinds that have them, and keeps it', () => {
    document.body.innerHTML = read('../overlay/setup.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    const form = document.querySelector<HTMLFormElement>('[data-ovs-form]')!;
    buildAllWidgetRows(form);
    for (const kind of ['tid', 'flushes', 'status', 'music', 'chat']) expect(form.querySelector(`select[name="style-${kind}"]`)).not.toBeNull();
    expect(form.querySelector('select[name="style-card"]')).toBeNull();
    const c = { ...fromRecord({}), widgets: cleanWidgets([{ kind: 'music', slot: 'bottom-left', scale: 100, style: 'stats' }, { kind: 'chat', slot: 'top-left', scale: 100, style: 'side' }]) };
    fillForm(form, c);
    expect(configFrom(form).widgets).toEqual(c.widgets);
  });
});

describe('the TID waiting screen', () => {
  it('is a screen everyone starts with', () => {
    expect(SCENE_KINDS).toContain('clock');
    expect(fromSceneRecord('starting', { kind: 'clock' }).title).toBe(SCENE_DEFAULTS.clock.title);
  });
});

describe('flushes', () => {
  it('counts them, the streak, today, the week and the favourite', () => {
    const flushes = flushesOf([
      rec('a', { emoji: '🚽', text: 'one', createdAt: new Date(hours(1)).toISOString() }),
      rec('b', { emoji: '🧻', text: 'two', createdAt: new Date(hours(26)).toISOString() }),
      rec('c', { emoji: '🚽', text: 'three', createdAt: new Date(hours(50)).toISOString() }),
      rec('d', { emoji: '🚽', text: 'old', createdAt: new Date(hours(24 * 10)).toISOString() }),
      rec('e', { emoji: '🚽', text: 'no date' }),
    ]);
    const s = flushStats(flushes, NOW);
    expect(s).toMatchObject({ total: 4, today: 1, week: 3, streak: 3, top: '🚽' });
    expect(s.latest!.text).toBe('one');
    // nothing yet today: the streak runs to yesterday
    expect(flushStats(flushes.slice(1), NOW).streak).toBe(2);
  });

  it('draws the count, with + when it stopped counting', () => {
    const doc = page();
    const el = doc.querySelector<HTMLElement>('[data-ov-widget="flushes"]')!;
    drawFlushes(el, { total: 2000, capped: true, today: 2, week: 9, streak: 1, top: '🧻', latest: { emoji: '🧻', text: '<b>hi</b>', at: hours(2) } }, NOW);
    expect(el.querySelector('[data-ov-fl-total]')!.textContent).toBe('2,000+');
    expect(el.querySelector('[data-ov-fl-streak]')!.textContent).toBe('1 day');
    expect(el.querySelector('[data-ov-fl-text]')!.innerHTML).toBe('&lt;b&gt;hi&lt;/b&gt;');
    expect(el.dataset.state).toBe('ready');
  });
});

describe('status and vitals', () => {
  it("coerces a phone's strings, and a 0 is no reading", () => {
    const v = vitalsOf(rec('s', { heartRate: '59', physicalActivity: 'Stationary', isCharging: 'false', soundLevel: 0, batteryLevel: 160, caloriesBurned: 45, capturedAt: '2026-10-22T09:00:03-04:00' }))!;
    expect(v).toMatchObject({ heartRate: 59, activity: 'still', charging: false, sound: null, battery: 100, calories: 45 });
    expect(vitalsOf(rec('s', { heartRate: 0 }))).toBeNull();
    expect(activityOf('In a moving vehicle')).toBe('in a vehicle');
  });

  it('draws the status as dame.is does, and leaves out vitals it has no reading for', () => {
    const doc = page();
    const el = doc.querySelector<HTMLElement>('[data-ov-widget="status"]')!;
    drawStatus(el, 'dame.is', { text: 'streaming', at: hours(1) }, { heartRate: 70, activity: null, battery: 50, charging: true, sound: null, calories: null, at: hours(0.1) }, NOW);
    expect(el.querySelector('.ov-status__line')!.textContent).toBe('dame.is streaming');
    expect(el.querySelector<HTMLElement>('[data-ov-vital="doing"]')!.hidden).toBe(true);
    expect(el.querySelector('[data-ov-vital="battery"] dd')!.textContent).toBe('50%, charging');
  });
});

describe('teal.fm', () => {
  const play = (rkey: string, h: number, extra: Record<string, unknown> = {}) =>
    rec(rkey, { trackName: `t${rkey}`, artists: [{ artistName: 'Magdalena Bay' }], playedTime: new Date(hours(h)).toISOString(), releaseMbId: 'mbid:24e93d85-dc05-4cbd-8da4-753885218550', ...extra });

  it('reads either namespace and spelling, one play per record key, production first', () => {
    expect(playOf({ trackName: 'x', artistNames: ['a', 'b'] })!.artist).toBe('a, b');
    expect(playOf({ artist: 'x' })).toBeNull();
    const plays = playsFrom([[play('1', 1)], [play('1', 1, { trackName: 'alpha' }), play('2', 3)]]);
    expect(plays.map((p) => p.track)).toEqual(['t1', 't2']);
    expect(plays[0]!.releaseMbId).toBe('24e93d85-dc05-4cbd-8da4-753885218550');
    expect(coverUrl(plays[0]!.releaseMbId)).toBe('https://coverartarchive.org/release/24e93d85-dc05-4cbd-8da4-753885218550/front-250');
    expect(coverUrl('../evil')).toBeNull();
  });

  it("is playing until the status expires, or ten minutes without an expiry", () => {
    const item = { trackName: 'now', artists: [{ artistName: 'a' }] };
    expect(nowPlaying([{ item, time: new Date(NOW - 60_000).toISOString(), expiry: new Date(NOW + 60_000).toISOString() }], NOW)!.track).toBe('now');
    expect(nowPlaying([{ item, time: new Date(NOW - 11 * 60_000).toISOString() }], NOW)).toBeNull();
    expect(nowPlaying([null, undefined, { item, time: new Date(NOW - 60_000).toISOString(), expiry: new Date(NOW - 1).toISOString() }], NOW)).toBeNull();
  });

  it('adds up today and the week', () => {
    const plays = playsFrom([[play('1', 1), play('2', 2, { trackName: 't1' }), play('3', 30, { artists: [{ artistName: 'Kelela' }] }), play('4', 24 * 9)]]);
    expect(musicStats(plays, NOW)).toEqual({ today: 2, week: 3, topArtist: 'Magdalena Bay', topTrack: 't1 · Magdalena Bay' });
  });

  it('draws the last play when nothing is playing, and history newest first', () => {
    const doc = page();
    const el = doc.querySelector<HTMLElement>('[data-ov-widget="music"]')!;
    drawMusic(el, null, playsFrom([[play('1', 1), play('2', 2)]]), NOW);
    expect(el.querySelector('[data-ov-mu-title]')!.textContent).toBe('last played');
    expect(el.querySelector('[data-ov-mu-when]')!.textContent).toBe('1 hr ago');
    expect([...el.querySelectorAll('.ov-music__h-track')].map((x) => x.textContent)).toEqual(['t1', 't2']);
    expect(el.dataset.live).toBe('no');
  });

  it('reads only while on screen, from the streamer\'s PDS', async () => {
    const doc = page();
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      if (String(u).startsWith('https://plc.directory/')) return new Response(JSON.stringify({ id: 'did:plc:me', service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] }), { status: 200 });
      if (String(u).includes('listRecords')) return new Response(JSON.stringify({ records: [{ uri: 'at://did:plc:me/im.flushing.right.now/3m', value: { emoji: '🚽', text: 'hi', createdAt: new Date(NOW).toISOString() } }] }), { status: 200 });
      return new Response('{}', { status: 400 });
    }) as unknown as typeof fetch;
    const records = mountRecords(doc, { fetchImpl, now: () => NOW });
    records.setWho('did:plc:me', 'me.example');
    expect(urls).toEqual([]);
    records.showing(new Set(['flushes']));
    await vi.waitFor(() => expect(doc.querySelector<HTMLElement>('[data-ov-widget="flushes"]')!.dataset.state).toBe('ready'));
    expect(urls.every((u) => !u.includes('fm.teal'))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://pds.example/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Ame&collection=im.flushing.right.now'))).toBe(true);
  });
});

describe('the chat on screen', () => {
  const setup = () => {
    vi.useFakeTimers();
    const doc = page();
    const el = doc.querySelector<HTMLElement>('[data-ov-widget="chat"]')!;
    return { el, chat: mountOnscreenChat(el, { fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch }) };
  };
  const who = (handle: string) => ({ handle, avatar: null });

  it("shows other people's words as text only, once each", () => {
    const { el, chat } = setup();
    expect(el.dataset.state).toBe('empty');
    chat.add({ did: 'did:plc:a', rkey: '1', text: '<img src=x onerror=alert(1)>\nhi' }, who('@a.test'));
    chat.add({ did: 'did:plc:a', rkey: '1', text: 'again' }, who('@a.test'));
    chat.add({ did: 'did:plc:b', rkey: '2', text: '   ' }, who('@b.test'));
    const msgs = el.querySelectorAll('.ov-chat__msg');
    expect(msgs).toHaveLength(1);
    expect(el.querySelector('img:not(.ov-chat__avatar)')).toBeNull();
    expect(msgs[0]!.querySelector('.ov-chat__text')!.textContent).toBe('<img src=x onerror=alert(1)> hi');
    expect(msgs[0]!.querySelector('.ov-chat__who')!.textContent).toBe('@a.test');
    expect(el.dataset.state).toBe('ready');
  });

  it('takes away what was deleted or hidden, and what the streamer ignores', () => {
    const { el, chat } = setup();
    chat.add({ did: 'did:plc:a', rkey: '1', text: 'one' }, who('@a'));
    chat.add({ did: 'did:plc:b', rkey: '2', text: 'two' }, who('@b'));
    chat.add({ did: 'did:plc:c', rkey: '3', text: 'three' }, who('@c'));
    chat.remove('did:plc:a', '1');
    chat.remove('did:plc:b', '2', true);
    chat.add({ did: 'did:plc:b', rkey: '2', text: 'two' }, who('@b'));
    chat.setSkip(new Set(['did:plc:c']));
    chat.add({ did: 'did:plc:c', rkey: '4', text: 'four' }, who('@c'));
    expect(el.querySelectorAll('.ov-chat__msg')).toHaveLength(0);
    expect(el.dataset.state).toBe('empty');
  });

  it('keeps the last KEEP, and pops each one away after POP_MS', () => {
    const { el, chat } = setup();
    for (let i = 0; i < KEEP + 5; i++) chat.add({ did: 'did:plc:a', rkey: String(i), text: `m${i}` }, who('@a'));
    expect(el.querySelectorAll('.ov-chat__msg')).toHaveLength(KEEP);
    expect(el.querySelector('.ov-chat__text')!.textContent).toBe('m5');
    vi.advanceTimersByTime(POP_MS + POP_FADE_MS);
    expect(el.querySelectorAll('.is-gone')).toHaveLength(KEEP);
  });

  it('gives everyone the same colour every time, and has examples for the preview', () => {
    expect(hueOf('did:plc:a')).toBe(hueOf('did:plc:a'));
    const { el, chat } = setup();
    chat.demo(true);
    expect(el.querySelectorAll('.ov-chat__msg')).toHaveLength(2);
    expect(el.querySelector('.ov-chat__who')!.textContent).toBe(`@${DEMO_CHAT[0]![0]}`);
    chat.demo(false);
  });
});

describe('words', () => {
  it('keeps one line, cut short', () => {
    expect(line('a b\n\tc', 10)).toBe('a b c');
    expect(line('abcdef', 3)).toBe('abc');
    expect(line(42, 3)).toBe('');
    expect(agoText(NOW - 30_000, NOW)).toBe('just now');
    expect(agoText(hours(30), NOW)).toBe('yesterday');
  });
});
