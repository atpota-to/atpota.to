/**
 * The setup page's screens (overlay/setup.html, data-ovs-scenes): a tab for each of the
 * streamer's screens (scenes.ts), one form that edits whichever tab is open, a preview of
 * the overlay with that screen, its URL, and for a screen share where its windows are, so
 * the screen capture and camera can go exactly under them in OBS.
 *
 * The tabs are the screens everyone starts with (starting, brb, ending, screenshare,
 * loading: their defaults until changed) and then any the streamer has added, read from their repo
 * in one listRecords. "+ new screen" adds one of any kind with a name, at an id made from
 * that name; a screen they added can be removed, and one of the starters reset to its defaults.
 * Each is saved to to.atpota.poe.scene/<id> SCENE_SAVE_DELAY_MS after the last change, the
 * same way the overlay's settings are (setup.ts).
 */

import type { Session } from '../blog/auth';
import { troubleFrom } from '../scripts/pet-sync';
import type { OverlayConfig } from './config';
import { toSearch } from './params';
import { cleanText, copyScene, frameHoles, GROUNDS, isSceneKind, LINK_MAX, MAX_LINKS, MAX_SCREENS, NAME_MAX, newScreenId, SCENE_DEFAULTS, SCENE_KINDS, SCENE_NAMES, sceneSearch, type Ground, type Scene, type SceneKind } from './scenes';
import { deleteScene, listOwnScenes, saveScene, type SavedScreen } from './store';

export const SCENE_SAVE_DELAY_MS = 1200;
const PREVIEW_DELAY_MS = 400;
const WIDTH = 1920;

export const SCENE_COPY = {
  loading: 'reading your saved screens…',
  unreadable: "couldn't read your saved screens just now, so these are the defaults. reload to try again.",
  loaded: 'these are your saved settings for this screen.',
  fresh: "these are the defaults. change anything and it's saved to your repo.",
  saving: 'saving…',
  saved: 'saved. the screen on stream changes straight away (◕‿◕)',
  failed: "couldn't save just now. it'll try again with your next change.",
  reconsent: 'saving screens needs a new permission: sign in again, then make your change once more.',
  removed: 'removed.',
  reset: 'back to the defaults.',
  removeFailed: "couldn't remove it just now. try again in a moment.",
  full: `that's ${MAX_SCREENS} screens, as many as there's room for. remove one to add another.`,
  added: "added. it's saved to your repo, with its own URL below.",
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
  s.name = cleanText(text('name'), NAME_MAX) || SCENE_NAMES[s.kind];
  s.title = text('title').trim();
  s.subtitle = text('subtitle').trim();
  const bg = text('background');
  if (bg === 'day' || bg === 'night' || bg === 'garden' || bg === 'butter') s.background = bg;
  const ground = text('ground');
  if ((GROUNDS as readonly string[]).includes(ground)) s.ground = ground as Ground;
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
  field('name').value = s.name;
  field('title').value = s.title;
  field('subtitle').value = s.subtitle;
  field('background').value = s.background;
  field('ground').value = s.ground;
  (field('showPoe') as HTMLInputElement).checked = s.showPoe;
  (field('showWidgets') as HTMLInputElement).checked = s.showWidgets;
  radio('countdown', s.countdown.mode);
  const minutes = field('minutes') as HTMLSelectElement;
  minutes.value = [...minutes.options].some((o) => o.value === String(s.countdown.minutes)) ? String(s.countdown.minutes) : '5';
  field('at').value = localInput(s.countdown.at);
  field('links').value = s.links.join('\n');
  radio('camSide', s.camera.side);
  radio('camShape', s.camera.shape);
  for (const el of form.ownerDocument.querySelectorAll<HTMLElement>('[data-ovs-scenes] [data-ovs-for]')) el.hidden = !(el.dataset.ovsFor ?? '').split(' ').includes(s.kind);
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
  save?: (session: Session, id: string, scene: Scene, createdAt: string) => Promise<void>;
  remove?: (session: Session, id: string) => Promise<void>;
  confirm?: (question: string) => boolean;
}

interface Entry {
  id: string;
  scene: Scene;
  createdAt: string;
  note: string;
  /** In the streamer's repo (so removing it means deleting the record). */
  saved: boolean;
}

/** The screens everyone has, as defaults. */
const starters = (): Entry[] =>
  SCENE_KINDS.map((kind) => ({ id: kind, scene: copyScene(SCENE_DEFAULTS[kind]), createdAt: new Date().toISOString(), note: SCENE_COPY.fresh, saved: false }));

/** The tabs in order: the starters (saved or not), then the rest oldest first. */
export function screensFrom(saved: SavedScreen[]): Entry[] {
  const byId = new Map(saved.map((s) => [s.id, s]));
  const out = starters().map((e) => {
    const own = byId.get(e.id);
    return own ? { ...e, scene: own.scene, createdAt: own.createdAt, note: SCENE_COPY.loaded, saved: true } : e;
  });
  for (const s of saved) if (!isSceneKind(s.id)) out.push({ id: s.id, scene: s.scene, createdAt: s.createdAt, note: SCENE_COPY.loaded, saved: true });
  return out;
}

/** Wires up the screens section for a signed-in streamer. `draft` is the overlay's settings as the form has them now. */
export function mountScenes(root: HTMLElement, session: Session, streamer: string, draft: () => OverlayConfig, onReconsent: () => void, opts: ScenesOptions = {}): { refresh(): void; ready: Promise<void> } {
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const save = opts.save ?? ((s: Session, id: string, scene: Scene, createdAt: string) => saveScene(s, id, scene, createdAt));
  const remove = opts.remove ?? ((s: Session, id: string) => deleteScene(s, id));
  const confirm = opts.confirm ?? ((question: string) => win.confirm(question));
  const doc = root.ownerDocument;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = q<HTMLFormElement>('[data-ovs-scene-form]');
  const frame = q<HTMLIFrameElement>('[data-ovs-scene-frame]');
  const preview = q<HTMLElement>('[data-ovs-scene-preview]');
  const url = q<HTMLTextAreaElement>('[data-ovs-scene-url]');
  const saved = q<HTMLElement>('[data-ovs-scene-saved]');
  const status = q<HTMLElement>('[data-ovs-scene-status]');
  const holes = q<HTMLElement>('[data-ovs-holes]');
  const tabList = q<HTMLElement>('[data-ovs-scene-tabs]');
  const removeButton = q<HTMLButtonElement>('[data-ovs-scene-remove]');
  const adder = q<HTMLDetailsElement>('[data-ovs-new]');
  const addForm = q<HTMLFormElement>('[data-ovs-new-form]');
  const addNote = q<HTMLElement>('[data-ovs-new-note]');

  let screens: Entry[] = [];
  let current: Entry | null = null;
  let saveTimer: number | undefined;
  let previewTimer: number | undefined;
  let shown = '';

  const renderTabs = () => {
    tabList.replaceChildren(
      ...screens.map((e) => {
        const tab = doc.createElement('button');
        tab.type = 'button';
        tab.className = 'ovs-tab';
        tab.setAttribute('role', 'tab');
        tab.dataset.scene = e.id;
        tab.setAttribute('aria-selected', String(e === current));
        tab.textContent = e.scene.name;
        tab.addEventListener('click', () => {
          if (e !== current) open(e);
        });
        return tab;
      }),
    );
  };

  const show = () => {
    const e = current;
    if (!e) return;
    const s = e.scene;
    url.value = `${location.origin}/overlay?streamer=${streamer}&scene=${e.id}`;
    holes.replaceChildren(
      ...holeLines(s).map((line) => {
        const li = doc.createElement('li');
        li.textContent = line;
        return li;
      }),
    );
    removeButton.textContent = isSceneKind(e.id) ? 'reset to the defaults' : 'remove this screen';
    removeButton.hidden = isSceneKind(e.id) && !e.saved;
    win.clearTimeout(previewTimer);
    previewTimer = win.setTimeout(() => {
      const main = toSearch({ ...draft(), volume: 0 }, { demo: true });
      const src = `/overlay${main || '?'}${main ? '&' : ''}${sceneSearch(s, e.id)}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };

  const saveNow = async (entry: Entry) => {
    if (current === entry) saved.textContent = SCENE_COPY.saving;
    try {
      await save(session, entry.id, entry.scene, entry.createdAt);
      entry.saved = true;
      entry.note = SCENE_COPY.saved;
    } catch (error) {
      const trouble = troubleFrom(error);
      entry.note = trouble ? SCENE_COPY.reconsent : SCENE_COPY.failed;
      if (trouble) onReconsent();
    }
    if (current === entry) {
      saved.textContent = entry.note;
      show();
    }
  };

  /** A change waiting to save is saved now, before the form shows another screen. */
  const flush = () => {
    if (saveTimer === undefined || !current) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    void saveNow(current);
  };

  function open(next: Entry) {
    flush();
    current = next;
    renderTabs();
    q('[data-ovs-scene-panel]').setAttribute('aria-label', next.scene.name);
    fillSceneForm(form, next.scene);
    saved.textContent = next.note;
    show();
  }

  form.addEventListener('input', () => {
    const entry = current;
    if (!entry) return;
    const name = entry.scene.name;
    entry.scene = sceneFrom(form, entry.scene);
    if (entry.scene.name !== name) renderTabs();
    show();
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(() => {
      saveTimer = undefined;
      void saveNow(entry);
    }, SCENE_SAVE_DELAY_MS);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (screens.length >= MAX_SCREENS) {
      addNote.textContent = SCENE_COPY.full;
      return;
    }
    const data = new FormData(addForm);
    const kind = String(data.get('kind'));
    if (!isSceneKind(kind)) return;
    const name = cleanText(String(data.get('name') ?? ''), NAME_MAX) || SCENE_NAMES[kind];
    const id = newScreenId(name, kind, screens.map((s) => s.id).concat(SCENE_KINDS));
    const entry: Entry = { id, scene: { ...copyScene(SCENE_DEFAULTS[kind]), name }, createdAt: new Date().toISOString(), note: SCENE_COPY.added, saved: false };
    screens.push(entry);
    addForm.reset();
    addNote.textContent = '';
    adder.open = false;
    open(entry);
    void saveNow(entry);
  });

  removeButton.addEventListener('click', async () => {
    const entry = current;
    if (!entry) return;
    const starter = isSceneKind(entry.id);
    if (!confirm(starter ? `put "${entry.scene.name}" back to its defaults?` : `remove "${entry.scene.name}"? its URL will show the defaults.`)) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    if (entry.saved) {
      try {
        await remove(session, entry.id);
      } catch (error) {
        if (troubleFrom(error)) onReconsent();
        saved.textContent = troubleFrom(error) ? SCENE_COPY.reconsent : SCENE_COPY.removeFailed;
        return;
      }
    }
    if (starter) {
      const fresh = starters().find((s) => s.id === entry.id)!;
      Object.assign(entry, fresh, { note: SCENE_COPY.reset });
      open(entry);
    } else {
      screens = screens.filter((s) => s !== entry);
      current = null;
      open(screens[0]!);
      saved.textContent = SCENE_COPY.removed;
    }
  });

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
  saved.textContent = SCENE_COPY.loading;
  const ready = listOwnScenes(session, fetchImpl).then((list) => {
    screens = screensFrom(list ?? []);
    open(screens[0]!);
    if (!list) saved.textContent = SCENE_COPY.unreadable;
  });
  return {
    // the overlay's settings changed: the preview shows them too
    refresh: () => show(),
    ready,
  };
}
