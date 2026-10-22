// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventFor, OVERLAY } from '../src/overlay/chat.js';
import { DEFAULT_CONFIG, fromRecord, isLayoutId, layoutNameOf, newLayoutId, OVERLAY_NSID, toRecord, type OverlayConfig } from '../src/overlay/config.js';
import { readParams } from '../src/overlay/params.js';
import { init as initSetup, layoutsFrom, overlayUrl, routeOf, SAVE_DELAY_MS } from '../src/overlay/setup.js';
import { layoutSketch, layoutSummary, screenSketch, screenSummary } from '../src/overlay/setup-library.js';
import { SCENE_SAVE_DELAY_MS } from '../src/overlay/setup-scenes.js';
import { SCENE_DEFAULTS, SCENE_NSID, type Scene } from '../src/overlay/scenes.js';
import { listOwnLayouts, readPublicConfig } from '../src/overlay/store.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const STREAMER = 'did:plc:gq4fo3u6tqzzdkjlwzpb23tj';
const session = { did: STREAMER, pds: 'https://pds.atpota.to', fetch: vi.fn(), signOut: vi.fn() };
const signedIn = { eager: true, start: async () => ({ session, callback: false, error: null }) } as never;

type Rec = { rkey: string; value: Record<string, unknown> };
/** A PDS with these layouts and screens, and dame.is's profile. */
const pds = (layouts: Rec[] | null, screens: Rec[] = []) =>
  vi.fn(async (url: string) => {
    const list = (nsid: string, recs: Rec[]) => new Response(JSON.stringify({ records: recs.map((r) => ({ uri: `at://${STREAMER}/${nsid}/${r.rkey}`, cid: 'x', value: r.value })) }));
    if (url.includes('listRecords') && url.includes(`collection=${OVERLAY_NSID}`)) return layouts ? list(OVERLAY_NSID, layouts) : new Response('{}', { status: 500 });
    if (url.includes('listRecords') && url.includes(`collection=${SCENE_NSID}`)) return list(SCENE_NSID, screens);
    return new Response(JSON.stringify({ did: STREAMER, handle: 'dame.is', displayName: 'dame' }));
  }) as unknown as typeof fetch;

describe('layouts, more than one', () => {
  it('are named records at their own keys, the main one at self', () => {
    expect(isLayoutId('just-chatting')).toBe(true);
    expect(isLayoutId('../x')).toBe(false);
    expect(newLayoutId('Just Chatting!', [])).toBe('just-chatting');
    expect(newLayoutId('self', [])).toBe('self-2');
    expect(newLayoutId('gaming', ['gaming'])).toBe('gaming-2');
    expect(newLayoutId('(◕‿◕)', [])).toBe('layout');
    expect(layoutNameOf({ name: '  coding\nstream ' }, 'coding')).toBe('coding stream');
    expect(layoutNameOf({}, 'self')).toBe('main layout');
    expect(layoutNameOf({}, 'gaming')).toBe('gaming');
    const rec = toRecord(DEFAULT_CONFIG, '2026-10-01T00:00:00.000Z', new Date(), 'gaming');
    expect(rec.name).toBe('gaming');
    expect(fromRecord(rec)).toEqual(DEFAULT_CONFIG);
    const lexicon = JSON.parse(read('../lexicons/to/atpota/poe/overlay.json'));
    expect(lexicon.defs.main.key).toBe('any');
    expect(lexicon.defs.main.record.properties.name.type).toBe('string');
  });

  it('are picked with &layout=, and the overlay follows only its own', async () => {
    expect(readParams('?streamer=dame.is').layout).toBe('self');
    expect(readParams('?streamer=dame.is&layout=Gaming').layout).toBe('gaming');
    expect(readParams('?streamer=dame.is&layout=../x').layout).toBe('self');
    expect(overlayUrl('dame.is', 'https://atpota.to')).toBe('https://atpota.to/overlay?streamer=dame.is');
    expect(overlayUrl('dame.is', 'https://atpota.to', 'gaming')).toBe('https://atpota.to/overlay?streamer=dame.is&layout=gaming');
    const commit = (rkey: string) => ({ kind: 'commit', did: STREAMER, time_us: 1, commit: { operation: 'update', collection: OVERLAY, rkey, record: { poe: {} } } });
    expect(eventFor(commit('gaming'), STREAMER)).toEqual({ kind: 'config', rkey: 'gaming', value: { poe: {} } });
    const f = vi.fn(async (url: string) => (url.includes('plc.directory') ? new Response(JSON.stringify({ id: STREAMER, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.atpota.to' }] })) : new Response(JSON.stringify({ value: { theme: 'dark', createdAt: '2026-10-01T00:00:00.000Z' } })))) as unknown as typeof fetch;
    await readPublicConfig(STREAMER, f, 'gaming');
    expect(String((f as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)![0])).toContain('rkey=gaming');
  });

  it('list the main one first, then oldest first, with their names', async () => {
    const list = await listOwnLayouts(session as never, pds([
      { rkey: 'gaming', value: { name: 'gaming', createdAt: '2026-10-03T00:00:00.000Z' } },
      { rkey: 'chat', value: { createdAt: '2026-10-02T00:00:00.000Z' } },
      { rkey: 'self', value: { theme: 'dark', createdAt: '2026-10-05T00:00:00.000Z' } },
      { rkey: 'Not An Id', value: { createdAt: '2026-10-01T00:00:00.000Z' } },
    ]));
    expect(list!.map((l) => `${l.id}:${l.name}`)).toEqual(['self:main layout', 'chat:chat', 'gaming:gaming']);
    expect(list![0]!.config.theme).toBe('dark');
    expect(layoutsFrom([]).map((l) => l.id)).toEqual(['self']);
  });
});

describe('the cards', () => {
  it('sketch a layout: its widgets in their slots, and Poe in its corner', () => {
    const c: OverlayConfig = { ...DEFAULT_CONFIG, widgets: [{ kind: 'card', slot: 'top-left', scale: 100 }, { kind: 'moon', slot: 'top-right', scale: 100 }], poe: { show: true, side: 'left', scale: 100 } };
    const sketch = layoutSketch(document, c);
    expect(sketch.querySelector('.ovs-sketch__slot--top-left')!.textContent).toBe('weather');
    expect(sketch.querySelector('.ovs-sketch__slot--top-right .is-anisota')!.textContent).toBe('moon');
    expect(sketch.querySelector('.ovs-sketch__poe--left')).not.toBeNull();
    expect(layoutSummary(c)).toBe("poe bottom left · 1 weather widget · anisota's moon");
    expect(layoutSummary({ ...c, widgets: [], poe: { ...c.poe, show: false } })).toBe('no poe · no widgets');
  });

  it("sketch a screen with the streamer's words as text", () => {
    const s: Scene = { ...SCENE_DEFAULTS.brb, title: '<b>snack</b>' };
    const sketch = screenSketch(document, s);
    expect(sketch.textContent).toBe('<b>snack</b>');
    expect(sketch.querySelector('b')).toBeNull();
    expect(screenSketch(document, SCENE_DEFAULTS.screenshare).querySelector('.ovs-sketch__cam--right')).not.toBeNull();
    expect(screenSummary(SCENE_DEFAULTS.brb, 'brb')).toBe('be right back screen');
    expect(screenSummary(SCENE_DEFAULTS.brb, 'coding-brb')).toBe('be right back screen · coding-brb');
  });
});

describe('the studio', () => {
  const page = () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    history.replaceState(null, '', '/overlay/setup');
    document.body.innerHTML = read('../overlay/setup.html').split('<body')[1]!.replace(/^[^>]*>/, '');
    return document.querySelector<HTMLElement>('[data-ovs]')!;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const names = (list: string) => [...document.querySelectorAll(`${list} .ovs-card__name`)].map((n) => n.firstChild!.textContent);
  const button = (list: string, id: string, label: string) => document.querySelector<HTMLButtonElement>(`${list} [data-id="${id}"] [data-action="${label}"]`)!;

  it('opens on a library of every layout and screen, and edits one from its card', async () => {
    const root = page();
    const save = vi.fn(async () => undefined);
    await initSetup({
      auth: signedIn,
      fetchImpl: pds([
        { rkey: 'self', value: { poe: { show: true, side: 'left', scale: 100 }, widgets: [{ kind: 'badge', slot: 'top-right', scale: 100 }], createdAt: '2026-10-01T00:00:00.000Z' } },
        { rkey: 'gaming', value: { name: 'gaming', widgets: [], createdAt: '2026-10-02T00:00:00.000Z' } },
      ], [{ rkey: 'coding-brb', value: { kind: 'brb', name: 'coding brb', createdAt: '2026-10-02T00:00:00.000Z' } }]),
      save,
    });
    expect(root.dataset.state).toBe('signed-in');
    expect(q('[data-ovs-library]').hidden).toBe(false);
    expect(q('[data-ovs-editor]').hidden).toBe(true);
    expect(names('[data-ovs-layout-list]')).toEqual(['main layout', 'gaming']);
    expect(names('[data-ovs-screen-list]')).toEqual(['starting soon', 'be right back', 'the end', 'screen share', 'anisota loading', 'coding brb']);
    expect(q('[data-ovs-layout-list] [data-id="self"] .ovs-card__badge').textContent).toBe('main');
    expect(q<HTMLAnchorElement>('[data-ovs-layout-list] [data-id="gaming"] a').href).toBe(`${location.origin}/overlay?streamer=dame.is&layout=gaming`);

    button('[data-ovs-layout-list]', 'gaming', 'edit').click();
    await vi.waitFor(() => expect(location.hash).toBe('#layout/gaming'));
    expect(q('[data-ovs-library]').hidden).toBe(true);
    expect(q('[data-ovs-editor]').hidden).toBe(false);
    expect(q('[data-ovs-layout-heading]').textContent).toBe('gaming');
    expect(q<HTMLTextAreaElement>('[data-ovs-url]').value).toBe(`${location.origin}/overlay?streamer=dame.is&layout=gaming`);
    expect(q('[data-ovs-layout-remove]').textContent).toBe('remove this layout');

    vi.useFakeTimers();
    const form = q<HTMLFormElement>('[data-ovs-form]');
    form.querySelector<HTMLInputElement>('[name="w-moon"]')!.checked = true;
    const name = form.querySelector<HTMLInputElement>('[name="layoutName"]')!;
    name.value = 'gaming nights';
    form.dispatchEvent(new Event('input', { bubbles: true }));
    expect(q('[data-ovs-layout-heading]').textContent).toBe('gaming nights');
    expect(q('[data-ovs-count="anisota"]').textContent).toBe('1 on');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    const [, id, config, saveName, createdAt] = save.mock.calls[0] as unknown as [unknown, string, OverlayConfig, string, string];
    expect([id, saveName, createdAt]).toEqual(['gaming', 'gaming nights', '2026-10-02T00:00:00.000Z']);
    expect(config.widgets.map((w) => w.kind)).toEqual(['moon']);

    // back to the library, which shows the change
    q<HTMLAnchorElement>('[data-ovs-editor] [data-ovs-back]').click();
    expect(location.hash).toBe('');
    expect(q('[data-ovs-library]').hidden).toBe(false);
    expect(names('[data-ovs-layout-list]')).toEqual(['main layout', 'gaming nights']);

    // and the main one, whose URL has no &layout=
    button('[data-ovs-layout-list]', 'self', 'edit').click();
    expect(q<HTMLTextAreaElement>('[data-ovs-url]').value).toBe(`${location.origin}/overlay?streamer=dame.is`);
    expect(q('[data-ovs-layout-remove]').textContent).toBe('reset to the defaults');
  });

  it('adds, duplicates and removes layouts', async () => {
    page();
    const save = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    await initSetup({ auth: signedIn, fetchImpl: pds([]), save, remove, confirm: () => true });
    expect(names('[data-ovs-layout-list]')).toEqual(['main layout']);
    const add = q<HTMLFormElement>('[data-ovs-new-layout-form]');
    (add.elements.namedItem('name') as HTMLInputElement).value = 'Just Chatting';
    add.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(location.hash).toBe('#layout/just-chatting');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0] as unknown as [unknown, string, OverlayConfig, string])[1]).toBe('just-chatting');
    expect((save.mock.calls[0] as unknown as [unknown, string, OverlayConfig, string])[3]).toBe('Just Chatting');

    q<HTMLButtonElement>('[data-ovs-duplicate]').click();
    expect(location.hash).toBe('#layout/just-chatting-copy');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));

    q<HTMLButtonElement>('[data-ovs-layout-remove]').click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(session, 'just-chatting-copy'));
    await vi.waitFor(() => expect(location.hash).toBe(''));
    expect(names('[data-ovs-layout-list]')).toEqual(['main layout', 'Just Chatting']);
    expect(q('[data-ovs-layouts-note]').textContent).toBe('removed.');
  });

  it('adds a screen, edits it, and opens a screen straight from the address', async () => {
    page();
    const saveScreen = vi.fn(async () => undefined);
    const removeScreen = vi.fn(async () => undefined);
    await initSetup({ auth: signedIn, fetchImpl: pds([], [{ rkey: 'brb', value: { title: 'snack break', createdAt: '2026-10-01T00:00:00.000Z' } }]), saveScreen, removeScreen, confirm: () => true });
    button('[data-ovs-screen-list]', 'brb', 'edit').click();
    expect(location.hash).toBe('#screen/brb');
    expect(q('[data-ovs-scenes]').hidden).toBe(false);
    expect(q<HTMLInputElement>('[data-ovs-scene-form] [name="title"]').value).toBe('snack break');
    expect(q<HTMLTextAreaElement>('[data-ovs-scene-url]').value).toBe(`${location.origin}/overlay?streamer=dame.is&scene=brb`);
    expect(q('[data-ovs-scene-remove]').textContent).toBe('reset to the defaults');

    vi.useFakeTimers();
    const title = q<HTMLInputElement>('[data-ovs-scene-form] [name="title"]');
    title.value = 'back in five';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SCENE_SAVE_DELAY_MS);
    expect(saveScreen).toHaveBeenCalledTimes(1);
    expect((saveScreen.mock.calls[0] as unknown as [unknown, string, Scene])[2]).toMatchObject({ kind: 'brb', title: 'back in five' });
    vi.useRealTimers();

    q<HTMLAnchorElement>('[data-ovs-scenes] [data-ovs-back]').click();
    const add = q<HTMLFormElement>('[data-ovs-new-form]');
    (add.elements.namedItem('name') as HTMLInputElement).value = 'Moth Break';
    (add.elements.namedItem('kind') as HTMLSelectElement).value = 'loading';
    add.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(location.hash).toBe('#screen/moth-break');
    await vi.waitFor(() => expect(saveScreen).toHaveBeenCalledTimes(2));
    expect((saveScreen.mock.calls[1] as unknown as [unknown, string, Scene])[2]).toMatchObject({ kind: 'loading', name: 'Moth Break' });
    q<HTMLButtonElement>('[data-ovs-scene-remove]').click();
    await vi.waitFor(() => expect(removeScreen).toHaveBeenCalledWith(session, 'moth-break'));
    await vi.waitFor(() => expect(location.hash).toBe(''));
    expect(names('[data-ovs-screen-list]')).not.toContain('Moth Break');

    // a page loaded at #screen/<id> opens straight there
    page();
    history.replaceState(null, '', '/overlay/setup#screen/ending');
    await initSetup({ auth: signedIn, fetchImpl: pds([]) });
    expect(q('[data-ovs-scenes]').hidden).toBe(false);
    expect(q('[data-ovs-screen-heading]').textContent).toBe('the end');
  });

  it('asks to sign in again when the sign-in is from before it could save', async () => {
    page();
    const save = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    history.replaceState(null, '', '/overlay/setup#layout/self');
    await initSetup({ auth: signedIn, fetchImpl: pds(null), save });
    expect(q('[data-ovs-layouts-note]').textContent).toContain("couldn't read");
    vi.useFakeTimers();
    q<HTMLFormElement>('[data-ovs-form]').dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(q('[data-ovs-reconsent]').hidden).toBe(false);
  });

  it('knows its views from the address', () => {
    expect(routeOf('#layout/gaming')).toEqual({ view: 'layout', id: 'gaming' });
    expect(routeOf('#screen/brb')).toEqual({ view: 'screen', id: 'brb' });
    expect(routeOf('#layout/../x')).toBeNull();
    expect(routeOf('')).toBeNull();
  });
});
