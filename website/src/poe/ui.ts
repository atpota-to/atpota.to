/**
 * The Poe widget (SPEC 4.6): corner potato, nudge bubble, panel (desktop dialog /
 * phone bottom sheet), and the highlight-to-ask pill.
 *
 * DOM is built with createElement/textContent only. Answer text goes through
 * render.ts; nothing else from the network is rendered except status labels
 * (textContent).
 */

import { sharedAuth } from '../blog/auth';
import { MASCOT_ARM_URL, MASCOT_URLS, MASCOT_WAVE_URL } from '../scripts/mascot';
import { askPoe, buildRequest, resetConversation, type PoeError } from './client';
import { CHIPS_DEFAULT, CHIPS_GUIDE, COPY, DIGGING_LINES, contextLabel, noteCopy } from './copy';
import { icon } from './icons';
import { PoeIdentity, readWho, saveWho, type Who } from './identity';
import { BLINK_GAP_MS, BLINK_MS, CHEER_MS, GLANCE_MS, WAKE_MS, WAVE_MS, idleGap, nextBeat, shouldNap, startIdle, type IdleBeat } from './idle';
import { ERROR_MS, FOUND_MS, cornerMood, faceUrl, perchedMood, type Mood, type MoodState } from './moods';
import { renderAnswer, splitTrailingFace } from './render';
import { ASKABLE_SELECTOR, currentSection, getAskableSelection, pillPosition, type Rect } from './selection';
import { isSlashShortcut, isTypingTarget, otherModalOpen } from './shortcuts';
import {
  loadTranscript,
  markNudged,
  MAX_TRANSCRIPT,
  saveTranscript,
  clearTranscript,
  session as sessionStore,
  wasNudged,
  type NoteCode,
  type TranscriptEntry,
} from './storage';

export const PHONE_QUERY = '(max-width: 639.98px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const NUDGE_DELAY_MS = 4000;
const NUDGE_AUTO_HIDE_MS = 25_000;
const NUDGE_SCROLL_HIDE_PX = 40;
const HOME_NUDGE_MIN_WIDTH = 420;
const CLOSE_ANIMATION_MS = 220;
const PILL_SETTLE_MS = 180;
const SWIPE_CLOSE_PX = 90;
const QUOTE_DISPLAY_MAX = 140;
const RESET_TIMEOUT_MS = 5000;
/** Where "sign in" goes from a page without the blog's sign-in dialog. */
export const SIGN_IN_HREF = '/blog#sign-in';

export interface PoeWidgetOptions {
  doc?: Document;
  win?: Window & typeof globalThis;
  fetchImpl?: typeof fetch;
  nudgeDelayMs?: number;
  /** Who the reader is on Bluesky. Defaults to the page's shared sign-in; null turns it off. */
  identity?: PoeIdentity | null;
}

type OpenVia = 'pointer' | 'keyboard' | 'event' | 'pill';

interface Rendered {
  entry: TranscriptEntry;
  el: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function lastNonEmptyIndex(blocks: Array<string | undefined>): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i];
    if (text && text.trim()) return i;
  }
  return -1;
}

function lastNonEmpty(blocks: Array<string | undefined>): string {
  const i = lastNonEmptyIndex(blocks);
  return i === -1 ? '' : (blocks[i] as string);
}

function toRect(r: DOMRect | { top: number; left: number; bottom: number; right: number; width: number; height: number }): Rect {
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
}

export class PoeWidget {
  readonly doc: Document;
  readonly win: Window & typeof globalThis;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly nudgeDelay: number;
  private readonly page: string;

  // elements
  readonly root: HTMLDivElement;
  readonly potato: HTMLButtonElement;
  private readonly potatoImg: HTMLImageElement;
  readonly nudge: HTMLDivElement;
  private readonly nudgeText: HTMLParagraphElement;
  readonly scrim: HTMLDivElement;
  readonly panel: HTMLElement;
  private readonly perchedImg: HTMLImageElement;
  readonly log: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly statusText: HTMLSpanElement;
  readonly chips: HTMLDivElement;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly sendBtn: HTMLButtonElement;
  readonly newChatBtn: HTMLButtonElement;
  readonly closeBtn: HTMLButtonElement;
  readonly live: HTMLDivElement;
  readonly pill: HTMLButtonElement;
  /** "poe knows you as @handle", or a link to sign in (identity.ts). */
  readonly account: HTMLParagraphElement;
  private readonly handle: HTMLDivElement;
  private readonly head: HTMLDivElement;

  private readonly identity: PoeIdentity | null;
  private readonly ownsIdentity: boolean;

  // state
  private isOpen = false;
  private busy = false;
  private nudging = false;
  private nudgeDone = false;
  private hoverPointer = false;
  private hoverFocus = false;
  private turnMood: Mood | null = null;
  /** The face an idle beat is showing on the resting corner potato (idle.ts). */
  private idleSrc: string | null = null;
  private idlePlan = startIdle();
  /** Last pointer, key, wheel, touch or scroll input, for the nap (idle.ts). */
  private lastInputAt = Date.now();
  private napping = false;
  private everOpened = false;
  private modal = false;
  private rendered = false;
  private transcript: TranscriptEntry[] = [];
  private renderedEntries: Rendered[] = [];
  private opener: Element | null = null;
  private openerWasBody = false;
  private inerted: Element[] = [];
  private turnController: AbortController | null = null;
  /** The DELETE from "new chat", while it is in flight. The next question waits for it. */
  private resetting: Promise<boolean> | null = null;
  /** A back/forward cache restore arrived mid-turn: re-read storage once the turn ends. */
  private pendingResync = false;
  private pillText: string | null = null;
  private pillPressed = false;
  private pointerDown = false;
  private nudgeScrollY = 0;

  // timers
  private moodTimer: number | undefined;
  private nudgeTimer: number | undefined;
  private nudgeHideTimer: number | undefined;
  private hideTimer: number | undefined;
  private pillTimer: number | undefined;
  private announceTimer: number | undefined;
  private idleTimer: number | undefined;
  private idleFrameTimer: number | undefined;
  private wakeTimer: number | undefined;

  private readonly cleanups: Array<() => void> = [];
  private phoneQuery: MediaQueryList | null = null;

  constructor(options: PoeWidgetOptions = {}) {
    this.doc = options.doc ?? document;
    this.win = options.win ?? (window as Window & typeof globalThis);
    this.fetchImpl = options.fetchImpl;
    this.nudgeDelay = options.nudgeDelayMs ?? NUDGE_DELAY_MS;
    this.page = this.doc.body.dataset.page ?? '';
    this.ownsIdentity = options.identity === undefined;
    this.identity = options.identity === undefined ? new PoeIdentity(sharedAuth(this.win), { win: this.win, store: sessionStore() }) : options.identity;
    const d = this.doc;

    this.root = el(d, 'div', { class: 'poe', id: 'poe-root' });

    // nudge bubble
    this.nudge = el(d, 'div', { class: 'poe-nudge' });
    this.nudge.hidden = true;
    this.nudgeText = el(d, 'p', { class: 'poe-nudge__text' });
    const nudgeClose = el(d, 'button', { class: 'poe-nudge__close', type: 'button', 'aria-label': COPY.dismissNudge });
    nudgeClose.appendChild(icon(d, 'close'));
    this.nudge.append(this.nudgeText, nudgeClose);

    // corner potato
    this.potato = el(d, 'button', {
      class: 'poe-potato',
      type: 'button',
      'aria-label': COPY.askPoe,
      'aria-keyshortcuts': '/',
      'aria-expanded': 'false',
      'aria-controls': 'poe-panel',
    });
    const potatoLabel = el(d, 'span', { class: 'poe-potato__label', 'aria-hidden': 'true' }, COPY.askPoe);
    this.potatoImg = el(d, 'img', { class: 'poe-potato__img', alt: '', width: '136', height: '111', draggable: 'false', decoding: 'async' });
    this.potatoImg.src = faceUrl('resting');
    // The leaf arm on its own, behind the body; it shows only while Poe waves.
    const potatoArm = el(d, 'img', { class: 'poe-potato__arm', alt: '', width: '136', height: '111', draggable: 'false', decoding: 'async' });
    potatoArm.src = MASCOT_ARM_URL;
    // The z's that float up while Poe naps.
    const zzz = el(d, 'span', { class: 'poe-potato__zzz', 'aria-hidden': 'true' });
    for (let i = 0; i < 3; i++) zzz.appendChild(el(d, 'i', {}, 'z'));
    this.potato.append(potatoLabel, this.potatoImg, potatoArm, zzz);

    // highlight-to-ask pill
    this.pill = el(d, 'button', { class: 'poe-pill', type: 'button' });
    this.pill.hidden = true;
    const pillFace = el(d, 'span', { class: 'poe-pill__face', 'aria-hidden': 'true' });
    const pillImg = el(d, 'img', { alt: '', width: '26', height: '21', draggable: 'false' });
    pillImg.src = faceUrl('curious');
    pillFace.appendChild(pillImg);
    this.pill.append(pillFace, el(d, 'span', { class: 'poe-pill__label' }, COPY.pill));

    // scrim (phone sheet)
    this.scrim = el(d, 'div', { class: 'poe-scrim' });
    this.scrim.hidden = true;

    // panel
    this.panel = el(d, 'section', {
      class: 'poe-panel',
      id: 'poe-panel',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': 'poe-title',
      'aria-describedby': 'poe-sub',
      tabindex: '-1',
    });
    this.panel.hidden = true;
    this.perchedImg = el(d, 'img', { class: 'poe-panel__potato', alt: '', width: '112', height: '91', draggable: 'false', decoding: 'async' });
    this.perchedImg.src = faceUrl('curious');
    this.handle = el(d, 'div', { class: 'poe-panel__handle', 'aria-hidden': 'true' });

    this.head = el(d, 'div', { class: 'poe-panel__head' });
    const titles = el(d, 'div', { class: 'poe-panel__titles' });
    titles.append(el(d, 'h2', { class: 'poe-panel__title', id: 'poe-title' }, COPY.title), el(d, 'p', { class: 'poe-panel__sub', id: 'poe-sub' }, COPY.subtitle));
    this.closeBtn = el(d, 'button', { class: 'poe-close', type: 'button', 'aria-label': COPY.close });
    this.closeBtn.appendChild(icon(d, 'close'));
    this.head.append(titles, this.closeBtn);

    const guideTitle = this.page === 'guide' ? (d.querySelector('.guide__title, main h1')?.textContent ?? null) : null;
    const ctx = contextLabel(this.page, guideTitle);
    const context = el(d, 'p', { class: 'poe-context' });
    if (ctx.icon) context.appendChild(icon(d, ctx.icon));
    context.appendChild(el(d, 'span', {}, `${ctx.prefix}${ctx.text}`));

    this.log = el(d, 'div', { class: 'poe-log', role: 'region', 'aria-label': COPY.conversation, tabindex: '0' });
    const greeting = el(d, 'div', { class: 'poe-msg poe-msg--poe poe-msg--greeting' });
    greeting.append(el(d, 'span', { class: 'poe-sr' }, COPY.poeSaid + ' '), el(d, 'p', {}, COPY.greeting));
    this.status = el(d, 'div', { class: 'poe-status' });
    this.status.hidden = true;
    const dots = el(d, 'span', { class: 'poe-dots', 'aria-hidden': 'true' });
    dots.append(el(d, 'i'), el(d, 'i'), el(d, 'i'));
    this.statusText = el(d, 'span', { class: 'poe-status__text' });
    this.status.append(dots, this.statusText);
    // Suggestion chips follow the conversation, inside the scrolling log.
    this.chips = el(d, 'div', { class: 'poe-chips', role: 'group', 'aria-label': COPY.suggestions });
    this.log.append(greeting, this.status, this.chips);

    this.form = el(d, 'form', { class: 'poe-form', novalidate: '' });
    const label = el(d, 'label', { class: 'poe-sr', for: 'poe-input' }, COPY.inputLabel);
    this.input = el(d, 'input', {
      class: 'poe-input',
      id: 'poe-input',
      type: 'text',
      maxlength: '1000',
      autocomplete: 'off',
      enterkeyhint: 'send',
      spellcheck: 'true',
      placeholder: COPY.placeholder,
    });
    this.sendBtn = el(d, 'button', { class: 'poe-send', type: 'submit', 'aria-label': COPY.send });
    this.sendBtn.appendChild(icon(d, 'send'));
    this.form.append(label, this.input, this.sendBtn);

    this.account = el(d, 'p', { class: 'poe-account' });
    this.account.hidden = true;

    const foot = el(d, 'p', { class: 'poe-foot' });
    // Phones get no "/" hint: there is no key to press (.only-hover hides it on touch screens).
    const slashHint = el(d, 'span', { class: 'only-hover' });
    slashHint.append(d.createTextNode(COPY.footnoteBefore), el(d, 'kbd', { class: 'poe-kbd' }, '/'), d.createTextNode(COPY.footnoteAfter));
    foot.append(d.createTextNode(COPY.footnoteLead), slashHint);
    const actions = el(d, 'div', { class: 'poe-actions' });
    this.newChatBtn = el(d, 'button', { class: 'poe-textbtn', type: 'button' }, COPY.newChat);
    actions.append(this.newChatBtn);

    this.panel.append(this.perchedImg, this.handle, this.head, context, this.log, this.form, this.account, foot, actions);

    // live region lives outside the panel so answers are announced even when it is closed
    this.live = el(d, 'div', { class: 'poe-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });

    this.root.append(this.nudge, this.potato, this.pill, this.scrim, this.panel, this.live);
  }

  /* ------------------------------------------------------------------ mount */

  mount(): void {
    const { doc, win } = this;
    doc.body.appendChild(this.root);
    doc.documentElement.classList.add('has-poe');

    this.transcript = loadTranscript();
    this.renderChips();
    this.syncOpeners();
    this.updateMoods();

    if (typeof win.matchMedia === 'function') {
      this.phoneQuery = win.matchMedia(PHONE_QUERY);
      const onChange = () => {
        if (this.isOpen) this.applyMode();
      };
      this.phoneQuery.addEventListener?.('change', onChange);
      this.cleanups.push(() => this.phoneQuery?.removeEventListener?.('change', onChange));
    }

    // corner potato
    this.on(this.potato, 'click', (e) => this.open({ opener: this.potato, via: (e as MouseEvent).detail === 0 ? 'keyboard' : 'pointer' }));
    this.on(this.potato, 'pointerenter', (e) => {
      if ((e as PointerEvent).pointerType === 'touch') return;
      this.hoverPointer = true;
      this.updateMoods();
    });
    this.on(this.potato, 'pointerleave', () => {
      this.hoverPointer = false;
      this.updateMoods();
    });
    this.on(this.potato, 'focus', () => {
      this.hoverFocus = true;
      this.updateMoods();
    });
    this.on(this.potato, 'blur', () => {
      this.hoverFocus = false;
      this.updateMoods();
    });

    // nudge
    this.on(this.nudge.querySelector('.poe-nudge__close') as HTMLElement, 'click', () => this.hideNudge());

    // panel controls
    this.on(this.closeBtn, 'click', () => this.close());
    this.on(this.scrim, 'click', () => this.close());
    this.on(this.form, 'submit', (e) => {
      e.preventDefault();
      const value = this.input.value;
      if (this.busy || !value.trim()) return;
      void this.send(value, { fromInput: true });
    });
    this.on(this.newChatBtn, 'click', () => {
      if (!this.busy) void this.newChat();
    });
    this.on(this.chips, 'click', (e) => {
      const chip = (e.target as Element | null)?.closest?.('button[data-chip]') as HTMLButtonElement | null;
      if (chip && !this.busy) this.askChip(chip.dataset.chip ?? '');
    });
    this.on(this.log, 'click', (e) => {
      const btn = (e.target as Element | null)?.closest?.('button[data-action="new-chat"]');
      if (btn && !this.busy) void this.newChat();
    });

    // pill
    this.on(this.pill, 'pointerdown', () => {
      this.pillPressed = true;
      win.setTimeout(() => (this.pillPressed = false), 1500);
    });
    this.on(this.pill, 'mousedown', (e) => e.preventDefault()); // keep the selection
    this.on(this.pill, 'click', () => this.askAboutSelection());
    this.on(this.pill, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.preventDefault();
        this.hidePill();
      }
    });

    // swipe the phone sheet down to close
    this.bindSwipe();

    // Keep the phone sheet above the on-screen keyboard (the layout viewport does not shrink).
    const vv = win.visualViewport;
    if (vv) {
      const onViewport = () => this.syncKeyboardInset();
      vv.addEventListener('resize', onViewport);
      vv.addEventListener('scroll', onViewport);
      this.cleanups.push(() => {
        vv.removeEventListener('resize', onViewport);
        vv.removeEventListener('scroll', onViewport);
      });
    }

    // document / window
    this.on(doc, 'click', (e) => this.onDocumentClick(e as MouseEvent));
    this.on(doc, 'keydown', (e) => this.onKeydown(e as KeyboardEvent));
    this.on(doc, 'selectionchange', () => this.onSelectionChange());
    this.on(doc, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true);
    this.on(doc, 'pointerup', () => {
      this.pointerDown = false;
      this.schedulePill(20);
    }, true);
    // A long-press selection on touch screens cancels the pointer instead of releasing it.
    this.on(doc, 'pointercancel', () => {
      this.pointerDown = false;
      this.schedulePill(PILL_SETTLE_MS);
    }, true);
    this.on(doc, 'keyup', (e) => {
      if ((e as KeyboardEvent).shiftKey || (e as KeyboardEvent).key === 'Shift') this.schedulePill(PILL_SETTLE_MS);
    });
    this.on(win, 'scroll', () => this.onScroll(), { passive: true, capture: true });
    this.on(win, 'resize', () => this.hidePill(), { passive: true });
    this.on(win, 'poe:open', () => this.open({ opener: doc.activeElement, via: 'event' }));
    this.on(win, 'poe:cheer', () => this.cheer());
    if (this.identity) {
      const off = this.identity.onChange(() => this.renderAccount());
      this.cleanups.push(off);
      this.on(this.account, 'click', (e) => this.onAccountClick(e));
    }
    this.on(win, 'pagehide', () => this.onPageHide());
    // Back/forward cache: the page comes back as it was left, while another page may have
    // moved the chat on. Catch up with storage before anything is saved.
    this.on(win, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) this.resyncFromStorage();
    });
    for (const type of ['keydown', 'wheel', 'touchstart'] as const) {
      this.on(win, type, () => this.noteActivity(), { passive: true, capture: true });
    }
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) {
      this.on(win, type, () => this.noteInput(), { passive: true, capture: true });
    }
    this.on(doc, 'visibilitychange', () => this.noteInput());

    this.scheduleNudge();
    this.scheduleIdle();
  }

  destroy(): void {
    for (const fn of this.cleanups.splice(0)) fn();
    for (const t of [this.moodTimer, this.nudgeTimer, this.nudgeHideTimer, this.hideTimer, this.pillTimer, this.announceTimer, this.idleTimer, this.idleFrameTimer, this.wakeTimer]) {
      if (t !== undefined) this.win.clearTimeout(t);
    }
    this.turnController?.abort();
    this.releaseModal();
    if (this.ownsIdentity) this.identity?.destroy();
    this.root.remove();
    this.doc.documentElement.classList.remove('has-poe');
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  /* ------------------------------------------------------------ open/close */

  get opened(): boolean {
    return this.isOpen;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private isPhone(): boolean {
    return this.phoneQuery?.matches ?? false;
  }

  private reducedMotion(): boolean {
    return typeof this.win.matchMedia === 'function' && this.win.matchMedia(REDUCED_MOTION_QUERY).matches;
  }

  open(options: { opener?: Element | null; via?: OpenVia } = {}): void {
    const { doc } = this;
    if (this.isOpen) {
      this.focusInput();
      return;
    }
    if (otherModalOpen(doc, this.root)) return;

    // The phone nav sheet traps focus; close it first.
    const navToggle = doc.querySelector<HTMLElement>('[data-nav-toggle][aria-expanded="true"]');
    navToggle?.click();

    const active = doc.activeElement;
    let opener = options.via === 'pill' ? null : (options.opener ?? active);
    if (opener && this.root.contains(opener) && opener !== this.potato) opener = null;
    if (opener === doc.body) opener = null;
    // "/" with nothing focused: closing puts focus back on the page, not on a widget control.
    this.openerWasBody = !opener && options.via !== 'pill';
    this.opener = opener;

    this.isOpen = true;
    this.everOpened = true;
    this.nudgeDone = true;
    this.win.clearTimeout(this.nudgeTimer);
    this.hideNudge();
    this.hidePill();
    this.ensureRendered();

    if (this.hideTimer !== undefined) {
      this.win.clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
    this.panel.hidden = false;
    this.panel.style.transform = '';
    delete this.root.dataset.handoff;
    this.root.dataset.open = 'true';
    this.applyMode();
    this.syncOpeners();
    this.updateMoods();

    // next frame: start the enter transition
    void this.panel.offsetWidth;
    this.panel.classList.add('is-open');

    // On phones only a keyboard opening puts the cursor in the input; a tap would pop the
    // on-screen keyboard over the sheet, so focus goes to the dialog itself.
    if (this.isPhone() && options.via !== 'keyboard') this.panel.focus({ preventScroll: true });
    else this.focusInput();
    this.scrollLog(true);
    // Who Poe will know them as; loads the sign-in library only for a remembered account.
    this.renderAccount();
    void this.identity?.prepare();
  }

  /* ---------------------------------------------------------------- account */

  private renderAccount(): void {
    const d = this.doc;
    const state = this.identity?.state;
    this.account.replaceChildren();
    if (state?.kind === 'signed-out' || state?.kind === 'needs-sign-in') {
      const again = state.kind === 'needs-sign-in';
      const link = el(d, 'a', { class: 'poe-account__link', href: SIGN_IN_HREF }, again ? COPY.signInAgainLink : COPY.signInLink);
      this.account.append(link, d.createTextNode(again ? COPY.signInAgainAfter : COPY.signInAfter));
    } else if (state?.kind === 'signed-in') {
      this.account.textContent = state.confirmed || state.handle ? COPY.knownAs(state.handle) : COPY.signedIn;
    }
    this.account.hidden = !this.account.firstChild;
  }

  /**
   * The sign-in dialog is on every page (the header partial brings it; src/blog/ui.ts or
   * src/scripts/account.ts answer "poe:signin"), so the panel hands over to it in place: the
   * panel tucks away as the dialog rises from Poe's corner, and closing the dialog without
   * signing in brings the chat back. Without a wired dialog the link goes to /blog#sign-in.
   */
  private onAccountClick(event: Event): void {
    const link = (event.target as Element | null)?.closest?.('a');
    const dialog = this.doc.querySelector<HTMLDialogElement>('dialog[data-blog-signin][data-poe-ready]');
    if (!link || !dialog) return;
    event.preventDefault();
    this.root.dataset.handoff = '';
    dialog.dataset.from = 'poe';
    const opener = this.opener;
    const back = () => {
      delete dialog.dataset.from;
      if (!this.isOpen) this.open({ opener, via: 'event' });
    };
    dialog.addEventListener('close', back, { once: true });
    this.close({ restoreFocus: false });
    this.win.dispatchEvent(new Event('poe:signin'));
    // Engines without showModal never fire "close"; the dialog stays as it was.
    if (!dialog.hasAttribute('open')) {
      dialog.removeEventListener('close', back);
      delete dialog.dataset.from;
    }
  }

  close(options: { restoreFocus?: boolean } = {}): void {
    if (!this.isOpen) return;
    const restore = options.restoreFocus ?? true;
    this.isOpen = false;
    this.panel.classList.remove('is-open');
    delete this.root.dataset.open;
    this.releaseModal();
    this.syncOpeners();
    this.updateMoods();

    const finish = () => {
      this.hideTimer = undefined;
      delete this.root.dataset.handoff;
      if (this.isOpen) return;
      this.panel.hidden = true;
      this.scrim.hidden = true;
      this.panel.style.transform = '';
    };
    if (this.reducedMotion()) finish();
    else this.hideTimer = this.win.setTimeout(finish, CLOSE_ANIMATION_MS);
    this.scrim.classList.remove('is-open');

    if (restore) this.restoreFocus();
  }

  toggle(opener: Element | null, via: OpenVia): void {
    if (this.isOpen) this.close();
    else this.open({ opener, via });
  }

  private focusInput(): void {
    this.input.focus({ preventScroll: true });
  }

  private restoreFocus(): void {
    const { doc } = this;
    const candidates: Array<Element | null | undefined> = [];
    if (this.opener) {
      candidates.push(this.opener);
      candidates.push(this.opener.closest('[data-site-header]')?.querySelector('[data-nav-toggle]'));
    }
    if (!this.openerWasBody) candidates.push(this.potato);
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !candidate.isConnected) continue;
      if (candidate.closest('[hidden], [inert]')) continue;
      candidate.focus({ preventScroll: true });
      if (doc.activeElement === candidate) return;
    }
    // Opened from nowhere in particular ("/" with nothing focused): put focus back on the page.
    const active = doc.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  /** Desktop: non-modal dialog. Phone: modal sheet with scrim, inert page, scroll lock. */
  private applyMode(): void {
    const phone = this.isPhone();
    this.root.dataset.mode = phone ? 'sheet' : 'panel';
    if (phone && !this.modal) {
      this.modal = true;
      this.panel.setAttribute('aria-modal', 'true');
      this.scrim.hidden = false;
      void this.scrim.offsetWidth;
      this.scrim.classList.add('is-open');
      this.doc.documentElement.classList.add('poe-locked');
      for (const child of Array.from(this.doc.body.children)) {
        if (child === this.root || child.hasAttribute('inert') || child.tagName === 'SCRIPT') continue;
        child.setAttribute('inert', '');
        this.inerted.push(child);
      }
    } else if (!phone && this.modal) {
      this.releaseModal();
      this.scrim.hidden = true;
    }
    this.syncKeyboardInset();
  }

  private syncKeyboardInset(): void {
    const vv = this.win.visualViewport;
    if (!vv || !this.isOpen || !this.modal) {
      this.panel.style.removeProperty('--poe-kb');
      return;
    }
    const inset = Math.max(0, Math.round(this.win.innerHeight - vv.height - vv.offsetTop));
    if (inset > 0) this.panel.style.setProperty('--poe-kb', `${inset}px`);
    else this.panel.style.removeProperty('--poe-kb');
  }

  private releaseModal(): void {
    this.panel.style.removeProperty('--poe-kb');
    if (!this.modal) return;
    this.modal = false;
    this.panel.setAttribute('aria-modal', 'false');
    this.doc.documentElement.classList.remove('poe-locked');
    for (const child of this.inerted.splice(0)) child.removeAttribute('inert');
  }

  private syncOpeners(): void {
    const expanded = String(this.isOpen);
    this.potato.setAttribute('aria-expanded', expanded);
    for (const opener of Array.from(this.doc.querySelectorAll('[data-poe-open]'))) {
      opener.setAttribute('aria-expanded', expanded);
      if (!opener.hasAttribute('aria-controls')) opener.setAttribute('aria-controls', 'poe-panel');
    }
  }

  /* ------------------------------------------------------------- storage */

  /** Re-reads the transcript (after a back/forward cache restore). */
  private resyncFromStorage(): void {
    if (this.busy) {
      this.pendingResync = true;
      return;
    }
    this.pendingResync = false;
    this.transcript = loadTranscript();
    this.clearLog();
    this.rendered = false;
    if (this.isOpen) {
      this.ensureRendered();
      this.scrollLog(true);
    }
    this.renderChips();
    this.updatePlaceholder();
  }

  /* --------------------------------------------------------------- moods */

  private moodState(): MoodState {
    return { turn: this.turnMood, open: this.isOpen, nudging: this.nudging, hovered: this.hoverPointer || this.hoverFocus };
  }

  private setTurnMood(mood: Mood | null, ms?: number): void {
    this.win.clearTimeout(this.moodTimer);
    this.turnMood = mood;
    if (mood && ms) {
      this.moodTimer = this.win.setTimeout(() => {
        this.turnMood = null;
        this.updateMoods();
      }, ms);
    }
    this.updateMoods();
  }

  private updateMoods(): void {
    const state = this.moodState();
    const corner = cornerMood(state);
    const perched = perchedMood(state);
    if (corner !== 'resting' || this.isOpen) this.stopIdleBeat();
    this.root.dataset.mood = this.isOpen ? perched : corner;
    const cornerSrc = this.idleSrc ?? faceUrl(corner);
    const perchedSrc = faceUrl(perched);
    if (this.potatoImg.getAttribute('src') !== cornerSrc) this.potatoImg.src = cornerSrc;
    if (this.perchedImg.getAttribute('src') !== perchedSrc) this.perchedImg.src = perchedSrc;
  }

  /* ----------------------------------------------------------- idle life */

  private scheduleIdle(): void {
    const gap = idleGap();
    this.idleTimer = this.win.setTimeout(() => {
      // The next beat is booked before this one plays, so an interrupted beat never stops the loop.
      this.scheduleIdle();
      if (!this.canIdle() || this.napping || this.wakeTimer !== undefined) return;
      if (shouldNap(Date.now() - this.lastInputAt)) this.nap();
      else this.playBeat(nextBeat(this.idlePlan, gap, !this.everOpened));
    }, gap);
  }

  /** A happy hop on the resting corner potato, when the page celebrates something. */
  private cheer(): void {
    if (!this.canIdle()) return;
    this.stopIdleBeat();
    this.idleSrc = MASCOT_URLS.happy;
    this.potato.dataset.cheering = 'true';
    this.updateMoods();
    this.wakeTimer = this.win.setTimeout(() => {
      this.wakeTimer = undefined;
      this.idleSrc = null;
      delete this.potato.dataset.cheering;
      this.updateMoods();
    }, CHEER_MS);
  }

  private nap(): void {
    this.stopIdleBeat();
    this.napping = true;
    this.idleSrc = MASCOT_URLS.sleepy;
    this.potato.dataset.napping = 'true';
    this.updateMoods();
  }

  /** Any input: remember when, and wake Poe with a start if it was napping. */
  private noteInput(): void {
    this.lastInputAt = Date.now();
    if (!this.napping) return;
    this.stopIdleBeat();
    if (this.reducedMotion() || this.doc.visibilityState === 'hidden') {
      this.updateMoods();
      return;
    }
    this.idleSrc = MASCOT_URLS.wow;
    this.potato.dataset.startled = 'true';
    this.updateMoods();
    this.wakeTimer = this.win.setTimeout(() => {
      this.wakeTimer = undefined;
      this.idleSrc = null;
      delete this.potato.dataset.startled;
      this.updateMoods();
    }, WAKE_MS);
  }

  private canIdle(): boolean {
    return !this.isOpen && cornerMood(this.moodState()) === 'resting' && !this.reducedMotion() && this.doc.visibilityState !== 'hidden';
  }

  private playBeat(beat: IdleBeat): void {
    const shut = MASCOT_URLS.sleepy;
    const frames: Array<[src: string | null, ms: number]> =
      beat.kind === 'wave'
        ? [[MASCOT_WAVE_URL, WAVE_MS]]
        : beat.kind === 'glance'
          ? [[MASCOT_URLS[beat.face], GLANCE_MS]]
          : beat.times === 2
            ? [[shut, BLINK_MS], [null, BLINK_GAP_MS], [shut, BLINK_MS]]
            : [[shut, BLINK_MS]];
    if (beat.kind === 'wave') this.potato.dataset.waving = 'true';
    const step = (i: number) => {
      const frame = frames[i];
      if (!frame) {
        this.stopIdleBeat();
        this.updateMoods();
        return;
      }
      this.idleSrc = frame[0];
      this.updateMoods();
      this.idleFrameTimer = this.win.setTimeout(() => step(i + 1), frame[1]);
    };
    step(0);
  }

  /** Back to the plain resting face; the caller updates the image. Also ends a nap or a wake-up. */
  private stopIdleBeat(): void {
    this.win.clearTimeout(this.idleFrameTimer);
    this.win.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.idleSrc = null;
    this.napping = false;
    delete this.potato.dataset.waving;
    delete this.potato.dataset.napping;
    delete this.potato.dataset.startled;
    delete this.potato.dataset.cheering;
  }

  /* ---------------------------------------------------------- transcript */

  private ensureRendered(): void {
    if (this.rendered) return;
    this.rendered = true;
    for (const entry of this.transcript) this.renderEntry(entry);
    this.updatePlaceholder();
    this.renderChips();
  }

  private renderEntry(entry: TranscriptEntry, existing?: HTMLElement): HTMLElement {
    const node = existing ?? this.buildEntry(entry);
    if (!existing) this.log.insertBefore(node, this.status);
    this.renderedEntries.push({ entry, el: node });
    return node;
  }

  private buildEntry(entry: TranscriptEntry): HTMLElement {
    const d = this.doc;
    if (entry.role === 'you') {
      const bubble = el(d, 'div', { class: 'poe-msg poe-msg--you' });
      if (entry.quote) {
        const quote = entry.quote.length > QUOTE_DISPLAY_MAX ? `${entry.quote.slice(0, QUOTE_DISPLAY_MAX).trimEnd()}…` : entry.quote;
        bubble.append(el(d, 'span', { class: 'poe-sr' }, `${COPY.youAbout} `), el(d, 'p', { class: 'poe-msg__quote' }, `"${quote}"`));
        bubble.append(el(d, 'span', { class: 'poe-sr' }, ` ${COPY.you} `));
      } else {
        bubble.append(el(d, 'span', { class: 'poe-sr' }, `${COPY.you} `));
      }
      bubble.append(el(d, 'p', { class: 'poe-msg__text' }, entry.text));
      return bubble;
    }
    if (entry.role === 'poe') {
      const bubble = el(d, 'div', { class: 'poe-msg poe-msg--poe' });
      const body = el(d, 'div', { class: 'poe-msg__body' });
      body.appendChild(renderAnswer(entry.text, entry.links, d).fragment);
      bubble.append(el(d, 'span', { class: 'poe-sr' }, `${COPY.poeSaid} `), body);
      return bubble;
    }
    return this.buildNote(entry.code, entry.retryAfter);
  }

  private buildNote(code: NoteCode, retryAfter?: number): HTMLElement {
    const d = this.doc;
    const copy = noteCopy(code, retryAfter);
    const bubble = el(d, 'div', { class: 'poe-msg poe-msg--poe poe-msg--note' });
    bubble.dataset.code = code;
    bubble.appendChild(el(d, 'span', { class: 'poe-sr' }, `${COPY.poeSaid} `));
    const p = el(d, 'p');
    if (copy.linkText && copy.linkHref && copy.text.includes(copy.linkText)) {
      const at = copy.text.indexOf(copy.linkText);
      const a = el(d, 'a', { class: 'poe-link', href: copy.linkHref, target: '_blank', rel: 'noopener noreferrer' }, copy.linkText);
      p.append(d.createTextNode(copy.text.slice(0, at)), a, d.createTextNode(copy.text.slice(at + copy.linkText.length)));
    } else {
      p.textContent = copy.text;
    }
    bubble.appendChild(p);
    if (copy.offerNewChat) {
      const btn = el(d, 'button', { class: 'poe-chip poe-chip--action', type: 'button', 'data-action': 'new-chat' }, COPY.startNewChat);
      bubble.appendChild(btn);
    }
    return bubble;
  }

  /** `persist: false` shows the entry without writing storage (another page may own it by now). */
  private pushEntry(entry: TranscriptEntry, existing?: HTMLElement, persist = true): void {
    this.ensureRendered();
    this.transcript.push(entry);
    this.renderEntry(entry, existing);
    while (this.transcript.length > MAX_TRANSCRIPT) this.transcript.shift();
    while (this.renderedEntries.length > MAX_TRANSCRIPT) this.renderedEntries.shift()?.el.remove();
    if (persist) saveTranscript(this.transcript);
  }

  /** Removes every bubble but the greeting, including a partial answer that was never saved. */
  private clearLog(): void {
    for (const node of Array.from(this.log.querySelectorAll('.poe-msg:not(.poe-msg--greeting)'))) node.remove();
    this.renderedEntries = [];
  }

  async newChat(): Promise<void> {
    if (this.busy) return;
    this.clearLog();
    this.transcript = [];
    clearTranscript();
    this.setTurnMood(null);
    this.updatePlaceholder();
    this.renderChips();
    this.announce(COPY.newChatAnnounce);
    if (this.isOpen) this.focusInput();
    // A question asked before the DELETE lands would still carry the old cookie (and get it
    // set again), so send() waits for this.
    const reset = resetConversation({ fetchImpl: this.fetchImpl, timeoutMs: RESET_TIMEOUT_MS });
    this.resetting = reset;
    try {
      await reset;
    } finally {
      if (this.resetting === reset) this.resetting = null;
    }
  }

  private updatePlaceholder(): void {
    const answered = this.transcript.some((e) => e.role === 'poe');
    this.input.placeholder = answered ? COPY.placeholderFollowUp : COPY.placeholder;
  }

  private renderChips(): void {
    const asked = new Set(this.transcript.filter((e) => e.role === 'you').map((e) => (e as { text: string }).text.toLowerCase()));
    const list = (this.page === 'guide' ? CHIPS_GUIDE : CHIPS_DEFAULT).filter((chip) => !asked.has(chip.toLowerCase()));
    this.chips.replaceChildren(
      ...list.map((chip) => el(this.doc, 'button', { class: 'poe-chip', type: 'button', 'data-chip': chip }, chip)),
    );
    this.chips.hidden = this.busy || list.length === 0;
  }

  private askChip(chip: string): void {
    // The chips are re-rendered and hidden while Poe answers, which would drop focus to
    // <body>. Phones focus the log, so the on-screen keyboard stays down.
    if (this.isPhone()) this.log.focus({ preventScroll: true });
    else this.focusInput();
    if (chip === COPY.summarize) {
      const root = this.doc.querySelector(ASKABLE_SELECTOR);
      const section = root ? currentSection(root, this.win.innerHeight * 0.35) : null;
      void this.send(chip, section ? { selection: section.text, quote: section.title } : {});
      return;
    }
    void this.send(chip);
  }

  /* ---------------------------------------------------------------- turn */

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.toggleAttribute('data-busy', busy);
    for (const btn of [this.sendBtn, this.newChatBtn]) {
      if (busy) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    }
    if (busy) this.log.setAttribute('aria-busy', 'true');
    else this.log.removeAttribute('aria-busy');
    this.renderChips();
    if (busy) this.hidePill();
  }

  private showStatus(label: string): void {
    this.statusText.textContent = `${label}…`;
    this.status.hidden = false;
    this.log.insertBefore(this.status, this.chips); // after the newest bubble
    this.scrollLog(false);
  }

  private hideStatus(): void {
    this.status.hidden = true;
  }

  /**
   * Sends one message. Resolves when the turn has ended. Returns false when
   * nothing was sent (empty message, or a turn already in flight).
   */
  async send(message: string, extra: { selection?: string; quote?: string; fromInput?: boolean } = {}): Promise<boolean> {
    if (this.busy) return false;
    const request = buildRequest(message, this.win.location?.pathname ?? '/', extra.selection);
    if (!request) return false;

    this.setBusy(true);
    // Asked for now, so a slow PDS overlaps with the rest; never longer than TOKEN_WAIT_MS.
    const tokenPromise = this.identity ? this.identity.token() : Promise.resolve(null);
    // Poe has answered before in this transcript; a fresh server conversation needs saying.
    const hadAnswers = this.transcript.some((e) => e.role === 'poe');
    const you: TranscriptEntry = { role: 'you', text: request.message };
    if (extra.quote) you.quote = extra.quote.slice(0, 300);
    this.pushEntry(you);
    if (extra.fromInput) this.input.value = '';
    this.showStatus(DIGGING_LINES[Math.floor(Math.random() * DIGGING_LINES.length)] ?? COPY.digging);
    this.setTurnMood('digging');
    this.scrollLog(true);

    // Streamed text per block. Deltas only append; a block event replaces the block with its
    // final text. eve re-runs a failed step with the same block index, so a delta after a block's
    // final text starts a new attempt, and deltas before one may hold a retried step twice.
    const blocks: string[] = [];
    const confirmed = new Set<number>();
    let bubble: HTMLElement | null = null;
    let body: HTMLElement | null = null;
    const ensureBubble = () => {
      if (bubble && body) return body;
      bubble = el(this.doc, 'div', { class: 'poe-msg poe-msg--poe is-streaming' });
      body = el(this.doc, 'div', { class: 'poe-msg__body poe-msg__body--plain' });
      bubble.append(el(this.doc, 'span', { class: 'poe-sr' }, `${COPY.poeSaid} `), body);
      this.log.insertBefore(bubble, this.status);
      return body;
    };
    const showStream = () => {
      const text = lastNonEmpty(blocks);
      if (!text) return;
      const stick = this.isNearBottom();
      ensureBubble().textContent = text; // plain text while streaming
      this.hideStatus();
      if (stick) this.scrollLog(true);
    };

    const controller = new AbortController();
    this.turnController = controller;
    let failure: PoeError | null = null;

    // "new chat" just now: let its DELETE clear the cookie before this question goes out.
    if (this.resetting) await this.resetting;
    const token = await tokenPromise;

    // Once per question, as soon as the stream says who the server took the asker for (the
    // "visitor" event when a token went with it, else "ready"): a note between the question
    // and the answer when Poe can't see the chat above. Signing in or out starts the bot on a
    // conversation of its own, and so does a lost cookie.
    let fresh = false;
    let settled = false;
    const settle = (who: Who) => {
      if (settled) return;
      settled = true;
      const store = sessionStore();
      const before = readWho(store);
      saveWho(store, who);
      if (!hadAnswers) return;
      const code = before && before.did !== who.did ? (who.did ? 'signed_in' : 'signed_out') : fresh ? 'fresh_start' : null;
      if (!code) return;
      const lastNote = [...this.transcript].reverse().find((e) => e.role === 'note');
      if (lastNote?.role === 'note' && lastNote.code === code) return; // once, even with cookies blocked
      this.pushEntry({ role: 'note', code });
      this.announce(noteCopy(code).text);
    };
    const anonymous: Who = { did: null, handle: null };

    const outcome = await askPoe(
      request,
      {
        onReady: (conversation) => {
          fresh = conversation === 'new';
          if (!token) settle(anonymous);
        },
        onVisitor: (signedIn, handle) => {
          this.identity?.confirm(signedIn, handle);
          const state = this.identity?.state;
          settle(signedIn && state?.kind === 'signed-in' ? { did: state.did, handle: state.handle } : anonymous);
        },
        onStatus: (label) => {
          settle(anonymous); // a proxy that never answered the token treated it as anonymous
          this.showStatus(label);
          this.announce(label);
        },
        onDelta: (block, text) => {
          settle(anonymous);
          if (confirmed.delete(block)) blocks[block] = text;
          else blocks[block] = (blocks[block] ?? '') + text;
          showStream();
        },
        onBlock: (block, text) => {
          settle(anonymous);
          blocks[block] = text ?? '';
          confirmed.add(block);
          showStream();
        },
        onDone: (text, links) => {
          settle(anonymous);
          const finalText = text.trim() ? text : lastNonEmpty(blocks);
          if (!finalText.trim()) {
            (bubble as HTMLElement | null)?.remove();
            this.pushEntry({ role: 'note', code: 'empty' });
            this.announce(noteCopy('empty').text);
            this.setTurnMood('error', ERROR_MS);
            return;
          }
          const result = renderAnswer(finalText, links, this.doc);
          const target = ensureBubble();
          target.classList.remove('poe-msg__body--plain');
          target.replaceChildren(result.fragment);
          (bubble as HTMLElement | null)?.classList.remove('is-streaming');
          this.pushEntry({ role: 'poe', text: finalText, links: result.links }, bubble as HTMLElement);
          this.announce(`${COPY.answerAnnounce}${result.plain}`);
          this.setTurnMood('found', FOUND_MS);
        },
        onError: (error) => {
          failure = error;
        },
      },
      { signal: controller.signal, fetchImpl: this.fetchImpl, token },
    );

    if (this.turnController === controller) this.turnController = null;
    this.hideStatus();

    const partialIndex = lastNonEmptyIndex(blocks);
    const partial = partialIndex === -1 ? '' : (blocks[partialIndex] as string);
    if (outcome === 'error' && failure) {
      const error = failure as PoeError;
      if (bubble && partial) {
        // Keep what already streamed on screen, rendered safely without links. Only text a block
        // event confirmed is saved as Poe's answer: raw deltas may hold a retried step twice.
        const result = renderAnswer(partial, [], this.doc);
        const target = body as HTMLElement | null;
        target?.classList.remove('poe-msg__body--plain');
        target?.replaceChildren(result.fragment);
        (bubble as HTMLElement).classList.remove('is-streaming');
        if (confirmed.has(partialIndex)) this.pushEntry({ role: 'poe', text: partial, links: [] }, bubble);
        else (bubble as HTMLElement).classList.add('poe-msg--partial'); // this page only
      } else {
        (bubble as HTMLElement | null)?.remove();
      }
      const note: TranscriptEntry = { role: 'note', code: error.code };
      if (error.retryAfter) note.retryAfter = error.retryAfter;
      this.pushEntry(note);
      this.announce(noteCopy(error.code, error.retryAfter).text);
      if (error.code === 'not_configured' || error.code === 'offline') this.setTurnMood('offline');
      else this.setTurnMood('error', ERROR_MS);
    } else if (outcome === 'aborted') {
      // Only page unload aborts a turn, and onPageHide already saved the "interrupted" note.
      // Show it here without saving: by the time this runs the next page may own the transcript.
      (bubble as HTMLElement | null)?.classList.remove('is-streaming');
      this.pushEntry({ role: 'note', code: 'interrupted' }, undefined, false);
      this.setTurnMood(null);
    }

    // Chips come back below the answer; keep following the bottom if the reader was there.
    const stick = this.isNearBottom();
    this.setBusy(false);
    this.updatePlaceholder();
    this.scrollLog(stick);
    if (this.pendingResync) this.resyncFromStorage();
    return true;
  }

  private onPageHide(): void {
    if (!this.busy || !this.turnController) return;
    // Persist the interruption now; the async abort path may never run during unload.
    saveTranscript([...this.transcript, { role: 'note', code: 'interrupted' }]);
    this.turnController.abort();
  }

  /* -------------------------------------------------------------- scroll */

  private isNearBottom(): boolean {
    const log = this.log;
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  private scrollLog(force: boolean): void {
    if (!this.isOpen) return;
    if (force || this.isNearBottom()) this.log.scrollTop = this.log.scrollHeight;
  }

  /* ------------------------------------------------------------ announce */

  private announce(text: string): void {
    this.win.clearTimeout(this.announceTimer);
    this.live.textContent = '';
    this.announceTimer = this.win.setTimeout(() => {
      this.live.textContent = text;
    }, 60);
  }

  /* --------------------------------------------------------------- nudge */

  private nudgeText_(): string {
    return (this.doc.body.dataset.poeNudge ?? '').trim();
  }

  private scheduleNudge(): void {
    if (this.nudgeDone || this.nudging) return;
    if (!this.nudgeText_() || wasNudged()) {
      this.nudgeDone = true;
      return;
    }
    this.win.clearTimeout(this.nudgeTimer);
    this.nudgeTimer = this.win.setTimeout(() => this.tryNudge(), this.nudgeDelay);
  }

  private noteActivity(): void {
    if (!this.nudgeDone && !this.nudging) this.scheduleNudge();
  }

  private tryNudge(): void {
    if (this.nudgeDone || this.nudging) return;
    if (this.isOpen) {
      this.nudgeDone = true;
      return;
    }
    if (this.page === 'home' && this.win.innerWidth < HOME_NUDGE_MIN_WIDTH) {
      this.nudgeDone = true;
      return;
    }
    // Typing, or another dialog (like the blog's sign-in) has the reader's attention.
    if (this.busy || isTypingTarget(this.doc.activeElement) || this.pillText || otherModalOpen(this.doc, this.root)) {
      this.scheduleNudge(); // try again after the next quiet spell
      return;
    }
    if (wasNudged()) {
      this.nudgeDone = true;
      return;
    }
    this.showNudge();
  }

  private showNudge(): void {
    markNudged();
    this.nudgeDone = true;
    // A trailing kaomoji stays on screen but not in the screen reader, like in answers.
    const text = this.nudgeText_();
    const split = splitTrailingFace(text);
    this.nudgeText.textContent = split ? split[0] : text;
    if (split) this.nudgeText.append(el(this.doc, 'span', { class: 'poe-face', 'aria-hidden': 'true' }, split[1]));
    this.nudge.hidden = false;
    this.nudging = true;
    this.nudgeScrollY = this.win.scrollY;
    void this.nudge.offsetWidth;
    this.nudge.classList.add('is-visible');
    this.updateMoods();
    this.nudgeHideTimer = this.win.setTimeout(() => this.hideNudge(), NUDGE_AUTO_HIDE_MS);
  }

  hideNudge(): void {
    if (!this.nudging) return;
    this.nudging = false;
    this.win.clearTimeout(this.nudgeHideTimer);
    const hadFocus = this.nudge.contains(this.doc.activeElement);
    this.nudge.classList.remove('is-visible');
    this.nudge.hidden = true;
    this.updateMoods();
    // The dismiss button had focus and is gone now: hand focus to the potato it belonged to.
    if (hadFocus && !this.isOpen) this.potato.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------- highlight-to-ask */

  private onSelectionChange(): void {
    if (this.pillPressed) return;
    this.schedulePill(PILL_SETTLE_MS);
  }

  private schedulePill(ms: number): void {
    this.win.clearTimeout(this.pillTimer);
    this.pillTimer = this.win.setTimeout(() => this.updatePill(), ms);
  }

  private updatePill(): void {
    if (this.pointerDown) return; // still dragging; wait for pointerup
    if (this.busy || (this.isOpen && this.modal)) {
      this.hidePill();
      return;
    }
    const found = getAskableSelection(this.win.getSelection?.() ?? null);
    if (!found) {
      this.hidePill();
      return;
    }
    this.pillText = found.text;
    const wasHidden = this.pill.hidden;
    this.pill.hidden = false;
    const rects = typeof found.range.getClientRects === 'function' ? Array.from(found.range.getClientRects()).filter((r) => r.width > 0 || r.height > 0) : [];
    const box = typeof found.range.getBoundingClientRect === 'function' ? found.range.getBoundingClientRect() : null;
    const first = rects[0] ?? box;
    const last = rects[rects.length - 1] ?? box;
    if (first && last) {
      const coarse = typeof this.win.matchMedia === 'function' && this.win.matchMedia('(pointer: coarse)').matches;
      const size = { width: this.pill.offsetWidth || 190, height: this.pill.offsetHeight || 40 };
      const pos = pillPosition(toRect(first), toRect(last), size, { width: this.doc.documentElement.clientWidth || this.win.innerWidth, height: this.win.innerHeight }, coarse);
      this.pill.style.left = `${pos.left}px`;
      this.pill.style.top = `${pos.top}px`;
      this.pill.dataset.placement = pos.placement;
    }
    if (wasHidden) {
      void this.pill.offsetWidth;
      this.pill.classList.add('is-visible');
    }
  }

  hidePill(): void {
    this.win.clearTimeout(this.pillTimer);
    if (this.pill.hidden && !this.pillText) return;
    const hadFocus = this.pill === this.doc.activeElement;
    this.pillText = null;
    this.pill.classList.remove('is-visible');
    this.pill.hidden = true;
    if (hadFocus) this.pill.blur();
  }

  private askAboutSelection(): void {
    const text = this.pillText;
    this.pillPressed = false;
    this.hidePill();
    if (!text || this.busy) return;
    this.open({ opener: null, via: 'pill' });
    void this.send(COPY.selectionQuestion, { selection: text, quote: text });
  }

  /* -------------------------------------------------------------- events */

  private onDocumentClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const opener = target?.closest('[data-poe-open]');
    if (!opener || this.root.contains(opener)) return;
    event.preventDefault();
    this.toggle(opener, event.detail === 0 ? 'keyboard' : 'pointer');
  }

  private onPointerDown(event: PointerEvent): void {
    const target = event.target instanceof Node ? event.target : null;
    this.pointerDown = !(target && this.pill.contains(target));
    this.noteActivity();
    // "never blocks a tap": the bubble lets taps through and any tap elsewhere dismisses it
    if (this.nudging && !(target && this.nudge.contains(target))) this.hideNudge();
  }

  private onScroll(): void {
    if (!this.pillPressed) this.hidePill();
    this.noteActivity();
    if (this.nudging && Math.abs(this.win.scrollY - this.nudgeScrollY) > NUDGE_SCROLL_HIDE_PX) this.hideNudge();
  }

  private onKeydown(event: KeyboardEvent): void {
    const { doc } = this;
    const active = doc.activeElement;

    if (event.key === 'Escape' && !event.isComposing) {
      if (this.isOpen && !event.defaultPrevented) {
        const inWidget = active ? this.root.contains(active) : false;
        if (this.modal || inWidget || !active || active === doc.body) {
          event.preventDefault();
          this.close();
          return;
        }
      }
      if (this.nudging) this.hideNudge();
      if (this.pillText && !event.defaultPrevented) this.hidePill();
      return;
    }

    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (this.isOpen && this.modal) {
        this.trapTab(event);
        return;
      }
      // Highlight-to-ask is keyboard reachable: the next Tab after a selection lands on the pill.
      if (!event.shiftKey && this.pillText && !this.pill.hidden && active !== this.pill && !(active && this.root.contains(active))) {
        event.preventDefault();
        this.pill.focus({ preventScroll: true });
      }
      return;
    }

    if (isSlashShortcut(event, active)) {
      if (otherModalOpen(doc, this.root)) return;
      event.preventDefault(); // also keeps Firefox quick find closed
      if (this.isOpen) this.focusInput();
      else this.open({ opener: active, via: 'keyboard' });
    }
  }

  private trapTab(event: KeyboardEvent): void {
    const items = Array.from(
      this.panel.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
    ).filter((item) => !item.hasAttribute('disabled') && !item.closest('[hidden]'));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = this.doc.activeElement;
    const inside = active ? this.panel.contains(active) : false;
    if (event.shiftKey && (active === first || active === this.panel || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  /* --------------------------------------------------------------- swipe */

  private bindSwipe(): void {
    let startY = 0;
    let dy = 0;
    let pointerId: number | null = null;
    const zone = [this.handle, this.head];
    const down = (e: Event) => {
      const event = e as PointerEvent;
      if (!this.isOpen || !this.modal || event.button > 0) return;
      if ((event.target as Element | null)?.closest?.('button')) return;
      pointerId = event.pointerId;
      startY = event.clientY;
      dy = 0;
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      this.panel.classList.add('is-dragging');
    };
    const move = (e: Event) => {
      const event = e as PointerEvent;
      if (pointerId !== event.pointerId) return;
      dy = Math.max(0, event.clientY - startY);
      this.panel.style.transform = `translateY(${dy}px)`;
    };
    const up = (e: Event) => {
      const event = e as PointerEvent;
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      this.panel.classList.remove('is-dragging');
      if (dy > SWIPE_CLOSE_PX) this.close();
      else this.panel.style.transform = '';
    };
    for (const z of zone) {
      this.on(z, 'pointerdown', down);
      this.on(z, 'pointermove', move);
      this.on(z, 'pointerup', up);
      this.on(z, 'pointercancel', up);
    }
  }
}
