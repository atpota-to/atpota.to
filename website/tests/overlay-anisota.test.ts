// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CYCLE_DAYS, CYCLE_MS, drawAnisota, MOON_DISC, moonLitPath, mountAnisota, phaseOf } from '../src/overlay/anisota.js';
import { readWidgets } from '../src/overlay/params.js';
import { fromRecord, WIDGET_HINTS, WIDGET_HOME, WIDGET_NAMES } from '../src/overlay/config.js';
import { mountScene, SPLASH_LINE_MS, SPLASH_LINES } from '../src/overlay/scene-view.js';
import { fromSceneRecord, readSceneParams, SCENE_DEFAULTS, sceneSearch, withSceneOverrides } from '../src/overlay/scenes.js';
import { fillSceneForm, sceneFrom } from '../src/overlay/setup-scenes.js';
import { phaseAt } from '../src/scripts/moon.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');
const bodyOf = (file: string) => read(file).split('<body')[1]!.replace(/^[^>]*>/, '');

describe("Anisota's moon", () => {
  it('is dark at new, the whole disc at full, and lit on the right while waxing', () => {
    expect(moonLitPath(phaseAt(0))).toBe('M 0 0 Z');
    expect(moonLitPath(phaseAt(0.5))).toBe(MOON_DISC);
    const xs = (d: string) => [...d.matchAll(/L ([\d.]+) /g)].map((m) => Number(m[1]));
    const mean = (d: string) => xs(d).reduce((a, b) => a + b, 0) / xs(d).length;
    expect(mean(moonLitPath(phaseAt(0.15)))).toBeGreaterThan(169.23);
    expect(mean(moonLitPath(phaseAt(0.85)))).toBeLessThan(169.23);
  });

  it('turns an elongation into a phase', () => {
    expect(phaseOf(180)).toEqual({ illumination: 1, waxing: false });
    expect(phaseOf(450).waxing).toBe(true);
    expect(phaseOf(90).illumination).toBeCloseTo(0.5);
  });

  it('draws the mark around its moon, and the moon on its own', () => {
    const mark = drawAnisota(document, 'mark');
    expect(mark.svg.querySelector('use')!.getAttribute('href')).toBe('#anisota-mark');
    const moon = drawAnisota(document, 'moon');
    expect(moon.svg.querySelector('use')).toBeNull();
    moon.set(phaseAt(0.5));
    expect(moon.svg.querySelector('clipPath path')!.getAttribute('d')).toBe(MOON_DISC);
  });
});

describe("Anisota's widgets", () => {
  afterEach(() => vi.useRealTimers());

  it('are widgets like the rest, saved and in the URL', () => {
    expect(readWidgets('moon:tr:120,mark:bl:80,loader:br:100')).toEqual([
      { kind: 'moon', slot: 'top-right', scale: 120 },
      { kind: 'mark', slot: 'bottom-left', scale: 80 },
      { kind: 'loader', slot: 'bottom-right', scale: 100 },
    ]);
    expect(fromRecord({ widgets: [{ kind: 'moon', slot: 'top-left', scale: 100 }] }).widgets).toEqual([{ kind: 'moon', slot: 'top-left', scale: 100 }]);
    for (const kind of ['moon', 'mark', 'loader'] as const) expect([WIDGET_NAMES[kind], WIDGET_HINTS[kind], WIDGET_HOME[kind]].every(Boolean)).toBe(true);
    const lexicon = JSON.parse(read('../lexicons/to/atpota/poe/overlay.json'));
    expect(JSON.stringify(lexicon)).toContain('"pulse","moon","mark","loader"');
  });

  it("show tonight's moon with its name, and the loader runs through a cycle in whole days", () => {
    vi.useFakeTimers();
    document.body.innerHTML = bodyOf('../overlay/index.html');
    const tonight = phaseAt(0.4);
    mountAnisota(document, { moon: () => ({ ...tonight, name: 'waxing gibbous' }) });
    const moon = document.querySelector('[data-ov-widget="moon"] [data-ov-anisota] svg clipPath path')!;
    expect(moon.getAttribute('d')).toBe(moonLitPath(tonight));
    expect(document.querySelector('[data-ov-moon-name]')!.textContent).toBe('Waxing gibbous');
    expect(document.querySelector('[data-ov-moon-lit]')!.textContent).toBe(`${Math.round(tonight.illumination * 100)}% lit`);
    const mark = document.querySelector('[data-ov-widget="mark"] svg clipPath path')!;
    expect(mark.getAttribute('d')).toBe(moonLitPath(tonight));

    const loader = document.querySelector('[data-ov-widget="loader"] svg clipPath path')!;
    expect(loader.getAttribute('d')).toBe(moonLitPath(tonight));
    vi.advanceTimersByTime(CYCLE_MS / CYCLE_DAYS);
    expect(loader.getAttribute('d')).toBe(moonLitPath(phaseOf(0.4 * 360 + 360 / CYCLE_DAYS)));
    vi.advanceTimersByTime(CYCLE_MS - CYCLE_MS / CYCLE_DAYS);
    expect(loader.getAttribute('d')).toBe(moonLitPath(tonight));
    // the loading screen has one too
    expect(document.querySelector('[data-ovsc-splash] svg')).not.toBeNull();
  });
});

describe("Anisota's loading screen", () => {
  afterEach(() => vi.useRealTimers());

  it('is a scene with its own defaults, saved and in the URL', () => {
    expect(SCENE_DEFAULTS.loading).toMatchObject({ kind: 'loading', title: '', showPoe: false, ground: 'none' });
    expect(fromSceneRecord('starting', { kind: 'loading', title: 'one sec' })).toMatchObject({ kind: 'loading', title: 'one sec' });
    const s = { ...SCENE_DEFAULTS.loading, subtitle: 'back with moths' };
    expect(withSceneOverrides(SCENE_DEFAULTS.loading, readSceneParams(`?${sceneSearch(s)}`).overrides)).toEqual(s);
  });

  it("shows the mark in place of the panel, and Anisota's lines in turn without a title", () => {
    vi.useFakeTimers();
    document.body.innerHTML = bodyOf('../overlay/index.html');
    const root = document.querySelector<HTMLElement>('[data-ov-scene]')!;
    const view = mountScene(root);
    view.show(SCENE_DEFAULTS.loading);
    const splash = root.querySelector<HTMLElement>('[data-ovsc-splash]')!;
    const line = root.querySelector<HTMLElement>('[data-ovsc-splash-line]')!;
    expect(root.dataset.kind).toBe('loading');
    expect(splash.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-ovsc-panel]')!.hidden).toBe(true);
    expect(line.textContent).toBe(SPLASH_LINES[0]);
    vi.advanceTimersByTime(SPLASH_LINE_MS);
    expect(line.textContent).toBe(SPLASH_LINES[1]);
    view.show({ ...SCENE_DEFAULTS.loading, title: '<i>one sec</i>', subtitle: 'moths incoming' });
    expect(line.textContent).toBe('<i>one sec</i>');
    expect(root.querySelector('i')).toBeNull();
    vi.advanceTimersByTime(SPLASH_LINE_MS * 3);
    expect(line.textContent).toBe('<i>one sec</i>');
    expect(root.querySelector<HTMLElement>('[data-ovsc-splash-sub]')!.hidden).toBe(false);
    view.show(SCENE_DEFAULTS.brb);
    expect(splash.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-ovsc-panel]')!.hidden).toBe(false);
  });

  it('leaves the backdrop and ground out of the setup form', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    document.body.innerHTML = bodyOf('../overlay/setup.html');
    const form = document.querySelector<HTMLFormElement>('[data-ovs-scene-form]')!;
    const s = { ...SCENE_DEFAULTS.loading, title: 'nearly' };
    fillSceneForm(form, s);
    expect(sceneFrom(form, s)).toEqual(s);
    const label = (name: string) => form.querySelector(`[name="${name}"]`)!.closest<HTMLElement>('[data-ovs-for]')!;
    expect(label('background').hidden).toBe(true);
    expect(label('ground').hidden).toBe(true);
    expect(form.querySelector<HTMLElement>('[data-ovs-for="loading"]')!.hidden).toBe(false);
    fillSceneForm(form, SCENE_DEFAULTS.brb);
    expect(label('background').hidden).toBe(false);
    expect(form.querySelector<HTMLElement>('[data-ovs-for="loading"]')!.hidden).toBe(true);
    vi.unstubAllGlobals();
  });
});
