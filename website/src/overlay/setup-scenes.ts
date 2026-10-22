/**
 * The setup page's scenes (overlay/setup.html, data-ovs-scenes): a tab for each scene
 * (scenes.ts), one form that edits whichever tab is open, a preview of the overlay with
 * that scene, its URL, and for the screen share where its windows are, so the screen
 * capture and camera can go exactly under them in OBS.
 *
 * Each scene is loaded from the streamer's repo when its tab first opens (or starts from
 * its defaults), and saved to to.atpota.poe.scene/<scene> SAVE_DELAY_MS after the last
 * change, the same way the overlay's settings are (setup.ts).
 */

import type { Session } from '../blog/auth';
import { troubleFrom } from '../scripts/pet-sync';
import type { OverlayConfig } from './config';
import { toSearch } from './params';
import { copyScene, frameHoles, isSceneKind, LINK_MAX, MAX_LINKS, SCENE_DEFAULTS, SCENE_NAMES, sceneSearch, type Scene, type SceneKind } from './scenes';
import { readOwnScene, saveScene } from './store';

export const SCENE_SAVE_DELAY_MS = 1200;
const PREVIEW_DELAY_MS = 400;
const WIDTH = 1920;

export const SCENE_COPY = {
  loading: 'reading your saved scene…',
  loaded: 'these are your saved settings for this scene.',
  fresh: "these are the defaults. change anything and it's saved to your repo.",
  saving: 'saving…',
  saved: "saved. the scene on stream changes straight away (◕‿◕)",
  failed: "couldn't save just now. it'll try again with your next change.",
  reconsent: 'saving scenes needs a new permission: sign in again, then make your change once more.',
} as const;

/** A datetime-local value ("2026-10-22T18:30") for an ISO time, in this device's zone. */
export function localInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The scene form as a scene of `kind`, keeping the settings this tab doesn't show from `was`. */
export function sceneFrom(form: HTMLFormElement, was: Scene): Scene {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? '');
  const s = copyScene(was);
  s.title = text('title').trim();
  s.subtitle = text('subtitle').trim();
  const bg = text('background');
  if (bg === 'day' || bg === 'night' || bg === 'garden' || bg === 'butter') s.background = bg;
  s.showPoe = data.has('showPoe');
  s.showWidgets = data.has('showWidgets');
  if (s.kind === 'starting') {
    const mode = text('countdown');
    const at = text('at') ? new Date(text('at')) : null;
    s.countdown = {
      mode: mode === 'clock' || mode === 'none' ? mode : 'timer',
      minutes: Number(text('minutes')) || 5,
      at: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
    };
  }
  if (s.kind === 'ending') {
    s.links = text('links')
      .split('\n')
      .map((l) => l.trim().slice(0, LINK_MAX))
      .filter(Boolean)
      .slice(0, MAX_LINKS);
  }
  if (s.kind === 'screenshare') {
    const side = text('camSide');
    const shape = text('camShape');
    s.camera = { side: side === 'left' || side === 'none' ? side : 'right', shape: shape === 'circle' || shape === 'wide' ? shape : 'rounded' };
  }
  return s;
}

/** Puts a scene into the form, showing only the parts that are its. */
export function fillSceneForm(form: HTMLFormElement, s: Scene): void {
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const radio = (name: string, value: string) => {
    const r = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (r) r.checked = true;
  };
  field('title').value = s.title;
  field('subtitle').value = s.subtitle;
  field('background').value = s.background;
  (field('showPoe') as HTMLInputElement).checked = s.showPoe;
  (field('showWidgets') as HTMLInputElement).checked = s.showWidgets;
  radio('countdown', s.countdown.mode);
  const minutes = field('minutes') as HTMLSelectElement;
  minutes.value = [...minutes.options].some((o) => o.value === String(s.countdown.minutes)) ? String(s.countdown.minutes) : '5';
  field('at').value = localInput(s.countdown.at);
  field('links').value = s.links.join('\n');
  radio('camSide', s.camera.side);
  radio('camShape', s.camera.shape);
  for (const el of form.ownerDocument.querySelectorAll<HTMLElement>('[data-ovs-scenes] [data-ovs-for]')) el.hidden = el.dataset.ovsFor !== s.kind;
}

/** "screen capture: x 40, y 40, 1440 × 810", and the camera's, for the screen share. */
export function holeLines(s: Scene): string[] {
  const h = frameHoles(s.camera);
  const line = (name: string, r: { x: number; y: number; w: number; h: number }) => `${name}: x ${r.x}, y ${r.y}, ${r.w} × ${r.h}`;
  return [line('screen capture', h.screen), ...(h.camera ? [line(`camera${s.camera.shape === 'circle' ? ' (it shows as a circle)' : ''}`, h.camera)] : [])];
}

export interface ScenesOptions {
  win?: Window;
  fetchImpl?: typeof fetch;
  save?: (session: Session, scene: Scene, createdAt: string) => Promise<void>;
}

/** Wires up the scenes section for a signed-in streamer. `draft` is the overlay's settings as the form has them now. */
export function mountScenes(root: HTMLElement, session: Session, streamer: string, draft: () => OverlayConfig, onReconsent: () => void, opts: ScenesOptions = {}): { refresh(): void } {
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const save = opts.save ?? ((s: Session, scene: Scene, createdAt: string) => saveScene(s, scene, createdAt));
  const doc = root.ownerDocument;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = q<HTMLFormElement>('[data-ovs-scene-form]');
  const frame = q<HTMLIFrameElement>('[data-ovs-scene-frame]');
  const preview = q<HTMLElement>('[data-ovs-scene-preview]');
  const url = q<HTMLTextAreaElement>('[data-ovs-scene-url]');
  const saved = q<HTMLElement>('[data-ovs-scene-saved]');
  const status = q<HTMLElement>('[data-ovs-scene-status]');
  const holes = q<HTMLElement>('[data-ovs-holes]');
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-ovs-scene-tabs] [data-scene]')];

  const scenes = new Map<SceneKind, { scene: Scene; createdAt: string; note: string }>();
  let kind: SceneKind = 'starting';
  let saveTimer: number | undefined;
  let previewTimer: number | undefined;
  let shown = '';

  const show = () => {
    const entry = scenes.get(kind);
    if (!entry) return;
    const s = entry.scene;
    url.value = `${location.origin}/overlay?streamer=${streamer}&scene=${s.kind}`;
    holes.replaceChildren(
      ...holeLines(s).map((line) => {
        const li = doc.createElement('li');
        li.textContent = line;
        return li;
      }),
    );
    win.clearTimeout(previewTimer);
    previewTimer = win.setTimeout(() => {
      const main = toSearch({ ...draft(), volume: 0 }, { demo: true });
      const src = `/overlay${main || '?'}${main ? '&' : ''}${sceneSearch(s)}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };

  const open = async (next: SceneKind) => {
    kind = next;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.scene === next));
    q('[data-ovs-scene-panel]').setAttribute('aria-label', SCENE_NAMES[next]);
    if (!scenes.has(next)) {
      saved.textContent = SCENE_COPY.loading;
      const own = await readOwnScene(session, next, fetchImpl);
      scenes.set(next, own ? { scene: own.scene, createdAt: own.createdAt, note: SCENE_COPY.loaded } : { scene: copyScene(SCENE_DEFAULTS[next]), createdAt: new Date().toISOString(), note: SCENE_COPY.fresh });
    }
    if (kind !== next) return;
    const entry = scenes.get(next)!;
    fillSceneForm(form, entry.scene);
    saved.textContent = entry.note;
    show();
  };

  const saveNow = async (entry: { scene: Scene; createdAt: string; note: string }) => {
    saved.textContent = SCENE_COPY.saving;
    try {
      await save(session, entry.scene, entry.createdAt);
      entry.note = SCENE_COPY.saved;
    } catch (error) {
      const trouble = troubleFrom(error);
      entry.note = trouble ? SCENE_COPY.reconsent : SCENE_COPY.failed;
      if (trouble) onReconsent();
    }
    if (scenes.get(kind) === entry) saved.textContent = entry.note;
  };

  form.addEventListener('input', () => {
    const entry = scenes.get(kind);
    if (!entry) return;
    entry.scene = sceneFrom(form, entry.scene);
    show();
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(() => void saveNow(entry), SCENE_SAVE_DELAY_MS);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  for (const t of tabs) {
    t.addEventListener('click', () => {
      if (isSceneKind(t.dataset.scene) && t.dataset.scene !== kind) {
        // a change waiting to save is saved now, before the form shows another scene
        const pending = scenes.get(kind);
        if (saveTimer !== undefined && pending) {
          win.clearTimeout(saveTimer);
          saveTimer = undefined;
          void saveNow(pending);
        }
        void open(t.dataset.scene);
      }
    });
  }
  q<HTMLButtonElement>('[data-ovs-scene-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      status.textContent = 'copied (◕‿◕)';
    } catch {
      url.select();
      status.textContent = 'select it and copy';
    }
    win.setTimeout(() => (status.textContent = ''), 3000);
  });

  const fit = () => preview.style.setProperty('--scale', String(preview.clientWidth / WIDTH));
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(preview);
  root.hidden = false;
  fit();
  void open('starting');
  return {
    // the overlay's settings changed: the preview shows them too
    refresh: () => show(),
  };
}
