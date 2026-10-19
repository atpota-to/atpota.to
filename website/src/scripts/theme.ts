/**
 * Theme: light/dark via html[data-theme]. The inline <head> script in every page
 * shell sets the initial value before first paint (same storage key and values as
 * the old site: localStorage "theme" = "light" | "dark"). Light is the default; the
 * OS setting is not consulted, so dark only shows once a visitor picks it. This
 * module wires the footer toggle(s) ([data-theme-toggle], aria-pressed = dark is
 * on), keeps the theme-color meta in sync, and fires `window` event "theme:change"
 * with detail { theme }.
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
    if (target) toggleTheme();
  });
}
