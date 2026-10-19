// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MASCOT_URLS, SWAP_FACES, bindMascot, pickFace } from '../src/scripts/mascot.js';
import { initNav } from '../src/scripts/nav.js';
import { applyTheme, getTheme, initTheme, toggleTheme } from '../src/scripts/theme.js';

// A variable (not a literal) keeps Vite from treating new URL(..., import.meta.url) as an asset.
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url).href), 'utf8');

function pointer(type: string, pointerType: string): Event {
  const event = new Event(type, { bubbles: type === 'pointerdown' });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('mascot', () => {
  it('pickFace never returns the resting or the current face', () => {
    for (let i = 0; i < 200; i++) {
      const face = pickFace('kawaii', 'wow');
      expect(SWAP_FACES).toContain(face);
      expect(face).not.toBe('kawaii');
      expect(face).not.toBe('wow');
    }
  });

  it('swaps on hover, restores on leave, and tap restores after 700ms', () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<img data-mascot="kawaii" src="${MASCOT_URLS.kawaii}" alt="potato">`;
    const img = document.querySelector('img')!;
    bindMascot(img);
    img.dispatchEvent(pointer('pointerenter', 'mouse'));
    expect(img.getAttribute('src')).not.toBe(MASCOT_URLS.kawaii);
    expect(Object.values(MASCOT_URLS)).toContain(img.getAttribute('src'));
    img.dispatchEvent(pointer('pointerleave', 'mouse'));
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);

    img.dispatchEvent(pointer('pointerenter', 'touch'));
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    img.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(img.getAttribute('src')).not.toBe(MASCOT_URLS.kawaii);
    vi.advanceTimersByTime(699);
    expect(img.getAttribute('src')).not.toBe(MASCOT_URLS.kawaii);
    vi.advanceTimersByTime(2);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    vi.useRealTimers();
  });

  it('the home page hero never pulls the scawy face', () => {
    const hero = /<img class="home-sun__mascot"[^>]*>/.exec(read('../index.html'))![0];
    document.body.innerHTML = hero;
    const img = document.querySelector('img')!;
    expect(img.dataset.mascotFaces).toBeTruthy();
    bindMascot(img);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      img.dispatchEvent(pointer('pointerenter', 'mouse'));
      seen.add(img.getAttribute('src')!);
      img.dispatchEvent(pointer('pointerleave', 'mouse'));
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(seen).not.toContain(MASCOT_URLS.scawy);
  });

  it('swaps while a focusable ancestor has focus', () => {
    document.body.innerHTML = `<a href="/x"><img data-mascot="normal" src="${MASCOT_URLS.normal}" alt=""></a>`;
    const img = document.querySelector('img')!;
    bindMascot(img);
    document.querySelector('a')!.focus();
    expect(img.getAttribute('src')).not.toBe(MASCOT_URLS.normal);
    (document.activeElement as HTMLElement).blur();
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.normal);
  });
});

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.setAttribute('data-theme', 'light');
    document.body.innerHTML = '<meta name="theme-color" content="#F4EEDF"><button data-theme-toggle aria-pressed="false">dark mode</button>';
  });

  it('toggles, persists to localStorage "theme" and syncs aria-pressed + theme-color', () => {
    initTheme();
    const events: string[] = [];
    window.addEventListener('theme:change', (e) => events.push((e as CustomEvent<{ theme: string }>).detail.theme));
    document.querySelector<HTMLButtonElement>('[data-theme-toggle]')!.click();
    expect(getTheme()).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.querySelector('[data-theme-toggle]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe('#1C160E');
    expect(toggleTheme()).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(events).toEqual(['dark', 'light']);
  });

  it.each(['index.html', '404.html', 'guides/bluesky-for-brands.html'])(
    '%s head script defaults to light, even when the OS prefers dark',
    (page) => {
      const html = read(`../${page}`);
      const script = /<script>(\(function\(\)\{var d=document\.documentElement[\s\S]*?)<\/script>/.exec(html)![1]!;
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({ matches: query.includes('dark'), media: query })) as unknown as typeof window.matchMedia;
      try {
        const run = () => {
          document.documentElement.removeAttribute('data-theme');
          new Function(script)();
          return document.documentElement.getAttribute('data-theme');
        };
        expect(run()).toBe('light');
        localStorage.setItem('theme', 'dark');
        expect(run()).toBe('dark');
        localStorage.setItem('theme', 'nonsense');
        expect(run()).toBe('light');
      } finally {
        window.matchMedia = original;
      }
      expect(html).not.toContain('prefers-color-scheme');
    },
  );

  it('initTheme does not follow the OS setting', () => {
    expect(read('../src/scripts/theme.ts')).not.toContain('prefers-color-scheme');
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => applyTheme('dark', { persist: true })).not.toThrow();
    expect(getTheme()).toBe('dark');
    spy.mockRestore();
  });
});

describe('nav menu', () => {
  it('opens, traps focus, closes on Escape and returns focus to the toggle', async () => {
    document.body.innerHTML = `
      <header data-site-header>
        <button data-nav-toggle aria-expanded="false" aria-controls="site-menu">menu</button>
        <div id="site-menu" data-nav-menu>
          <a href="/">home</a><a href="/guides/bluesky-for-brands">guides</a>
          <button data-poe-open>ask poe</button>
        </div>
      </header>
      <div data-nav-scrim hidden></div>`;
    initNav();
    const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]')!;
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-site-header]')!.classList.contains('is-menu-open')).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-nav-scrim]')!.hidden).toBe(false);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement?.textContent).toBe('home');

    const ask = document.querySelector<HTMLButtonElement>('[data-poe-open]')!;
    ask.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(toggle);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(document.querySelector<HTMLElement>('[data-nav-scrim]')!.hidden).toBe(true);

    toggle.click();
    ask.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
