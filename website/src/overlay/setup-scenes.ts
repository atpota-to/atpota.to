/**
 * The setup page's screen editor (overlay/setup.html, data-ovs-scenes): one form for the
 * screen the studio opened (setup.ts, from its card), a preview of the overlay with that
 * screen, its URL, and for a screen share where its windows are, so the screen capture and
 * camera can go exactly under them in OBS. A change is saved to to.atpota.poe.scene/<id>
 * SCENE_SAVE_DELAY_MS after the last one, the same way a layout is.
 *
 * The screens are the ones everyone starts with (starting, brb, ending, screenshare,
 * loading: their defaults until changed) and then any the streamer has added, read from
 * their repo in one listRecords (screensFrom).
 */

import type { OverlayConfig } from './config';
import { toSearch } from './params';
import { cleanText, copyScene, frameHoles, GROUNDS, isSceneKind, LINK_MAX, MAX_LINKS, MAX_SCREENS, NAME_MAX, SCENE_DEFAULTS, SCENE_KINDS, SCENE_NAMES, sceneSearch, type Ground, type Scene } from './scenes';
import type { SavedScreen } from './store';

export const SCENE_SAVE_DELAY_MS = 1200;
const PREVIEW_DELAY_MS = 400;
const WIDTH = 1920;

export { MAX_SCREENS };

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

export interface ScreenEntry {
  id: string;
  scene: Scene;
  createdAt: string;
  note: string;
  /** In the streamer's repo (so removing it means deleting the record). */
  saved: boolean;
}

/** The screens everyone has, as defaults. */
export const starters = (): ScreenEntry[] =>
  SCENE_KINDS.map((kind) => ({ id: kind, scene: copyScene(SCENE_DEFAULTS[kind]), createdAt: new Date().toISOString(), note: SCENE_COPY.fresh, saved: false }));

/** In order: the starters (saved or not), then the rest oldest first. */
export function screensFrom(saved: SavedScreen[]): ScreenEntry[] {
  const byId = new Map(saved.map((s) => [s.id, s]));
  const out = starters().map((e) => {
    const own = byId.get(e.id);
    return own ? { ...e, scene: own.scene, createdAt: own.createdAt, note: SCENE_COPY.loaded, saved: true } : e;
  });
  for (const s of saved) if (!isSceneKind(s.id)) out.push({ id: s.id, scene: s.scene, createdAt: s.createdAt, note: SCENE_COPY.loaded, saved: true });
  return out;
}

/** A screen's URL for OBS. */
export function screenUrl(origin: string, streamer: string, id: string): string {
  return `${origin}/overlay?streamer=${streamer}&scene=${id}`;
}

export interface ScreenEditorOptions {
  win?: Window;
  streamer: string;
  /** The main layout's settings as they are now: Poe and the widgets come from it. */
  draft: () => OverlayConfig;
  /** Saves it; the note it comes back with goes under the title. */
  save: (entry: ScreenEntry) => Promise<void>;
  /** Removing (or resetting) it, asked from the editor's button. */
  remove: (entry: ScreenEntry) => void;
  /** It changed (its name, say): the library card wants redrawing. */
  changed?: (entry: ScreenEntry) => void;
}

export interface ScreenEditor {
  open(entry: ScreenEntry): void;
  /** Saves a change still waiting, now. */
  flush(): void;
  /** The main layout changed: the preview shows it too. */
  refresh(): void;
  /** The entry now showing, if any. */
  current(): ScreenEntry | null;
  /** The entry's note changed while it shows. */
  note(entry: ScreenEntry): void;
}

export function mountScreenEditor(root: HTMLElement, opts: ScreenEditorOptions): ScreenEditor {
  const win = opts.win ?? window;
  const doc = root.ownerDocument;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = q<HTMLFormElement>('[data-ovs-scene-form]');
  const frame = q<HTMLIFrameElement>('[data-ovs-scene-frame]');
  const preview = q<HTMLElement>('[data-ovs-scene-preview]');
  const url = q<HTMLTextAreaElement>('[data-ovs-scene-url]');
  const open = q<HTMLAnchorElement>('[data-ovs-scene-open]');
  const saved = q<HTMLElement>('[data-ovs-scene-saved]');
  const status = q<HTMLElement>('[data-ovs-scene-status]');
  const holes = q<HTMLElement>('[data-ovs-holes]');
  const heading = q<HTMLElement>('[data-ovs-screen-heading]');
  const removeButton = q<HTMLButtonElement>('[data-ovs-scene-remove]');

  let current: ScreenEntry | null = null;
  let saveTimer: number | undefined;
  let previewTimer: number | undefined;
  let shown = '';

  const show = () => {
    const e = current;
    if (!e) return;
    const s = e.scene;
    heading.textContent = s.name;
    url.value = screenUrl(location.origin, opts.streamer, e.id);
    open.href = url.value;
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
      const main = toSearch({ ...opts.draft(), volume: 0 }, { demo: true });
      const src = `/overlay${main || '?'}${main ? '&' : ''}${sceneSearch(s, e.id)}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };

  const saveNow = async (entry: ScreenEntry) => {
    if (current === entry) saved.textContent = SCENE_COPY.saving;
    await opts.save(entry);
    if (current === entry) {
      saved.textContent = entry.note;
      show();
    }
    opts.changed?.(entry);
  };

  const flush = () => {
    if (saveTimer === undefined || !current) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    void saveNow(current);
  };

  form.addEventListener('input', () => {
    const entry = current;
    if (!entry) return;
    entry.scene = sceneFrom(form, entry.scene);
    show();
    opts.changed?.(entry);
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(() => {
      saveTimer = undefined;
      void saveNow(entry);
    }, SCENE_SAVE_DELAY_MS);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  removeButton.addEventListener('click', () => {
    if (!current) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    opts.remove(current);
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

  return {
    open(entry) {
      flush();
      current = entry;
      fillSceneForm(form, entry.scene);
      saved.textContent = entry.note;
      show();
      fit();
    },
    flush,
    refresh: () => show(),
    current: () => current,
    note(entry) {
      if (current === entry) {
        saved.textContent = entry.note;
        show();
      }
    },
  };
}
