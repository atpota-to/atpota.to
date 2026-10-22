/**
 * /overlay/setup: where a streamer sets up their overlay. It needs a sign-in, because the
 * settings are saved in the streamer's own repo (to.atpota.poe.overlay at "self",
 * config.ts and store.ts): the same on every computer and phone, and the overlay in OBS
 * follows them live. The overlay's URL is the same for good, /overlay?streamer=<handle>.
 *
 *   checking     a remembered sign-in is being restored
 *   unavailable  signing in doesn't work on this host (only atpota.to)
 *   signed-out   a button to sign in (the header's dialog, src/scripts/account.ts)
 *   signed-in    the form, loaded from the saved record (or the defaults), saved
 *                SAVE_DELAY_MS after the last change; a preview of the overlay with ?demo
 *                over a pretend stream; the URL to paste into OBS
 *
 * Under them, the scenes (setup-scenes.ts): starting soon, be right back, the end and the
 * screen share, each saved as its own record.
 *
 * A sign-in from before the overlay permission existed can't save (403): the page asks
 * the streamer to sign in again. The preview is the real overlay in an iframe at
 * 1920x1080, scaled down to fit, with the draft in its URL so it shows changes before
 * they're saved; on a phone that's tiny, so it also opens full screen.
 *
 * DOM is built with createElement and textContent only.
 */

import { SESSION_EVENT, sharedAuth, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import { loadMe } from '../blog/signin';
import { troubleFrom } from '../scripts/pet-sync';
import { actorOf, copyConfig, DEFAULT_CONFIG, SLOTS, WIDGET_HINTS, WIDGET_HOME, WIDGET_KINDS, WIDGET_NAMES, type OverlayConfig, type Slot, type WidgetKind } from './config';
import { toSearch } from './params';
import { mountScenes, type ScenesOptions } from './setup-scenes';
import { readOwnConfig, saveConfig } from './store';

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

/** One row per widget: on or off, where, how big. */
export function buildWidgetRows(host: HTMLElement): void {
  const doc = host.ownerDocument;
  host.replaceChildren(
    ...WIDGET_KINDS.map((kind) => {
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
      const size = el(doc, 'label', { class: 'ovs-field ovs-field--row ovs-widget__size' }, 'size');
      size.append(el(doc, 'input', { type: 'range', name: `scale-${kind}`, min: '50', max: '200', step: '10', value: '100' }), el(doc, 'output', { name: `scaleOut-${kind}` }, '100%'));
      row.append(check, where, size);
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
  const widgets = WIDGET_KINDS.filter((kind) => data.has(`w-${kind}`)).map((kind) => ({
    kind,
    slot: (text(`slot-${kind}`) || WIDGET_HOME[kind]) as Slot,
    scale: number(`scale-${kind}`, 100),
  }));
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
  }
}

/** Shows each range's value beside it, and greys out the controls of widgets that are off. */
function reflect(form: HTMLFormElement, c: OverlayConfig): void {
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

export function overlayUrl(streamer: string, origin: string): string {
  return `${origin}/overlay?streamer=${streamer}`;
}

type State = 'checking' | 'unavailable' | 'signed-out' | 'signed-in';

export interface SetupOptions {
  doc?: Document;
  win?: Window;
  /** Defaults to sharedAuth(win); null means signing in isn't offered on this host. */
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  /** Saving, for tests. */
  save?: (session: Session, config: OverlayConfig, createdAt: string) => Promise<void>;
  /** The scenes section's, for tests. */
  scenes?: ScenesOptions;
}

export async function init(opts: SetupOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const root = doc.querySelector<HTMLElement>('[data-ovs]');
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const save = opts.save ?? ((s: Session, c: OverlayConfig, createdAt: string) => saveConfig(s, c, createdAt));

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
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
  buildWidgetRows(q('[data-ovs-widgets]'));

  let session: Session | null = null;
  let createdAt = new Date().toISOString();
  let saveTimer: number | undefined;
  let previewTimer: number | undefined;
  let shown = '';

  const setState = (state: State) => {
    root.dataset.state = state;
    q('[data-ovs-signin]').hidden = state !== 'signed-out';
    q('[data-ovs-unavailable]').hidden = state !== 'unavailable';
    q('[data-ovs-editor]').hidden = state !== 'signed-in';
    if (state !== 'signed-in') q('[data-ovs-scenes]').hidden = true;
    if (state === 'checking') who.textContent = SETUP_COPY.checking;
    else if (state !== 'signed-in') who.textContent = SETUP_COPY.signedOut;
  };

  const askSignIn = () => win.dispatchEvent(new Event(SIGNIN_EVENT));
  q<HTMLButtonElement>('[data-ovs-signin-button]').addEventListener('click', askSignIn);
  reconsent.addEventListener('click', askSignIn);

  const showPreview = (c: OverlayConfig) => {
    win.clearTimeout(previewTimer);
    previewTimer = win.setTimeout(() => {
      const src = `/overlay${toSearch({ ...c, volume: 0 }, { demo: true })}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };

  const saveNow = async () => {
    const s = session;
    if (!s) return;
    const c = configFrom(form);
    saved.textContent = SETUP_COPY.saving;
    try {
      await save(s, c, createdAt);
      if (session === s) saved.textContent = SETUP_COPY.saved;
    } catch (error) {
      if (session !== s) return;
      const trouble = troubleFrom(error);
      saved.textContent = trouble ? SETUP_COPY.reconsent : SETUP_COPY.failed;
      reconsent.hidden = !trouble;
    }
  };

  let scenes: { refresh(): void } | null = null;
  form.addEventListener('input', () => {
    const c = configFrom(form);
    reflect(form, c);
    showPreview(c);
    scenes?.refresh();
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

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

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      status.textContent = 'copied (◕‿◕)';
    } catch {
      url.select();
      status.textContent = 'select it and copy';
    }
    win.setTimeout(() => (status.textContent = ''), 3000);
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
  const [me, own] = await Promise.all([loadMe(fetchImpl, s.did), readOwnConfig(s, fetchImpl)]);
  if (session !== s) return;
  const handle = me.handle.startsWith('did:') ? null : me.handle;
  who.textContent = SETUP_COPY.who(handle ? `@${handle}` : s.did);
  const config = own ? own.config : copyConfig(DEFAULT_CONFIG);
  if (own) createdAt = own.createdAt;
  saved.textContent = own ? SETUP_COPY.loaded : own === null ? SETUP_COPY.fresh : SETUP_COPY.unreadable;
  fillForm(form, config);
  reflect(form, config);
  url.value = overlayUrl(handle ?? s.did, location.origin);
  open.href = url.value;
  setState('signed-in');
  fit();
  showPreview(config);
  scenes = mountScenes(q('[data-ovs-scenes]'), s, handle ?? s.did, () => configFrom(form), () => (reconsent.hidden = false), opts.scenes);
}
