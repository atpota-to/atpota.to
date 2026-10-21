/**
 * Theme: light/dark via html[data-theme]. The inline <head> script in every page
 * shell sets the initial value before first paint (same storage key and values as
 * the old site: localStorage "theme" = "light" | "dark"). Light is the default; the
 * OS setting is not consulted, so dark only shows once a visitor picks it. This
 * module wires the toggles in the header and footer ([data-theme-toggle], aria-pressed = dark is
 * on), keeps the theme-color meta in sync, and fires `window` event "theme:change"
 * with detail { theme }. Where the browser has view transitions (and motion is
 * welcome), the new theme spreads out in a circle from the toggle (base.css).
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';
export const THEME_COLORS: Record<Theme, string> = { light: '#F4EEDF', dark: '#1C160E' };
export const DEFAULT_THEME: Theme = 'light';

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function syncUi(theme: Theme): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[theme];
  }
}

export function applyTheme(theme: Theme, options: { persist?: boolean } = {}): void {
  const changed = getTheme() !== theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (options.persist) storeTheme(theme);
  syncUi(theme);
  if (changed) window.dispatchEvent(new CustomEvent<{ theme: Theme }>('theme:change', { detail: { theme } }));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next, { persist: true });
  return next;
}

const REVEAL_MS = 650;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

/** The radius that covers the whole viewport from (x, y). */
export function revealRadius(x: number, y: number, width: number, height: number): number {
  return Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
}

/** toggleTheme(), drawn as a circle growing from (x, y) in viewport pixels. */
export function toggleThemeFrom(x: number, y: number): void {
  const doc = document as ViewTransitionDocument;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof doc.startViewTransition !== 'function' || reduce) {
    toggleTheme();
    return;
  }
  const root = document.documentElement;
  root.setAttribute('data-theme-switching', '');
  const transition = doc.startViewTransition(() => {
    toggleTheme();
  });
  const radius = revealRadius(x, y, window.innerWidth, window.innerHeight);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: REVEAL_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => undefined);
  transition.finished.finally(() => root.removeAttribute('data-theme-switching')).catch(() => undefined);
}

let initialised = false;

export function initTheme(): void {
  if (initialised) return;
  initialised = true;

  // The head script normally did this already; repeat in case it was stripped.
  if (!document.documentElement.hasAttribute('data-theme')) {
    document.documentElement.setAttribute('data-theme', readStoredTheme() ?? DEFAULT_THEME);
  }
  syncUi(getTheme());

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null;
    if (!target) return;
    // A keyboard press has no pointer position: grow from the toggle's knob instead
    // (or the toggle itself, where its knob is hidden, as on the desktop nav button).
    const knobRect = target.querySelector('[data-theme-knob]')?.getBoundingClientRect();
    const knob = knobRect && knobRect.width > 0 ? knobRect : target.getBoundingClientRect();
    const fromPointer = event.detail > 0 && (event.clientX !== 0 || event.clientY !== 0);
    toggleThemeFrom(fromPointer ? event.clientX : knob.left + knob.width / 2, fromPointer ? event.clientY : knob.top + knob.height / 2);
  });
}
