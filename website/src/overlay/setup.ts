/**
 * /overlay/setup: where a streamer sets up their overlay. It needs a sign-in, because the
 * settings are saved in the streamer's own repo (to.atpota.poe.overlay at "self",
 * config.ts and store.ts): the same on every computer and phone, and the overlay in OBS
 * follows them live. The overlay's URL is the same for good, /overlay?streamer=<handle>.
 *
 *   checking     a remembered sign-in is being restored
 *   unavailable  signing in doesn't work on this host (only atpota.to)
 *   signed-out   a button to sign in (the header's dialog, src/scripts/account.ts)
 *   signed-in    the studio
 *
 * The studio has three views, and the address says which (so the back button works):
 *
 *   (no hash)        the library (setup-library.ts): a card for each layout and screen,
 *                    read from the repo in one listRecords each, with edit, copy URL, open
 *                    and (for a layout) duplicate; "+ new layout" and "+ new screen"
 *   #layout/<id>     a layout's form (its name, Poe, what Poe reacts to, the weather,
 *                    Anisota's widgets, the TID clock, the streamer's flushes, status and
 *                    music, the chat on screen, look and sound), saved to to.atpota.poe.overlay/<id>
 *                    SAVE_DELAY_MS after the last change; a preview of the overlay with
 *                    ?demo over a pretend stream; the URL to paste into OBS
 *   #screen/<id>     a screen's form (setup-scenes.ts), the same way
 *
 * The main layout ("self", config.ts) is always there, at /overlay?streamer=<handle>; it can
 * be reset to the defaults but not removed. Screens show the main layout's Poe and widgets.
 *
 * A sign-in from before the overlay permission existed can't save (403): the page asks
 * the streamer to sign in again. The preview is the real overlay in an iframe at
 * 1920x1080, scaled down to fit, with the draft in its URL so it shows changes before
 * they're saved (and ?who= the streamer, so the record widgets show theirs, while the chat
 * shows examples); on a phone that's tiny, so it also opens full screen.
 *
 * DOM is built with createElement and textContent only.
 */

import { SESSION_EVENT, sharedAuth, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import { loadMe } from '../blog/signin';
import { troubleFrom } from '../scripts/pet-sync';
import { actorOf, copyConfig, DEFAULT_CONFIG, styleFor, WIDGET_STYLES, LAYOUT_NAME_MAX, layoutNameOf, MAIN_LAYOUT_NAME, MAX_LAYOUTS, newLayoutId, OVERLAY_RKEY, SLOTS, WIDGET_GROUPS, WIDGET_HINTS, WIDGET_HOME, WIDGET_KINDS, WIDGET_NAMES, type OverlayConfig, type Slot, type WidgetKind } from './config';
import { toSearch } from './params';
import { card, layoutSketch, layoutSummary, screenSketch, screenSummary } from './setup-library';
import { MAX_SCREENS, mountScreenEditor, SCENE_COPY, screensFrom, screenUrl, type ScreenEntry } from './setup-scenes';
import { cleanText, copyScene, isSceneKind, NAME_MAX, newScreenId, SCENE_DEFAULTS, SCENE_KINDS, SCENE_NAMES } from './scenes';
import { deleteLayout, deleteScene, listOwnLayouts, listOwnScenes, saveConfig, saveScene, type SavedLayout } from './store';

export const PREVIEW_DELAY_MS = 400;
export const SAVE_DELAY_MS = 1200;
/** Asks the header to open the sign-in dialog, coming back to this page. */
export const SIGNIN_EVENT = 'account:signin';
const WIDTH = 1920;

export const SETUP_COPY = {
  checking: 'checking who you are…',
  signedOut: "you're not signed in.",
  who: (who: string) => `signed in as ${who}. your settings save to your repo.`,
  saving: 'saving…',
  saved: 'saved to your repo. the overlay picks it up straight away (◕‿◕)',
  loaded: 'these are your saved settings.',
  fresh: "these are the defaults. change anything and it's saved to your repo.",
  failed: "couldn't save just now. it'll try again with your next change.",
  reconsent: 'saving needs a new permission: sign in again, then make your change once more.',
  unreadable: "couldn't read your saved settings, so these are the defaults. saving will replace them.",
  reading: 'reading what you have saved…',
  layoutsUnreadable: "couldn't read your saved layouts just now, so this is the main one's defaults. reload to try again.",
  screensUnreadable: "couldn't read your saved screens just now, so these are the defaults. reload to try again.",
  added: "added. it's saved to your repo, with its own URL.",
  removed: 'removed.',
  reset: 'back to the defaults.',
  removeFailed: "couldn't remove it just now. try again in a moment.",
  layoutsFull: `that's ${MAX_LAYOUTS} layouts, as many as there's room for. remove one to add another.`,
  screensFull: `that's ${MAX_SCREENS} screens, as many as there's room for. remove one to add another.`,
} as const;

export const SLOT_NAMES: Record<Slot, string> = {
  'top-left': 'top left',
  'top-center': 'top middle',
  'top-right': 'top right',
  'bottom-left': 'bottom left',
  'bottom-center': 'bottom middle',
  'bottom-right': 'bottom right',
};

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One row per widget in `kinds` (the host's group, data-ovs-widgets): on or off, where, how it looks, how big. */
export function buildWidgetRows(host: HTMLElement, kinds: readonly WidgetKind[] = WIDGET_GROUPS[host.dataset.ovsWidgets as keyof typeof WIDGET_GROUPS] ?? WIDGET_KINDS): void {
  const doc = host.ownerDocument;
  host.replaceChildren(
    ...kinds.map((kind) => {
      const row = el(doc, 'div', { class: 'ovs-widget', 'data-kind': kind });
      const check = el(doc, 'label', { class: 'ovs-check' });
      const box = el(doc, 'input', { type: 'checkbox', name: `w-${kind}` });
      const words = el(doc, 'span', {}, WIDGET_NAMES[kind]);
      words.append(' ', el(doc, 'em', {}, WIDGET_HINTS[kind]));
      check.append(box, words);
      const where = el(doc, 'label', { class: 'ovs-field ovs-field--row ovs-widget__where' }, 'where');
      const select = el(doc, 'select', { name: `slot-${kind}` });
      const slots = kind === 'strip' ? (['top-center', 'bottom-center'] as const) : SLOTS;
      for (const slot of slots) select.append(el(doc, 'option', { value: slot }, kind === 'strip' ? (slot === 'top-center' ? 'along the top' : 'along the bottom') : SLOT_NAMES[slot]));
      where.append(select);
      const styles = WIDGET_STYLES[kind];
      const look = styles ? el(doc, 'label', { class: 'ovs-field ovs-field--row ovs-widget__style' }, 'style') : null;
      if (look && styles) {
        const pick = el(doc, 'select', { name: `style-${kind}` });
        for (const [id, name] of Object.entries(styles)) pick.append(el(doc, 'option', { value: id }, name));
        look.append(pick);
      }
      const size = el(doc, 'label', { class: 'ovs-field ovs-field--row ovs-widget__size' }, 'size');
      size.append(el(doc, 'input', { type: 'range', name: `scale-${kind}`, min: '50', max: '200', step: '10', value: '100' }), el(doc, 'output', { name: `scaleOut-${kind}` }, '100%'));
      row.append(check, where, ...(look ? [look] : []), size);
      return row;
    }),
  );
}

/** The form as a config. */
export function configFrom(form: HTMLFormElement): OverlayConfig {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? '');
  const number = (name: string, fallback: number) => {
    const n = Number(text(name));
    return text(name) !== '' && Number.isFinite(n) ? n : fallback;
  };
  const widgets = WIDGET_KINDS.filter((kind) => data.has(`w-${kind}`)).map((kind) => {
    const style = styleFor(kind, text(`style-${kind}`));
    return { kind, slot: (text(`slot-${kind}`) || WIDGET_HOME[kind]) as Slot, scale: number(`scale-${kind}`, 100), ...(style ? { style } : {}) };
  });
  return {
    poe: { show: data.has('poe'), side: text('side') === 'left' ? 'left' : 'right', scale: number('poeScale', 100) },
    widgets,
    chat: data.has('chat'),
    follows: data.has('follows'),
    alerts: data.has('alerts'),
    visitors: data.has('visitors'),
    ignore: [...new Set(text('ignore').split(/[\s,]+/).map(actorOf).filter((a): a is string => a !== null))],
    volume: number('volume', DEFAULT_CONFIG.volume),
    nap: number('nap', DEFAULT_CONFIG.nap),
    theme: text('theme') === 'dark' ? 'dark' : 'light',
  };
}

/** Puts a config into the form. */
export function fillForm(form: HTMLFormElement, c: OverlayConfig): void {
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
  const radio = (name: string, value: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  input('poe')!.checked = c.poe.show;
  radio('side', c.poe.side)!.checked = true;
  input('poeScale')!.value = String(c.poe.scale);
  for (const key of ['chat', 'follows', 'alerts', 'visitors'] as const) input(key)!.checked = c[key];
  (form.elements.namedItem('nap') as HTMLSelectElement).value = [0, 2, 5, 10, 20, 30].includes(c.nap) ? String(c.nap) : '5';
  input('volume')!.value = String(c.volume);
  radio('theme', c.theme)!.checked = true;
  (form.elements.namedItem('ignore') as HTMLTextAreaElement).value = c.ignore.join('\n');
  for (const kind of WIDGET_KINDS) {
    const w = c.widgets.find((x) => x.kind === kind);
    input(`w-${kind}`)!.checked = Boolean(w);
    (form.elements.namedItem(`slot-${kind}`) as HTMLSelectElement).value = w?.slot ?? WIDGET_HOME[kind];
    input(`scale-${kind}`)!.value = String(w?.scale ?? 100);
    const pick = form.elements.namedItem(`style-${kind}`) as HTMLSelectElement | null;
    if (pick) pick.value = styleFor(kind, w?.style) ?? '';
  }
}

/** Every widget group's rows, in the form. */
export function buildAllWidgetRows(form: ParentNode): void {
  for (const host of form.querySelectorAll<HTMLElement>('[data-ovs-widgets]')) buildWidgetRows(host);
}

/** Shows each range's value beside it, greys out the controls of widgets that are off, and counts what's on in each group. */
function reflect(form: HTMLFormElement, c: OverlayConfig): void {
  for (const [group, kinds] of Object.entries(WIDGET_GROUPS)) {
    const n = c.widgets.filter((w) => kinds.includes(w.kind)).length;
    const badge = form.querySelector<HTMLElement>(`[data-ovs-count="${group}"]`);
    if (badge) badge.textContent = n ? `${n} on` : '';
  }
  const out = (name: string) => form.querySelector<HTMLOutputElement>(`output[name="${name}"]`);
  const set = (name: string, text: string) => {
    const o = out(name);
    if (o) o.value = text;
  };
  set('volumeOut', c.volume > 0 ? String(c.volume) : 'off');
  set('poeScaleOut', `${c.poe.scale}%`);
  for (const kind of WIDGET_KINDS) {
    const row = form.querySelector<HTMLElement>(`.ovs-widget[data-kind="${kind}"]`);
    const on = c.widgets.some((w) => w.kind === kind);
    row?.classList.toggle('is-off', !on);
    set(`scaleOut-${kind}`, `${(form.elements.namedItem(`scale-${kind}`) as HTMLInputElement).value}%`);
  }
}

/** A layout's URL for OBS: the main one's has no &layout=. */
export function overlayUrl(streamer: string, origin: string, layout: string = OVERLAY_RKEY): string {
  return `${origin}/overlay?streamer=${streamer}${layout === OVERLAY_RKEY ? '' : `&layout=${layout}`}`;
}

export interface LayoutEntry {
  id: string;
  name: string;
  config: OverlayConfig;
  createdAt: string;
  note: string;
  /** In the streamer's repo (so removing it means deleting the record). */
  saved: boolean;
}

const mainLayout = (): LayoutEntry => ({ id: OVERLAY_RKEY, name: MAIN_LAYOUT_NAME, config: copyConfig(DEFAULT_CONFIG), createdAt: new Date().toISOString(), note: SETUP_COPY.fresh, saved: false });

/** In order: the main layout (saved or its defaults), then the rest oldest first. */
export function layoutsFrom(saved: SavedLayout[]): LayoutEntry[] {
  const entries = saved.map((l) => ({ ...l, note: SETUP_COPY.loaded, saved: true }));
  return entries.some((l) => l.id === OVERLAY_RKEY) ? entries : [mainLayout(), ...entries];
}

/** Where the address says the studio is. */
export function routeOf(hash: string): { view: 'layout' | 'screen'; id: string } | null {
  const m = /^#(layout|screen)\/([a-z0-9][a-z0-9-]{0,47})$/.exec(hash);
  return m ? { view: m[1] as 'layout' | 'screen', id: m[2]! } : null;
}

type State = 'checking' | 'unavailable' | 'signed-out' | 'signed-in';

export interface SetupOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to sharedAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  /** Saving and removing, for tests. */
  save?: (session: Session, id: string, config: OverlayConfig, name: string, createdAt: string) => Promise<void>;
  remove?: (session: Session, id: string) => Promise<void>;
  saveScreen?: (session: Session, id: string, scene: ScreenEntry['scene'], createdAt: string) => Promise<void>;
  removeScreen?: (session: Session, id: string) => Promise<void>;
  confirm?: (question: string) => boolean;
}

export async function init(opts: SetupOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const root = doc.querySelector<HTMLElement>('[data-ovs]');
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const save = opts.save ?? ((s: Session, id: string, c: OverlayConfig, name: string, createdAt: string) => saveConfig(s, c, createdAt, new Date(), id, name));
  const remove = opts.remove ?? ((s: Session, id: string) => deleteLayout(s, id));
  const saveScreen = opts.saveScreen ?? ((s: Session, id: string, scene: ScreenEntry['scene'], createdAt: string) => saveScene(s, id, scene, createdAt));
  const removeScreen = opts.removeScreen ?? ((s: Session, id: string) => deleteScene(s, id));
  const confirm = opts.confirm ?? ((question: string) => win.confirm(question));

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const library = q('[data-ovs-library]');
  const editor = q('[data-ovs-editor]');
  const screenRoot = q('[data-ovs-scenes]');
  const form = q<HTMLFormElement>('[data-ovs-form]');
  const frame = q<HTMLIFrameElement>('[data-ovs-frame]');
  const preview = q<HTMLElement>('[data-ovs-preview]');
  const url = q<HTMLTextAreaElement>('[data-ovs-url]');
  const full = q<HTMLButtonElement>('[data-ovs-full]');
  const copy = q<HTMLButtonElement>('[data-ovs-copy]');
  const open = q<HTMLAnchorElement>('[data-ovs-open]');
  const status = q<HTMLElement>('[data-ovs-status]');
  const saved = q<HTMLElement>('[data-ovs-saved]');
  const reconsent = q<HTMLButtonElement>('[data-ovs-reconsent]');
  const who = q<HTMLElement>('[data-ovs-who]');
  const heading = q<HTMLElement>('[data-ovs-layout-heading]');
  const removeLayoutButton = q<HTMLButtonElement>('[data-ovs-layout-remove]');
  const layoutList = q<HTMLElement>('[data-ovs-layout-list]');
  const screenList = q<HTMLElement>('[data-ovs-screen-list]');
  const layoutsNote = q<HTMLElement>('[data-ovs-layouts-note]');
  const screensNote = q<HTMLElement>('[data-ovs-screens-note]');
  buildAllWidgetRows(form);

  let session: Session | null = null;
  let streamer = '';
  let layouts: LayoutEntry[] = [];
  let screens: ScreenEntry[] = [];
  let layout: LayoutEntry | null = null;
  let saveTimer: number | undefined;
  let previewTimer: number | undefined;
  let shown = '';

  const setState = (state: State) => {
    root.dataset.state = state;
    q('[data-ovs-signin]').hidden = state !== 'signed-out';
    q('[data-ovs-unavailable]').hidden = state !== 'unavailable';
    if (state !== 'signed-in') library.hidden = editor.hidden = screenRoot.hidden = true;
    if (state === 'checking') who.textContent = SETUP_COPY.checking;
    else if (state !== 'signed-in') who.textContent = SETUP_COPY.signedOut;
  };

  const askSignIn = () => win.dispatchEvent(new Event(SIGNIN_EVENT));
  q<HTMLButtonElement>('[data-ovs-signin-button]').addEventListener('click', askSignIn);
  reconsent.addEventListener('click', askSignIn);

  /** A refused save: a sign-in from before the overlay permission asks to sign in again. */
  const failed = (error: unknown): string => {
    const trouble = troubleFrom(error);
    if (trouble) reconsent.hidden = false;
    return trouble ? SETUP_COPY.reconsent : SETUP_COPY.failed;
  };

  const copyText = async (text: string, field?: HTMLTextAreaElement) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      field?.select();
      return false;
    }
  };

  // ---------- the library ----------

  const main = () => layouts.find((l) => l.id === OVERLAY_RKEY) ?? layouts[0]!;

  const renderLibrary = () => {
    if (!session) return;
    layoutList.replaceChildren(
      ...layouts.map((l) =>
        card(
          doc,
          {
            id: l.id,
            name: l.name,
            badge: l.id === OVERLAY_RKEY ? 'main' : undefined,
            meta: layoutSummary(l.config),
            sketch: layoutSketch(doc, l.config),
            actions: [
              { label: 'edit', primary: true, run: () => go(`#layout/${l.id}`) },
              { label: 'copy URL', done: 'copied (◕‿◕)', run: () => copyText(overlayUrl(streamer, location.origin, l.id)) },
              { label: 'open', href: overlayUrl(streamer, location.origin, l.id) },
              { label: 'duplicate', run: () => void duplicate(l) },
            ],
          },
          win,
        ),
      ),
    );
    screenList.replaceChildren(
      ...screens.map((e) =>
        card(
          doc,
          {
            id: e.id,
            name: e.scene.name,
            meta: screenSummary(e.scene, e.id),
            sketch: screenSketch(doc, e.scene),
            actions: [
              { label: 'edit', primary: true, run: () => go(`#screen/${e.id}`) },
              { label: 'copy URL', done: 'copied (◕‿◕)', run: () => copyText(screenUrl(location.origin, streamer, e.id)) },
              { label: 'open', href: screenUrl(location.origin, streamer, e.id) },
            ],
          },
          win,
        ),
      ),
    );
  };

  // ---------- where the studio is ----------

  const route = () => {
    if (!session) return;
    const r = routeOf(win.location.hash);
    const l = r?.view === 'layout' ? layouts.find((x) => x.id === r.id) : undefined;
    const sc = r?.view === 'screen' ? screens.find((x) => x.id === r.id) : undefined;
    library.hidden = Boolean(l || sc);
    editor.hidden = !l;
    screenRoot.hidden = !sc;
    if (l) openLayout(l);
    else {
      flushLayout();
      layout = null;
    }
    if (sc) screenEditor.open(sc);
    else screenEditor.flush();
    if (!l && !sc) renderLibrary();
    win.scrollTo?.(0, 0);
  };

  /** Goes to a view (#layout/<id>, #screen/<id>, or '' for the library), as a new history entry. */
  const go = (hash: string) => {
    if (win.location.hash !== hash) {
      const path = `${win.location.pathname}${win.location.search}${hash}`;
      try {
        win.history.pushState(null, '', path);
      } catch {
        win.location.hash = hash;
      }
    }
    route();
  };
  win.addEventListener('popstate', route);
  win.addEventListener('hashchange', route);
  for (const back of root.querySelectorAll<HTMLAnchorElement>('[data-ovs-back]')) {
    back.addEventListener('click', (e) => {
      e.preventDefault();
      go('');
    });
  }

  // ---------- a layout ----------

  const showPreview = (c: OverlayConfig) => {
    win.clearTimeout(previewTimer);
    previewTimer = win.setTimeout(() => {
      const src = `/overlay${toSearch({ ...c, volume: 0 }, { demo: true, who: streamer || null })}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };

  const saveLayout = async (entry: LayoutEntry) => {
    const s = session;
    if (!s) return;
    if (layout === entry) saved.textContent = SETUP_COPY.saving;
    try {
      await save(s, entry.id, entry.config, entry.name, entry.createdAt);
      entry.saved = true;
      entry.note = SETUP_COPY.saved;
    } catch (error) {
      entry.note = failed(error);
    }
    if (session !== s) return;
    if (layout === entry) {
      saved.textContent = entry.note;
      showLayoutChrome(entry);
    }
  };

  const flushLayout = () => {
    if (saveTimer === undefined || !layout) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    void saveLayout(layout);
  };

  const showLayoutChrome = (entry: LayoutEntry) => {
    heading.textContent = entry.name;
    url.value = overlayUrl(streamer, location.origin, entry.id);
    open.href = url.value;
    const isMain = entry.id === OVERLAY_RKEY;
    removeLayoutButton.textContent = isMain ? 'reset to the defaults' : 'remove this layout';
    removeLayoutButton.hidden = isMain && !entry.saved;
  };

  function openLayout(entry: LayoutEntry) {
    if (layout !== entry) flushLayout();
    layout = entry;
    fillForm(form, entry.config);
    (form.elements.namedItem('layoutName') as HTMLInputElement).value = entry.name;
    reflect(form, entry.config);
    saved.textContent = entry.note;
    showLayoutChrome(entry);
    fit();
    showPreview(entry.config);
  }

  form.addEventListener('input', () => {
    const entry = layout;
    if (!entry) return;
    entry.config = configFrom(form);
    const name = cleanText(String(new FormData(form).get('layoutName') ?? ''), LAYOUT_NAME_MAX);
    entry.name = name || layoutNameOf({}, entry.id);
    reflect(form, entry.config);
    showLayoutChrome(entry);
    showPreview(entry.config);
    if (entry.id === OVERLAY_RKEY) screenEditor.refresh();
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(() => {
      saveTimer = undefined;
      void saveLayout(entry);
    }, SAVE_DELAY_MS);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  /** A new layout, saved now and opened. */
  const addLayout = (name: string, config: OverlayConfig, note: HTMLElement): LayoutEntry | null => {
    if (layouts.length >= MAX_LAYOUTS) {
      note.textContent = SETUP_COPY.layoutsFull;
      return null;
    }
    const clean = cleanText(name, LAYOUT_NAME_MAX) || 'new layout';
    const entry: LayoutEntry = { id: newLayoutId(clean, layouts.map((l) => l.id)), name: clean, config: copyConfig(config), createdAt: new Date().toISOString(), note: SETUP_COPY.added, saved: false };
    layouts.push(entry);
    note.textContent = '';
    void saveLayout(entry);
    go(`#layout/${entry.id}`);
    return entry;
  };

  const duplicate = (from: LayoutEntry) => addLayout(`${from.name} copy`, from.config, layoutsNote);

  const newLayoutForm = q<HTMLFormElement>('[data-ovs-new-layout-form]');
  newLayoutForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = String(new FormData(newLayoutForm).get('name') ?? '');
    if (addLayout(name, DEFAULT_CONFIG, layoutsNote)) {
      newLayoutForm.reset();
      q<HTMLDetailsElement>('[data-ovs-new-layout]').open = false;
    }
  });
  q<HTMLButtonElement>('[data-ovs-duplicate]').addEventListener('click', () => {
    if (layout) duplicate(layout);
  });

  removeLayoutButton.addEventListener('click', async () => {
    const entry = layout;
    const s = session;
    if (!entry || !s) return;
    const isMain = entry.id === OVERLAY_RKEY;
    if (!confirm(isMain ? `put "${entry.name}" back to its defaults?` : `remove "${entry.name}"? its URL will show the defaults.`)) return;
    win.clearTimeout(saveTimer);
    saveTimer = undefined;
    if (entry.saved) {
      try {
        await remove(s, entry.id);
      } catch (error) {
        saved.textContent = troubleFrom(error) ? failed(error) : SETUP_COPY.removeFailed;
        return;
      }
    }
    if (isMain) {
      Object.assign(entry, mainLayout(), { note: SETUP_COPY.reset });
      openLayout(entry);
      return;
    }
    layouts = layouts.filter((l) => l !== entry);
    layout = null;
    layoutsNote.textContent = SETUP_COPY.removed;
    go('');
  });

  copy.addEventListener('click', async () => {
    status.textContent = (await copyText(url.value, url)) ? 'copied (◕‿◕)' : 'select it and copy';
    win.setTimeout(() => (status.textContent = ''), 3000);
  });

  // the 1920x1080 overlay, scaled to the box it sits in
  const fit = () => preview.style.setProperty('--scale', String(preview.clientWidth / WIDTH));
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(preview);

  // full screen: the preview fills the screen (setup.css .is-full), until the button, Escape or a tap on it
  const setFull = (on: boolean) => {
    preview.classList.toggle('is-full', on);
    doc.documentElement.classList.toggle('ovs-full-open', on);
    full.textContent = on ? 'close' : 'full screen';
    full.setAttribute('aria-label', on ? 'close the full screen preview' : 'see the preview full screen');
    fit();
  };
  full.addEventListener('click', (e) => {
    e.stopPropagation();
    setFull(!preview.classList.contains('is-full'));
  });
  preview.addEventListener('click', () => {
    if (preview.classList.contains('is-full')) setFull(false);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && preview.classList.contains('is-full')) {
      setFull(false);
      full.focus();
    }
  });

  // ---------- a screen ----------

  const screenEditor = mountScreenEditor(screenRoot, {
    win,
    get streamer() {
      return streamer;
    },
    draft: () => main()?.config ?? DEFAULT_CONFIG,
    save: async (entry) => {
      const s = session;
      if (!s) return;
      try {
        await saveScreen(s, entry.id, entry.scene, entry.createdAt);
        entry.saved = true;
        entry.note = SCENE_COPY.saved;
      } catch (error) {
        entry.note = troubleFrom(error) ? (failed(error), SCENE_COPY.reconsent) : SCENE_COPY.failed;
      }
    },
    remove: async (entry) => {
      const s = session;
      if (!s) return;
      const starter = isSceneKind(entry.id);
      if (!confirm(starter ? `put "${entry.scene.name}" back to its defaults?` : `remove "${entry.scene.name}"? its URL will show the defaults.`)) return;
      if (entry.saved) {
        try {
          await removeScreen(s, entry.id);
        } catch (error) {
          entry.note = troubleFrom(error) ? (failed(error), SCENE_COPY.reconsent) : SCENE_COPY.removeFailed;
          screenEditor.note(entry);
          return;
        }
      }
      if (starter) {
        Object.assign(entry, { scene: copyScene(SCENE_DEFAULTS[entry.id as keyof typeof SCENE_DEFAULTS]), saved: false, note: SCENE_COPY.reset });
        screenEditor.open(entry);
        return;
      }
      screens = screens.filter((x) => x !== entry);
      screensNote.textContent = SCENE_COPY.removed;
      go('');
    },
  });

  const newScreenForm = q<HTMLFormElement>('[data-ovs-new-form]');
  newScreenForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (screens.length >= MAX_SCREENS) {
      screensNote.textContent = SETUP_COPY.screensFull;
      return;
    }
    const data = new FormData(newScreenForm);
    const kind = String(data.get('kind'));
    if (!isSceneKind(kind)) return;
    const name = cleanText(String(data.get('name') ?? ''), NAME_MAX) || SCENE_NAMES[kind];
    const id = newScreenId(name, kind, screens.map((x) => x.id).concat(SCENE_KINDS));
    const entry: ScreenEntry = { id, scene: { ...copyScene(SCENE_DEFAULTS[kind]), name }, createdAt: new Date().toISOString(), note: SCENE_COPY.added, saved: false };
    screens.push(entry);
    newScreenForm.reset();
    screensNote.textContent = '';
    q<HTMLDetailsElement>('[data-ovs-new]').open = false;
    go(`#screen/${id}`);
    void (async () => {
      const s = session;
      if (!s) return;
      try {
        await saveScreen(s, entry.id, entry.scene, entry.createdAt);
        entry.saved = true;
      } catch (error) {
        entry.note = troubleFrom(error) ? (failed(error), SCENE_COPY.reconsent) : SCENE_COPY.failed;
      }
      screenEditor.note(entry);
    })();
  });

  // Signing out in the header ends it here too.
  win.addEventListener(SESSION_EVENT, (event) => {
    if ((event as CustomEvent<SessionEventDetail>).detail?.did) return;
    session = null;
    setState('signed-out');
  });

  if (!auth) return setState('unavailable');
  if (!auth.eager) return setState('signed-out');
  setState('checking');
  const result = await auth.start().catch(() => null);
  if (!result?.session) return setState('signed-out');
  const s = (session = result.session);
  layoutsNote.textContent = screensNote.textContent = SETUP_COPY.reading;
  const [me, ownLayouts, ownScreens] = await Promise.all([loadMe(fetchImpl, s.did), listOwnLayouts(s, fetchImpl), listOwnScenes(s, fetchImpl)]);
  if (session !== s) return;
  const handle = me.handle.startsWith('did:') ? null : me.handle;
  streamer = handle ?? s.did;
  who.textContent = SETUP_COPY.who(handle ? `@${handle}` : s.did);
  layouts = layoutsFrom(ownLayouts ?? []);
  screens = screensFrom(ownScreens ?? []);
  layoutsNote.textContent = ownLayouts ? '' : SETUP_COPY.layoutsUnreadable;
  screensNote.textContent = ownScreens ? '' : SETUP_COPY.screensUnreadable;
  if (!ownLayouts) main().note = SETUP_COPY.unreadable;
  setState('signed-in');
  route();
}
