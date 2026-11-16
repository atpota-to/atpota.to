/**
 * A tap log, for chasing taps a phone drops (add ?taplog to any page's address): a readout
 * across the top of the screen of what each touch did, in the order the browser sent it,
 * and whether a click came of it. While it's on, links don't go anywhere, so a few taps can
 * be made, compared and screenshotted.
 *
 * It notes what iOS Safari weighs against a tap on a link (WebKit's ContentChangeObserver,
 * and its tap gesture): the touch becoming a scroll (pointercancel, a scroll on the page or
 * in a strip), the finger drifting, and anything tappable appearing on the page between the
 * touch and the click, which Safari takes as a hover and answers with no click at all.
 *
 * Nothing here runs without ?taplog.
 */

/** After the finger lifts, how long to wait for the click before saying none came. */
export const CLICK_WAIT_MS = 800;
/** Lines kept on screen. */
export const LINES = 24;

/** Elements given their own click, mousedown or mouseup listener (Safari counts those as tappable). */
const listened = new WeakSet<Element>();
/** Windows whose addEventListener already notes them. */
const hooked = new WeakSet<Window>();

export function tapLogWanted(search: string): boolean {
  return new URLSearchParams(search).has('taplog');
}

/** "a.weather-topics__link 'trends'" */
export function describe(el: Element | null): string {
  if (!el) return 'nothing';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean)[0] : '';
  const words = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${words ? ` '${words}'` : ''}`;
}

/** Tappable, as Safari decides it for a tap's hover check (roughly: a link, a control, or its own click listener). */
function tappable(el: Element): boolean {
  return (el instanceof HTMLAnchorElement && el.hasAttribute('href')) || el.matches('button, input, select, textarea, iframe, [contenteditable]') || listened.has(el);
}

/** Hidden, as Safari's ContentChangeObserver judges it: no box, invisible, see-through, or under a see-through parent. */
function hiddenToSafari(el: Element, view: Window): boolean {
  const style = view.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
  if (style.display !== 'contents' && el.getClientRects().length === 0) return true;
  let parent = el.parentElement;
  for (let i = 0; parent && i < 4; parent = parent.parentElement, i++) {
    const ps = view.getComputedStyle(parent);
    if (ps.display === 'contents' || ps.display === 'none' || Number(ps.opacity) === 0) return true;
  }
  return false;
}

export function initTapLog(opts: { doc?: Document; search?: string } = {}): void {
  const doc = opts.doc ?? document;
  const view = doc.defaultView;
  if (!view || !tapLogWanted(opts.search ?? view.location.search)) return;
  if (doc.documentElement.dataset.tapLog === 'on') return;
  doc.documentElement.dataset.tapLog = 'on';

  // the log's own listeners, added the window's own way (and not counted below)
  const listen = view.addEventListener.bind(view);
  // Every listener added from here on: which elements answer clicks themselves.
  if (!hooked.has(view)) {
    hooked.add(view);
    const add = view.EventTarget.prototype.addEventListener;
    view.EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if ((type === 'click' || type === 'mousedown' || type === 'mouseup') && this instanceof view.Element) listened.add(this);
      return (add as (...args: unknown[]) => void).call(this, type, ...rest);
    } as typeof add;
  }

  const panel = doc.createElement('div');
  panel.setAttribute('aria-hidden', 'true');
  panel.dataset.tapLogPanel = '';
  panel.style.cssText = [
    'position:fixed',
    'top:max(env(safe-area-inset-top), 8px)',
    'left:8px',
    'right:8px',
    'z-index:2147483647',
    'pointer-events:none',
    'max-height:36vh',
    'overflow:hidden',
    // the newest line at the bottom, always in view; older ones go off the top
    'display:flex',
    'flex-direction:column',
    'justify-content:flex-end',
    'padding:8px 10px',
    'border-radius:12px',
    'background:rgba(24,18,10,0.84)',
    'color:#f6efe0',
    'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre-wrap',
  ].join(';');
  const text = doc.createElement('div');
  panel.append(text);
  const lines: string[] = [];
  const write = (line: string) => {
    lines.push(line);
    if (lines.length > LINES) lines.splice(0, lines.length - LINES);
    text.textContent = lines.join('\n');
  };
  const ios = /OS (\d+)_(\d+)/.exec(view.navigator.userAgent);
  write(`tap log${ios ? ` · iOS ${ios[1]}.${ios[2]}` : ''} · links stay put while this is on`);
  const mount = () => doc.body?.append(panel);
  if (doc.body) mount();
  else doc.addEventListener('DOMContentLoaded', mount, { once: true });

  interface Tap {
    n: number;
    t0: number;
    x: number;
    y: number;
    clicked: boolean;
    moved: boolean;
    seen: Set<string>;
    shown: Set<Element>;
    lifted: boolean;
  }
  let count = 0;
  let tap: Tap | null = null;
  const now = () => view.performance.now();
  const at = (t: Tap) => `+${String(Math.round(now() - t.t0)).padStart(3)}`;
  const once = (t: Tap, key: string, line: string) => {
    if (t.seen.has(key)) return;
    t.seen.add(key);
    write(`${at(t)} ${line}`);
  };

  const visibleTappables = () => {
    const out = new Set<Element>();
    for (const el of doc.querySelectorAll('*')) if (el !== panel && tappable(el) && !hiddenToSafari(el, view)) out.add(el);
    return out;
  };
  // each frame of a tap: anything tappable that wasn't showing when the finger went down
  const watch = (t: Tap) => {
    if (tap !== t) return;
    for (const el of visibleTappables()) {
      if (t.shown.has(el)) continue;
      t.shown.add(el);
      write(`${at(t)} appeared: ${describe(el)} ← may cost the click`);
    }
    view.requestAnimationFrame(() => watch(t));
  };

  const finish = (t: Tap) => {
    if (tap !== t) return;
    if (!t.clicked) write(`${at(t)} ✗ no click`);
    tap = null;
  };

  const watching = { capture: true, passive: true } as const;
  listen('pointerdown', ((e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (tap) finish(tap);
    const target = e.target instanceof view.Element ? e.target : null;
    const t: Tap = { n: ++count, t0: now(), x: e.clientX, y: e.clientY, clicked: false, moved: false, seen: new Set(), shown: visibleTappables(), lifted: false };
    tap = t;
    const under = doc.elementFromPoint?.(e.clientX, e.clientY) ?? null;
    write(`#${t.n} ${describe(target?.closest('a[href], button') ?? target)} at ${Math.round(t.x)},${Math.round(t.y)}${under && under !== target ? ` · on top: ${describe(under)}` : ''}`);
    write(`${at(t)} pointerdown`);
    view.requestAnimationFrame(() => watch(t));
  }) as EventListener, watching);
  listen('pointermove', ((e: PointerEvent) => {
    if (!tap || e.pointerType === 'mouse') return;
    const d = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    if (d >= 6 && !tap.moved) {
      tap.moved = true;
      write(`${at(tap)} finger drifted ${Math.round(d)}px`);
    }
  }) as EventListener, watching);
  for (const type of ['pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel']) {
    listen(type, ((e: Event) => {
      if (!tap || ((e as PointerEvent).pointerType === 'mouse' && type.startsWith('pointer'))) return;
      write(`${at(tap)} ${type}${type.endsWith('cancel') ? ' ← taken as a scroll or long press' : ''}`);
      if (type === 'pointerup' || type === 'pointercancel') {
        const t = tap;
        t.lifted = true;
        view.setTimeout(() => finish(t), CLICK_WAIT_MS);
      }
    }) as EventListener, watching);
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
    listen(type, (() => {
      if (tap) once(tap, type, type);
    }) as EventListener, watching);
  }
  listen('scroll', ((e: Event) => {
    if (!tap) return;
    const what = e.target === doc || e.target === doc.documentElement ? 'the page' : describe(e.target as Element).split(' ')[0]!;
    once(tap, `scroll ${what}`, `scrolled: ${what}`);
  }) as EventListener, watching);
  listen('click', ((e: MouseEvent) => {
    const target = e.target instanceof view.Element ? e.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    if (link) e.preventDefault();
    const where = link ? ` → ${link.getAttribute('href')}` : '';
    if (tap) {
      tap.clicked = true;
      write(`${at(tap)} click ✓ ${describe(link ?? target)}${where}`);
    } else {
      write(`click ✓ ${describe(link ?? target)}${where} (no touch before it)`);
    }
  }) as EventListener, { capture: true });
}
