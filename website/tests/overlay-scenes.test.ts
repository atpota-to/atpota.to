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
  readSceneParams,
  SCENE_DEFAULTS,
  SCENE_KINDS,
  SCENE_NSID,
  sceneSearch,
  toSceneRecord,
  withSceneOverrides,
  type Scene,
} from '../src/overlay/scenes.js';
import { fillSceneForm, holeLines, localInput, mountScenes, SCENE_SAVE_DELAY_MS, sceneFrom } from '../src/overlay/setup-scenes.js';
import { DEFAULT_CONFIG } from '../src/overlay/config.js';

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
    for (const side of ['right', 'left', 'none'] as const) {
      for (const shape of ['rounded', 'circle', 'wide'] as const) {
        const h = frameHoles({ side, shape });
        expect(h.screen.w / h.screen.h).toBeCloseTo(16 / 9);
        for (const r of [h.screen, h.camera, h.bar].filter(Boolean)) {
          expect(r!.x).toBeGreaterThanOrEqual(0);
          expect(r!.y).toBeGreaterThanOrEqual(0);
          expect(r!.x + r!.w).toBeLessThanOrEqual(CANVAS.w);
          expect(r!.y + r!.h).toBeLessThanOrEqual(CANVAS.h);
        }
        if (h.camera) {
          const apart = h.camera.x >= h.screen.x + h.screen.w || h.camera.x + h.camera.w <= h.screen.x;
          expect(apart).toBe(true);
          expect(h.camera.w / h.camera.h).toBeCloseTo(shape === 'wide' ? 16 / 9 : 1, 1);
        } else expect(side).toBe('none');
      }
    }
    expect(frameHoles({ side: 'right', shape: 'rounded' })).toMatchObject({ screen: { x: 40, y: 40, w: 1440, h: 810 }, camera: { x: 1520, y: 40, w: 360, h: 360 } });
    expect(frameHoles({ side: 'left', shape: 'rounded' }).camera!.x).toBe(40);
    const path = framePath(frameHoles({ side: 'right', shape: 'circle' }), 'circle');
    expect(path.startsWith('M0,0H1920V1080H0Z')).toBe(true);
    expect(path.match(/Z/g)).toHaveLength(3);
    expect(path).toContain('A180,180');
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
    view.show({ ...SCENE_DEFAULTS.screenshare, title: 'building things', camera: { side: 'left', shape: 'circle' } });
    expect(root.querySelector<HTMLElement>('[data-ovsc-panel]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-ovsc-bar]')!.hidden).toBe(false);
    expect(root.querySelector('[data-ovsc-bar-title]')!.textContent).toBe('building things');
    const camera = root.querySelector<HTMLElement>('[data-ovsc-hole="camera"]')!;
    expect(camera.style.left).toBe('40px');
    expect(camera.classList.contains('is-circle')).toBe(true);
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
    expect(localInput(null)).toBe('');
  });

  it("says where the screen share's windows are", () => {
    expect(holeLines({ ...SCENE_DEFAULTS.screenshare })).toEqual(['screen capture: x 40, y 40, 1440 × 810', 'camera: x 1520, y 40, 360 × 360']);
    expect(holeLines({ ...SCENE_DEFAULTS.screenshare, camera: { side: 'none', shape: 'rounded' } })).toHaveLength(1);
  });

  it('loads each scene when its tab opens, and saves changes to the repo', async () => {
    const root = page();
    const session = { did: STREAMER, pds: 'https://pds.atpota.to', fetch: vi.fn(), signOut: vi.fn() };
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('rkey=brb')
        ? new Response(JSON.stringify({ value: { title: 'snack break', createdAt: '2026-10-01T00:00:00.000Z' } }))
        : new Response(JSON.stringify({ error: 'RecordNotFound' }), { status: 400 }),
    ) as unknown as typeof fetch;
    const save = vi.fn(async () => undefined);
    mountScenes(root, session as never, 'dame.is', () => DEFAULT_CONFIG, vi.fn(), { fetchImpl, save });
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-ovs-scene-form] [name="title"]')!.value).toBe('starting soon'));
    expect(document.querySelector<HTMLTextAreaElement>('[data-ovs-scene-url]')!.value).toBe(`${location.origin}/overlay?streamer=dame.is&scene=starting`);
    root.querySelector<HTMLButtonElement>('[data-scene="brb"]')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-ovs-scene-form] [name="title"]')!.value).toBe('snack break'));
    vi.useFakeTimers();
    const title = document.querySelector<HTMLInputElement>('[data-ovs-scene-form] [name="title"]')!;
    title.value = 'back in five';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SCENE_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    const [, scene, createdAt] = save.mock.calls[0] as unknown as [unknown, Scene, string];
    expect(scene).toMatchObject({ kind: 'brb', title: 'back in five' });
    expect(createdAt).toBe('2026-10-01T00:00:00.000Z');
  });
});
