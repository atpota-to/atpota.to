// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCopyEmail } from '../src/scripts/home.js';
import { MASCOT_URLS, bindMascot } from '../src/scripts/mascot.js';
import { initNavPill } from '../src/scripts/nav.js';
import { PET_RESET_MS, initPet, petReaction } from '../src/scripts/pet.js';
import { AWAY_TITLE, BACK_MS, BACK_TITLE, initTabTitle } from '../src/scripts/tab.js';
import { applyTheme, revealRadius, toggleThemeFrom } from '../src/scripts/theme.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  applyTheme('light');
});

describe('hero poe petting', () => {
  const HERO = `
    <div class="home-sun" data-mascot-trigger>
      <img data-mascot="kawaii" data-mascot-faces="wow wink happy" data-pet src="${MASCOT_URLS.kawaii}" alt="poe">
      <p class="home-sun__bubble"><span class="only-hover">psst, hover me</span><span data-pet-say></span></p>
    </div>`;

  it('reacts at a few pet counts, with friendly faces only', () => {
    expect(petReaction(1)).toEqual({});
    expect(petReaction(3)).toMatchObject({ face: 'wink', say: 'hehe' });
    expect(petReaction(6)).toMatchObject({ face: 'happy', blush: true });
    expect(petReaction(8)).toMatchObject({ spin: true });
    expect(petReaction(12).say).toContain('friends');
    for (let n = 1; n <= 20; n++) expect(['scawy', 'dead']).not.toContain(petReaction(n).face);
  });

  it('holds the reaction face over hover swaps, then settles back after a pause', () => {
    vi.useFakeTimers();
    document.body.innerHTML = HERO;
    const img = document.querySelector<HTMLImageElement>('img[data-pet]')!;
    bindMascot(img);
    initPet();
    for (let i = 0; i < 3; i++) img.click();
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.wink);
    expect(img.dataset.mascotHold).toBe('');
    const bubble = document.querySelector('.home-sun__bubble')!;
    expect(bubble.hasAttribute('data-saying')).toBe(true);
    expect(document.querySelector('[data-pet-say]')!.textContent).toBe('hehe');

    const leave = new Event('pointerleave');
    Object.defineProperty(leave, 'pointerType', { value: 'mouse' });
    img.closest('[data-mascot-trigger]')!.dispatchEvent(leave);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.wink);

    vi.advanceTimersByTime(PET_RESET_MS);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    expect(img.dataset.mascotHold).toBeUndefined();
    expect(bubble.hasAttribute('data-saying')).toBe(false);
  });

  it('floats a heart up per pet', () => {
    vi.useFakeTimers();
    document.body.innerHTML = HERO;
    initPet();
    document.querySelector<HTMLImageElement>('img[data-pet]')!.click();
    expect(document.querySelectorAll('.home-heart svg')).toHaveLength(1);
    vi.advanceTimersByTime(1200);
    expect(document.querySelectorAll('.home-heart')).toHaveLength(0);
  });
});

describe('night face', () => {
  it('rests on data-mascot-dark while the dark theme is on', () => {
    document.body.innerHTML = `<img data-mascot="kawaii" data-mascot-dark="sleepy" src="${MASCOT_URLS.kawaii}" alt="poe">`;
    const img = document.querySelector('img')!;
    applyTheme('light');
    bindMascot(img);
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
    applyTheme('dark');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.sleepy);
    applyTheme('light');
    expect(img.getAttribute('src')).toBe(MASCOT_URLS.kawaii);
  });
});

describe('theme reveal', () => {
  it('covers the whole viewport from any corner', () => {
    expect(revealRadius(0, 0, 300, 400)).toBe(500);
    expect(revealRadius(300, 400, 300, 400)).toBe(500);
    expect(revealRadius(150, 200, 300, 400)).toBe(250);
  });

  it('switches straight away where view transitions are missing', () => {
    applyTheme('light');
    toggleThemeFrom(10, 10);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(false);
  });
});

describe('tab title', () => {
  let state: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    state = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    document.head.innerHTML = '<link rel="icon" href="/favicon.png" type="image/png">';
    document.title = 'atpotato';
  });
  const setVisibility = (next: DocumentVisibilityState) => {
    state = next;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('asks you to come back, says hi, then puts everything back', () => {
    vi.useFakeTimers();
    initTabTitle();
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    setVisibility('hidden');
    expect(document.title).toBe(AWAY_TITLE);
    expect(icon.getAttribute('href')).toBe(MASCOT_URLS.normal);
    setVisibility('visible');
    expect(document.title).toBe(BACK_TITLE);
    vi.advanceTimersByTime(BACK_MS);
    expect(document.title).toBe('atpotato');
    expect(icon.getAttribute('href')).toBe('/favicon.png');
    expect(icon.getAttribute('type')).toBe('image/png');
  });
});

describe('copy email', () => {
  const TILE = `
    <section class="tile home-hi">
      <a class="home-hi__mail" href="mailto:contact@atpota.to">contact@atpota.to</a>
      <button type="button" data-copy-email="contact@atpota.to">copy address</button>
      <p data-copy-bubble>copied!</p>
      <p role="status" data-copy-status></p>
      <img data-copy-potato alt="">
    </section>`;

  it('copies the address and says so', async () => {
    document.body.innerHTML = TILE;
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    initCopyEmail();
    document.querySelector<HTMLButtonElement>('[data-copy-email]')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('contact@atpota.to');
    expect(document.querySelector('[data-copy-bubble]')!.classList.contains('is-showing')).toBe(true);
    expect(document.querySelector('[data-copy-status]')!.textContent).toBe('address copied');
    expect(document.querySelector('[data-copy-potato]')!.classList.contains('is-hopping')).toBe(true);
  });

  it('selects the address when the clipboard says no', async () => {
    document.body.innerHTML = TILE;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    initCopyEmail();
    document.querySelector<HTMLButtonElement>('[data-copy-email]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(window.getSelection()!.toString()).toBe('contact@atpota.to');
    expect(document.querySelector('[data-copy-status]')!.textContent).toBe('address selected, ready to copy');
  });
});

describe('nav pill', () => {
  it('shows behind a hovered link, skips the current page, and hides on leave', () => {
    document.body.innerHTML = `<ul class="site-nav__list">
      <li><a class="site-nav__link" href="/" aria-current="page">home</a></li>
      <li><a class="site-nav__link" href="/guides">guides</a></li></ul>`;
    const list = document.querySelector<HTMLElement>('.site-nav__list')!;
    initNavPill(list);
    const [home, guides] = [...list.querySelectorAll('a')];
    const enter = (el: Element) => {
      const event = new Event('pointerenter');
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      el.dispatchEvent(event);
    };
    enter(guides!);
    expect(list.dataset.pill).toBe('show');
    expect(list.style.getPropertyValue('--pill-w')).toMatch(/px$/);
    enter(home!);
    expect(list.dataset.pill).toBeUndefined();
    enter(guides!);
    list.dispatchEvent(new Event('pointerleave'));
    expect(list.dataset.pill).toBeUndefined();
  });
});
