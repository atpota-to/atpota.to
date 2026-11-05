// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventFor, jetstreamUrl, SCENE } from '../src/overlay/chat.js';
import { mountScene, DONE_TEXT } from '../src/overlay/scene-view.js';
import {
  CANVAS,
  countdownText,
  frameHoles,
  framePath,
  fromSceneRecord,
  isScreenId,
  newScreenId,
  readSceneParams,
  SCENE_DEFAULTS,
  SCENE_KINDS,
  SCENE_NSID,
  sceneSearch,
  toSceneRecord,
  withSceneOverrides,
  type Scene,
} from '../src/overlay/scenes.js';
import { fillSceneForm, holeLines, localInput, sceneFrom } from '../src/overlay/setup-scenes.js';
import { DEFAULT_CONFIG } from '../src/overlay/config.js';
import { columnZoom, createLayout, FILL_MAX, squeezeStack, tileRow } from '../src/overlay/layout.js';
import { readFrameWidgets, SCREEN_SIZES, SCREENS, writeFrameWidgets } from '../src/overlay/scenes.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';
const bodyOf = (file: string) => read(file).split('<body')[1]!.replace(/^[^>]*>/, '');

describe('scenes', () => {
  it('each start from defaults that read well', () => {
    expect(SCENE_DEFAULTS.starting).toMatchObject({ title: 'starting soon', countdown: { mode: 'timer', minutes: 5 } });
    expect(SCENE_DEFAULTS.brb.title).toBe('be right back');
    expect(SCENE_DEFAULTS.ending.title).toBe('thanks for watching');
    expect(SCENE_DEFAULTS.screenshare.camera).toEqual({ side: 'right', shape: 'rounded' });
  });

  it('keep what checks out of a record, as one line of words at most so long', () => {
    const s = fromSceneRecord('ending', { title: '  see\nya  ', subtitle: 'x'.repeat(500), background: 'lava', showPoe: false, links: ['bsky.app/profile/dame.is', 7, '', 'a', 'b', 'c', 'd'] });
    expect(s.title).toBe('see ya');
    expect(s.subtitle).toHaveLength(200);
    expect(s.background).toBe(SCENE_DEFAULTS.ending.background);
    expect(s.showPoe).toBe(false);
    expect(s.links).toEqual(['bsky.app/profile/dame.is', 'a', 'b', 'c']);
    expect(fromSceneRecord('brb', 'junk')).toEqual(SCENE_DEFAULTS.brb);
    expect(fromSceneRecord('starting', { countdown: { mode: 'clock', at: 'not a date', minutes: 999 } }).countdown).toEqual({ mode: 'clock', minutes: 5, at: null });
  });

  it("save a record with the lexicon's required fields, that reads back the same", () => {
    const lexicon = JSON.parse(read('../lexicons/to/atpota/poe/scene.json'));
    expect(lexicon.id).toBe(SCENE_NSID);
    expect(lexicon.defs.main.key).toBe('any');
    for (const kind of SCENE_KINDS) {
      const record = toSceneRecord(SCENE_DEFAULTS[kind], '2026-10-21T00:00:00.000Z', new Date('2026-10-22T00:00:00Z'));
      for (const field of lexicon.defs.main.record.required) expect(record).toHaveProperty(field);
      expect(fromSceneRecord(kind, record)).toEqual(SCENE_DEFAULTS[kind]);
    }
    expect(lexicon.defs.main.record.properties.background.knownValues).toEqual(['day', 'night', 'garden', 'butter']);
  });

  it('go in the URL and come back the same, for the preview', () => {
    const s: Scene = { ...SCENE_DEFAULTS.starting, title: 'soon & soon', subtitle: 'a|b', background: 'night', showPoe: false, showWidgets: true, countdown: { mode: 'clock', minutes: 5, at: '2026-10-22T18:00:00.000Z' } };
    const back = readSceneParams(`?${sceneSearch(s)}`);
    expect(back.kind).toBe('starting');
    expect(withSceneOverrides(SCENE_DEFAULTS.starting, back.overrides)).toEqual(s);
    const e: Scene = { ...SCENE_DEFAULTS.ending, links: ['bsky.app/profile/dame.is', 'atpota.to'] };
    expect(withSceneOverrides(SCENE_DEFAULTS.ending, readSceneParams(`?${sceneSearch(e)}`).overrides)).toEqual(e);
    const sh: Scene = { ...SCENE_DEFAULTS.screenshare, camera: { side: 'left', shape: 'circle' } };
    expect(withSceneOverrides(SCENE_DEFAULTS.screenshare, readSceneParams(`?${sceneSearch(sh)}`).overrides)).toEqual(sh);
    expect(readSceneParams('?scene=party').kind).toBeNull();
  });

  it("put the screen share's windows on the canvas, beside each other, inside it", () => {
    for (const size of SCREEN_SIZES)
    for (const side of ['right', 'left', 'none'] as const) {
      for (const shape of ['rounded', 'circle', 'wide'] as const) {
        const h = frameHoles({ side, shape }, size);
        expect(h.screen).toMatchObject(SCREENS[size]);
        expect(h.screen.w / h.screen.h).toBeCloseTo(16 / 9);
        for (const r of [h.screen, h.camera, h.below, h.column].filter(Boolean)) {
          expect(r!.x).toBeGreaterThanOrEqual(0);
          expect(r!.y).toBeGreaterThanOrEqual(0);
          expect(r!.x + r!.w).toBeLessThanOrEqual(CANVAS.w);
          expect(r!.y + r!.h).toBeLessThanOrEqual(CANVAS.h);
        }
        if (h.camera) {
          const apart = h.camera.x >= h.screen.x + h.screen.w || h.camera.x + h.camera.w <= h.screen.x;
          expect(apart).toBe(true);
          expect(h.column.y).toBeGreaterThan(h.camera.y + h.camera.h);
          expect(h.camera.w / h.camera.h).toBeCloseTo(shape === 'wide' ? 16 / 9 : 1, 1);
        } else expect(side).toBe('none');
      }
    }
    expect(frameHoles({ side: 'right', shape: 'rounded' })).toMatchObject({ screen: { x: 40, y: 40, w: 1440, h: 810 }, camera: { x: 1520, y: 40, w: 360, h: 360 }, below: { x: 40, y: 880, w: 1440, h: 160 } });
    // a smaller screen leaves a wider column; the camera stays a sensible size in the middle of it
    expect(frameHoles({ side: 'right', shape: 'rounded' }, 'small')).toMatchObject({ screen: { w: 1120, h: 630 }, camera: { x: 1320, w: 440, h: 440 }, column: { x: 1320, w: 440 } });
    // without a camera the column is the whole room beside the screen
    expect(frameHoles({ side: 'none', shape: 'rounded' }, 'small').column).toMatchObject({ x: 1200, y: 40, w: 680 });
    expect(frameHoles({ side: 'left', shape: 'rounded' }).camera!.x).toBe(40);
    const path = framePath(frameHoles({ side: 'right', shape: 'circle' }), 'circle');
    expect(path.startsWith('M0,0H1920V1080H0Z')).toBe(true);
    expect(path.match(/Z/g)).toHaveLength(3);
    expect(path).toContain('A180,180');
  });

  it("keep the screen share's frame: its size, its bar, the wordmark, and its own widgets", () => {
    // a record from before the frame was a choice looks as it always did
    const old = fromSceneRecord('screenshare', { kind: 'screenshare', title: 'hi', camera: { side: 'left', shape: 'circle' } });
    expect(old.showMark).toBe(true);
    expect(old.frame).toEqual({ size: 'big', words: true, widgets: [{ kind: 'badge', place: 'beside', scale: 100 }] });
    const s: Scene = {
      ...SCENE_DEFAULTS.screenshare,
      showMark: false,
      frame: { size: 'medium', words: false, widgets: [{ kind: 'strip', place: 'below', scale: 100 }, { kind: 'music', place: 'beside', scale: 80, style: 'history' }] },
    };
    const rec = toSceneRecord(s, '2026-10-01T00:00:00.000Z', new Date());
    expect(rec).toMatchObject({ showMark: false, frame: { size: 'medium', words: false } });
    expect(fromSceneRecord('screenshare', rec)).toEqual(s);
    expect(withSceneOverrides(SCENE_DEFAULTS.screenshare, readSceneParams(`?${sceneSearch(s)}`).overrides)).toEqual(s);
    // what doesn't check out: unknown kinds, twice the same, a place that isn't one, sizes out of bounds
    const messy = fromSceneRecord('screenshare', { frame: { size: 'huge', words: 'yes', widgets: [{ kind: 'nope' }, { kind: 'pulse', place: 'up', scale: 900 }, { kind: 'pulse', place: 'below' }, { kind: 'music', place: 'below', style: 'loud' }] } });
    expect(messy.frame).toEqual({ size: 'big', words: true, widgets: [{ kind: 'pulse', place: 'beside', scale: 100 }, { kind: 'music', place: 'below', scale: 100, style: 'now' }] });
    expect(fromSceneRecord('screenshare', { frame: { widgets: [] } }).frame.widgets).toEqual([]);
    expect(readFrameWidgets('none')).toEqual([]);
    expect(readFrameWidgets(writeFrameWidgets(s.frame.widgets))).toEqual(s.frame.widgets);
    // the wordmark goes on the other screens too
    const brb = withSceneOverrides(SCENE_DEFAULTS.brb, readSceneParams(`?${sceneSearch({ ...SCENE_DEFAULTS.brb, showMark: false })}`).overrides);
    expect(brb.showMark).toBe(false);
  });

  it('lay widgets on the frame out as tiles their content fills, never wider than the room', () => {
    // no bar: each fills the room's height (a 60-tall badge grows, but no more than FILL_MAX),
    // and they share the width left over by their own, so the row meets the screen's edges
    const row = tileRow([{ w: 400, h: 400, size: 1 }, { w: 300, h: 60, size: 1 }], { w: 1458, h: 160 });
    expect(row.map((t) => t.zoom)).toEqual([0.4, FILL_MAX]);
    expect(row.every((t) => t.h === 160)).toBe(true);
    expect(row[0]!.w + row[1]!.w + 18).toBe(1458);
    expect(row[1]!.w / row[0]!.w).toBeCloseTo(600 / 160, 1);
    // a smaller size leaves it some air
    expect(tileRow([{ w: 300, h: 80, size: 0.5 }], { w: 1440, h: 160 }, 480)[0]).toEqual({ zoom: 1, w: 300, h: 160 });
    // too wide all together: they shrink alike
    const tight = tileRow([{ w: 600, h: 160, size: 1 }, { w: 600, h: 160, size: 1 }], { w: 618, h: 160 });
    expect(tight[0]!.zoom).toBeCloseTo(0.5);
    expect(tight[0]!.w).toBe(300);
    // the strip takes what's left: all of it on its own, half beside the bar, its content fitting
    expect(tileRow([{ w: 900, h: 64, size: 1, flex: true }], { w: 1800, h: 160 })).toEqual([{ zoom: 2, w: 1800, h: 160 }]);
    expect(tileRow([{ w: 1400, h: 64, size: 1, flex: true }], { w: 1440, h: 160 }, 480)[0]).toEqual({ zoom: 0.336, w: 471, h: 160 });
    expect(tileRow([], { w: 0, h: 0 })).toEqual([]);
    // in the column, content as wide as the column
    expect(columnZoom({ w: 400, size: 1 }, 360)).toBe(0.9);
    expect(columnZoom({ w: 100, size: 0.5 }, 360)).toBe(1);
    // a stack under the camera shrinks only when it's too tall for the room
    expect(squeezeStack([100, 100], 300)).toBe(1);
    expect(squeezeStack([300, 300], 318)).toBe(0.5);
  });

  it('count down as people read clocks', () => {
    expect(countdownText(299_001)).toBe('5:00');
    expect(countdownText(65_000)).toBe('1:05');
    expect(countdownText(3_723_000)).toBe('1:02:03');
    expect(countdownText(0)).toBe('');
    expect(countdownText(-5)).toBe('');
  });

  it("arrive on Jetstream from the streamer's repo", () => {
    const value = { title: 'brb' };
    const commit = (did: string, op: string, rkey: string) => ({ kind: 'commit', did, time_us: 1, commit: { operation: op, collection: SCENE, rkey, record: value } });
    expect(eventFor(commit(STREAMER, 'update', 'brb'), STREAMER)).toEqual({ kind: 'scene', rkey: 'brb', value });
    expect(eventFor(commit('did:plc:other', 'update', 'brb'), STREAMER)).toBeNull();
    expect(new URL(jetstreamUrl('wss://j.example/subscribe', false)).searchParams.getAll('wantedCollections')).toContain(SCENE);
  });
});

describe('the scene on the overlay', () => {
  afterEach(() => vi.useRealTimers());
  const page = () => {
    document.body.innerHTML = bodyOf('../overlay/index.html');
    return document.querySelector<HTMLElement>('[data-ov-scene]')!;
  };

  it('shows the panel, counts down, and says so when the time comes', () => {
    vi.useFakeTimers();
    const root = page();
    let t = 0;
    const onDone = vi.fn();
    const view = mountScene(root, { now: () => t, onDone });
    view.show({ ...SCENE_DEFAULTS.starting, title: '<b>soon</b>', countdown: { mode: 'timer', minutes: 1, at: null } });
    expect(root.hidden).toBe(false);
    expect(document.body.dataset.scene).toBe('starting');
    expect(root.querySelector('[data-ovsc-title]')!.textContent).toBe('<b>soon</b>');
    expect(root.querySelector('b')).toBeNull();
    const count = root.querySelector<HTMLElement>('[data-ovsc-count]')!;
    expect(count.textContent).toBe('1:00');
    t = 30_000;
    vi.advanceTimersByTime(500);
    expect(count.textContent).toBe('0:30');
    // saving a new title doesn't restart the timer
    view.show({ ...SCENE_DEFAULTS.starting, title: 'still soon', countdown: { mode: 'timer', minutes: 1, at: null } });
    expect(count.textContent).toBe('0:30');
    t = 61_000;
    vi.advanceTimersByTime(500);
    expect(count.textContent).toBe(DONE_TEXT);
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onDone).toHaveBeenCalledTimes(1);
    view.show(null);
    expect(root.hidden).toBe(true);
  });

  it("lists the end screen's links, and cuts the screen share's windows out of its frame", () => {
    const root = page();
    const view = mountScene(root);
    view.show({ ...SCENE_DEFAULTS.ending, links: ['atpota.to', 'bsky.app/profile/dame.is'] });
    expect([...root.querySelectorAll('[data-ovsc-links] li')].map((li) => li.textContent)).toEqual(['atpota.to', 'bsky.app/profile/dame.is']);
    expect(root.querySelector<HTMLElement>('[data-ovsc-count]')!.hidden).toBe(true);
    expect(root.dataset).toMatchObject({ background: 'night', ground: 'meadow' });
    expect(root.querySelectorAll('.ovsc__meadow .ovsc__tuft').length).toBeGreaterThan(0);
    view.show({ ...SCENE_DEFAULTS.screenshare, ground: 'grass' } as Scene);
    expect(root.dataset.ground).toBe('grass');
    view.show({ ...SCENE_DEFAULTS.screenshare, title: 'building things', camera: { side: 'left', shape: 'circle' } });
    expect(root.querySelector<HTMLElement>('[data-ovsc-panel]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-ovsc-bar]')!.hidden).toBe(false);
    expect(root.querySelector('[data-ovsc-bar-title]')!.textContent).toBe('building things');
    const camera = root.querySelector<HTMLElement>('[data-ovsc-hole="camera"]')!;
    expect(camera.style.left).toBe('40px');
    expect(camera.classList.contains('is-circle')).toBe(true);
    expect(root.dataset.mark).toBe('on');
    // the bar can go, the wordmark too; with no words left there's no bar
    view.show({ ...SCENE_DEFAULTS.screenshare, title: 'hi', frame: { ...SCENE_DEFAULTS.screenshare.frame, words: false } });
    expect(root.querySelector<HTMLElement>('[data-ovsc-bar]')!.hidden).toBe(true);
    view.show({ ...SCENE_DEFAULTS.screenshare, title: '', subtitle: '', showMark: false });
    expect(root.dataset.mark).toBe('off');
    expect(root.querySelector<HTMLElement>('[data-ovsc-bar]')!.hidden).toBe(true);
    view.show({ ...SCENE_DEFAULTS.screenshare, title: 'hi', showMark: false });
    expect(root.querySelector<HTMLElement>('[data-ovsc-bar]')!.hidden).toBe(false);
    // the column and the room under the screen follow the screen's size
    view.show({ ...SCENE_DEFAULTS.screenshare, frame: { ...SCENE_DEFAULTS.screenshare.frame, size: 'small' } });
    expect(root.querySelector<HTMLElement>('[data-ovsc-below]')!.style.height).toBe('340px');
    expect(root.querySelector<HTMLElement>('[data-ov-frame-slot="beside"]')!.style.width).toBe('440px');
  });

  it("puts the screen share's own widgets on its frame, over the layout's", () => {
    const root = page();
    const view = mountScene(root);
    const layout = createLayout(document);
    const scene: Scene = { ...SCENE_DEFAULTS.screenshare, frame: { size: 'big', words: true, widgets: [{ kind: 'strip', place: 'below', scale: 100 }, { kind: 'card', place: 'beside', scale: 100 }] } };
    view.show(scene);
    const shown = layout.apply({ ...DEFAULT_CONFIG, widgets: [{ kind: 'card', slot: 'top-left', scale: 100 }, { kind: 'apps', slot: 'top-right', scale: 100 }] }, scene.frame.widgets);
    expect([...shown].sort()).toEqual(['apps', 'card', 'strip']);
    const below = root.querySelector<HTMLElement>('[data-ov-frame-slot="below"]')!;
    const beside = root.querySelector<HTMLElement>('[data-ov-frame-slot="beside"]')!;
    expect(below.querySelector('[data-ov-widget="strip"]')).not.toBeNull();
    expect(beside.querySelector('[data-ov-widget="card"]')).not.toBeNull();
    expect(below.hidden || beside.hidden).toBe(false);
    expect(document.querySelector('[data-ov-slot="top-left"] [data-ov-widget="card"]')).toBeNull();
    expect(document.querySelector('[data-ov-slot="top-right"] [data-ov-widget="apps"]')).not.toBeNull();
    // off the screen share, the frame is empty and the layout has its card back
    view.show(SCENE_DEFAULTS.brb);
    layout.apply({ ...DEFAULT_CONFIG, widgets: [{ kind: 'card', slot: 'top-left', scale: 100 }] }, []);
    expect(document.querySelector('[data-ov-slot="top-left"] [data-ov-widget="card"]')).not.toBeNull();
    expect(below.hidden && beside.hidden).toBe(true);
  });
});

describe('the scenes on the setup page', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const page = () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    document.body.innerHTML = bodyOf('../overlay/setup.html');
    return document.querySelector<HTMLElement>('[data-ovs-scenes]')!;
  };

  it('puts a scene in the form and reads the same one back, showing only its own parts', () => {
    page();
    const form = document.querySelector<HTMLFormElement>('[data-ovs-scene-form]')!;
    const s: Scene = { ...SCENE_DEFAULTS.starting, title: 'going live', subtitle: 'potato talk', background: 'garden', showWidgets: true, countdown: { mode: 'clock', minutes: 10, at: new Date(2026, 9, 22, 18, 30).toISOString() } };
    fillSceneForm(form, s);
    expect(sceneFrom(form, s)).toEqual(s);
    expect(document.querySelector<HTMLElement>('[data-ovs-scenes] [data-ovs-for="starting"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-ovs-scenes] [data-ovs-for="screenshare"]')!.hidden).toBe(true);
    const sh: Scene = { ...SCENE_DEFAULTS.screenshare, camera: { side: 'none', shape: 'wide' } };
    fillSceneForm(form, sh);
    expect(sceneFrom(form, sh)).toEqual(sh);
    const framed: Scene = {
      ...SCENE_DEFAULTS.screenshare,
      showMark: false,
      frame: { size: 'small', words: false, widgets: [{ kind: 'strip', place: 'below', scale: 90 }, { kind: 'tid', place: 'beside', scale: 100, style: 'mini' }] },
    };
    fillSceneForm(form, framed);
    expect(sceneFrom(form, framed)).toEqual(framed);
    expect(document.querySelector('[data-ovs-frame-count]')!.textContent).toBe('2 on');
    // the bar's switch is the screen share's; the wordmark's is every screen's but the loading screen's
    fillSceneForm(form, SCENE_DEFAULTS.brb);
    expect(form.querySelector<HTMLInputElement>('input[name="frameWords"]')!.closest<HTMLElement>('[data-ovs-for]')!.hidden).toBe(true);
    expect(form.querySelector<HTMLInputElement>('input[name="showMark"]')!.closest<HTMLElement>('[data-ovs-for]')!.hidden).toBe(false);
    fillSceneForm(form, SCENE_DEFAULTS.loading);
    expect(form.querySelector<HTMLInputElement>('input[name="showMark"]')!.closest<HTMLElement>('[data-ovs-for]')!.hidden).toBe(true);
    expect(localInput(null)).toBe('');
  });

  it("says where the screen share's windows are", () => {
    expect(holeLines({ ...SCENE_DEFAULTS.screenshare })).toEqual(['screen capture: x 40, y 40, 1440 × 810', 'camera: x 1520, y 40, 360 × 360']);
    expect(holeLines({ ...SCENE_DEFAULTS.screenshare, frame: { ...SCENE_DEFAULTS.screenshare.frame, size: 'medium' } })[0]).toBe('screen capture: x 40, y 40, 1280 × 720');
    expect(holeLines({ ...SCENE_DEFAULTS.screenshare, camera: { side: 'none', shape: 'rounded' } })).toHaveLength(1);
  });

  it('makes ids from names that fit a record key and the URL', () => {
    expect(newScreenId('Coding BRB', 'brb', [])).toBe('coding-brb');
    expect(newScreenId('brb', 'brb', ['brb'])).toBe('brb-2');
    expect(newScreenId('(◕‿◕)', 'ending', [])).toBe('ending');
    expect(newScreenId('café time', 'brb', [])).toBe('cafe-time');
    expect(isScreenId('coding-brb')).toBe(true);
    expect(isScreenId('../x')).toBe(false);
  });

  it('screens remember their kind, name and ground in the record, and in the URL', () => {
    const s: Scene = { ...SCENE_DEFAULTS.ending, name: 'late night end', ground: 'soil' };
    const rec = toSceneRecord(s, '2026-10-01T00:00:00.000Z', new Date());
    expect(rec).toMatchObject({ kind: 'ending', name: 'late night end', ground: 'soil' });
    expect(fromSceneRecord('starting', rec)).toEqual(s);
    const url = readSceneParams(`?${sceneSearch(s, 'late-end')}`);
    expect(url.id).toBe('late-end');
    expect(url.kind).toBe('ending');
    expect(withSceneOverrides(SCENE_DEFAULTS.starting, url.overrides)).toMatchObject({ kind: 'ending', ground: 'soil' });
    expect(SCENE_DEFAULTS.brb.ground).toBe('meadow');
  });
});
