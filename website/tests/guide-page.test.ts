// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGuide, paragraphKind, renderGuide } from '../build/guide-markdown.js';
import {
  activeSectionIndex,
  initContentsSheet,
  initReadingProgress,
  initTocTracking,
  lastAbove,
  readingProgress,
} from '../src/scripts/guide.js';

// jsdom replaces the global URL, so hand node:fs plain paths.
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url).href);
const read = (p: string) => readFileSync(path(p), 'utf8');
const publicDir = path('../public');

describe('guide page shell + build output', () => {
  const shell = read('../guides/bluesky-for-brands.html');
  const guide = renderGuide(read('../public/guides/how-to-use-bluesky-to-grow-your-brand.md'), { publicDir });
  const html = applyGuide(shell, guide);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  it('fills every marker and keeps no agent instructions', () => {
    expect(html).not.toMatch(/@guide-|@reading-time|GUIDE AGENT/);
    expect(doc.querySelectorAll('.guide-toc .toc-link')).toHaveLength(7);
    expect(doc.querySelectorAll('dialog .toc-link')).toHaveLength(7);
    expect(doc.querySelector('.guide__reading-time')!.textContent!.trim()).toBe(guide.readingTime);
  });

  it('marks the article askable and keeps the header copy and links', () => {
    const article = doc.querySelector('main#main article.guide[data-poe-askable]')!;
    expect(article).not.toBeNull();
    expect(article.querySelector('h1')!.textContent).toBe('How to use Bluesky to grow your brand');
    expect(article.querySelector('.guide__subtitle')!.textContent).toBe('A comprehensive guide for companies, communities, and creators');
    expect(article.querySelector('.guide__crumbs')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('guides bluesky for brands');
    expect(article.querySelector('.guide__author a')!.getAttribute('href')).toBe('https://bsky.app/profile/dame.is');
    const thanks = article.querySelector('.guide__thanks')!;
    expect(thanks.textContent).toBe('Thanks to Protocol Labs for their support in helping make this guide possible.');
    expect(thanks.querySelector('a')!.getAttribute('href')).toBe('https://bsky.app/profile/protocollabs.bsky.social');
    // the toc tile and the sheet live outside the askable article
    expect(article.querySelector('.guide-toc, dialog')).toBeNull();
  });

  it('keeps the h2 anchors section-1..7 inside the article body, in order', () => {
    const ids = [...doc.querySelectorAll('.guide__body h2')].map((h) => h.id);
    expect(ids).toEqual(['section-1', 'section-2', 'section-3', 'section-4', 'section-5', 'section-6', 'section-7']);
    const hrefs = [...doc.querySelectorAll('.guide-toc .toc-link')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(ids.map((id) => `#${id}`));
  });

  it('wires the contents button to the sheet', () => {
    const button = doc.querySelector('button[data-toc-open]')!;
    expect(button.getAttribute('aria-controls')).toBe('guide-toc-sheet');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('hidden')).toBe(true); // shown by guide.ts
    const dialog = doc.getElementById('guide-toc-sheet')!;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('aria-labelledby')).toBe('toc-sheet-title');
    expect(dialog.querySelector('[data-toc-close]')!.getAttribute('aria-label')).toBe('close contents');
  });
});

describe('404 shell', () => {
  const doc = new DOMParser().parseFromString(read('../404.html'), 'text/html');
  it('has the dead potato, the copy and root-absolute buttons', () => {
    const main = doc.querySelector('main#main.notfound')!;
    expect(main.querySelector('h1')!.textContent).toBe('nothing growing here.');
    const img = main.querySelector<HTMLImageElement>('img[data-mascot="dead"]')!;
    expect(img.getAttribute('src')).toBe('/src/assets/mascot/potato-dead.svg');
    expect(img.getAttribute('alt')).toBeTruthy();
    expect([...main.querySelectorAll('.notfound__actions a')].map((a) => a.getAttribute('href'))).toEqual(['/', '/guides/bluesky-for-brands']);
    expect(doc.querySelector('meta[name="robots"]')!.getAttribute('content')).toBe('noindex');
    expect(read('../404.html')).not.toContain('GUIDE AGENT');
  });
});

describe('paragraph classes', () => {
  it('classifies image-only, bold-only and code-only paragraphs', () => {
    const { html } = renderGuide('![a](x.png)\n\n**1. Step.** \n- item\n\n`a`  \n`b`\n\nAs **bold** text\n\n`one` code\n');
    expect(html).toContain('<p class="guide-media"><img src="/guides/x.png"');
    expect(html).toContain('<p class="guide-step"><strong>1. Step.</strong>');
    expect(html).toContain('<p class="guide-codes"><code>a</code><br><code>b</code></p>');
    expect(html).toContain('<p>As <strong>bold</strong> text</p>');
    expect(html).toContain('<p><code>one</code> code</p>');
    expect(paragraphKind([])).toBeUndefined();
  });

  it('finds the real guide structures', () => {
    const { html } = renderGuide(read('../public/guides/how-to-use-bluesky-to-grow-your-brand.md'), { publicDir });
    expect(html.match(/<p class="guide-media">/g)).toHaveLength(12);
    expect(html.match(/<p class="guide-step">/g)).toHaveLength(6);
    expect(html.match(/<p class="guide-codes">/g)).toHaveLength(1);
  });
});

describe('reading progress + section maths', () => {
  it('readingProgress clamps to 0..1 across the article', () => {
    expect(readingProgress(200, 5000, 800)).toBe(0);
    expect(readingProgress(0, 5000, 800)).toBe(0);
    expect(readingProgress(-2100, 5000, 800)).toBeCloseTo(0.5);
    expect(readingProgress(-4200, 5000, 800)).toBe(1);
    expect(readingProgress(-9000, 5000, 800)).toBe(1);
    expect(readingProgress(10, 500, 800)).toBe(0); // shorter than the viewport
    expect(readingProgress(-1, 500, 800)).toBe(1);
  });

  it('activeSectionIndex picks the last heading above the 30% line, else the first', () => {
    expect(activeSectionIndex([500, 1500, 2500], 1000)).toBe(0);
    expect(activeSectionIndex([-800, 300, 1300], 1000)).toBe(1);
    expect(activeSectionIndex([-2000, -1000, 250], 1000)).toBe(2);
    expect(activeSectionIndex([], 1000)).toBe(0);
  });

  it('lastAbove returns the last flagged index, else 0', () => {
    expect(lastAbove([false, false, false])).toBe(0);
    expect(lastAbove([true, true, false])).toBe(1);
    expect(lastAbove([true, true, true])).toBe(2);
  });

  it('initReadingProgress scales the bar from the article rect', () => {
    document.body.innerHTML = '<article></article><div id="bar"></div>';
    const article = document.querySelector('article')!;
    const bar = document.getElementById('bar')!;
    let top = 100;
    article.getBoundingClientRect = () => ({ top, height: 3000, bottom: top + 3000, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    const update = initReadingProgress(article, bar);
    expect(bar.style.transform).toBe('scaleX(0.0000)');
    top = -1000;
    update();
    expect(bar.style.transform).toBe('scaleX(0.5000)');
  });
});

describe('toc tracking (no IntersectionObserver: layout fallback)', () => {
  it('marks the current section in every list and reports index/total', () => {
    document.body.innerHTML = `
      <h2 id="section-1"></h2><h2 id="section-2"></h2><h2 id="section-3"></h2>
      <ol><li><a class="toc-link" href="#section-1"></a></li><li><a class="toc-link" href="#section-2"></a></li><li><a class="toc-link" href="#section-3"></a></li></ol>
      <ol><li><a class="toc-link" href="#section-1"></a></li><li><a class="toc-link" href="#section-2"></a></li><li><a class="toc-link" href="#section-3"></a></li></ol>`;
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    const headings = [...document.querySelectorAll<HTMLElement>('h2')];
    const tops = [400, 1400, 2400];
    headings.forEach((h, i) => (h.getBoundingClientRect = () => ({ top: tops[i]! }) as DOMRect));
    const onChange = vi.fn();
    const tracking = initTocTracking(headings, document, onChange);
    const current = () => [...document.querySelectorAll('a[aria-current="true"]')].map((a) => a.getAttribute('href'));
    expect(current()).toEqual(['#section-1', '#section-1']);
    expect(onChange).toHaveBeenLastCalledWith(0, 3);
    tops.splice(0, 3, -1600, -600, 200);
    tracking.update();
    expect(current()).toEqual(['#section-3', '#section-3']);
    expect(onChange).toHaveBeenLastCalledWith(2, 3);
    expect(tracking.current()).toBe(2);
  });
});

function sheetFixture() {
  document.body.innerHTML = `
    <button type="button" data-toc-open aria-expanded="false" aria-controls="sheet">contents</button>
    <dialog id="sheet">
      <div class="panel">
        <button type="button" data-toc-close aria-label="close contents">x</button>
        <ol>
          <li><a class="toc-link" href="#section-1">one</a></li>
          <li><a class="toc-link" href="#section-2" aria-current="true">two</a></li>
          <li><a class="toc-link" href="#section-3">three</a></li>
        </ol>
      </div>
    </dialog>
    <h2 id="section-1">one</h2><h2 id="section-2">two</h2><h2 id="section-3">three</h2>`;
  return {
    button: document.querySelector<HTMLButtonElement>('[data-toc-open]')!,
    dialog: document.querySelector<HTMLDialogElement>('dialog')!,
  };
}

const key = (k: string, opts: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });

describe('contents sheet (fallback without showModal)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens on the current link, closes on Esc and returns focus to the button', () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.classList.contains('is-toc-open')).toBe(true);
    expect(document.activeElement?.getAttribute('href')).toBe('#section-2');
    document.activeElement!.dispatchEvent(key('Escape'));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.documentElement.classList.contains('is-toc-open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('closes from the close button and from a backdrop click, not from a click inside', () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    dialog.querySelector<HTMLElement>('.panel')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    dialog.querySelector<HTMLElement>('.panel')!.click();
    expect(dialog.hasAttribute('open')).toBe(true);
    dialog.querySelector<HTMLButtonElement>('[data-toc-close]')!.click();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(button);

    button.click();
    dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('closes on a link and moves focus to that section heading', () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    const link = dialog.querySelector<HTMLAnchorElement>('a[href="#section-3"]')!;
    link.addEventListener('click', (e) => e.preventDefault()); // jsdom does not navigate
    link.click();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(document.getElementById('section-3'));
    expect(document.getElementById('section-3')!.getAttribute('tabindex')).toBe('-1');
  });

  it('wraps Tab inside the sheet and closes on "/" (so Poe can open)', () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    const last = dialog.querySelector<HTMLAnchorElement>('a[href="#section-3"]')!;
    const first = dialog.querySelector<HTMLButtonElement>('[data-toc-close]')!;
    last.focus();
    const tab = key('Tab');
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = key('Tab', { shiftKey: true });
    first.dispatchEvent(back);
    expect(document.activeElement).toBe(last);

    const slash = key('/');
    last.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false); // keeps going to Poe's listener
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});

describe('contents sheet (native showModal path)', () => {
  // jsdom has no showModal/close; stub them to exercise the native code path.
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    };
  });
  afterEach(() => {
    delete proto.showModal;
    delete proto.close;
    vi.unstubAllGlobals();
  });

  it('syncs state immediately and restores focus when the native close event lands', async () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    expect(dialog.hasAttribute('open')).toBe(true);
    dialog.querySelector<HTMLButtonElement>('[data-toc-close]')!.click();
    // scroll lock + aria-expanded are released before the queued "close" event
    expect(document.documentElement.classList.contains('is-toc-open')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await Promise.resolve();
    expect(document.activeElement).toBe(button);
  });

  it('handles a close the browser started (Esc -> cancel -> close)', async () => {
    const { button, dialog } = sheetFixture();
    initContentsSheet(button, dialog);
    button.click();
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.documentElement.classList.contains('is-toc-open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});

describe('guide colour pairs meet WCAG AA in both themes', () => {
  const tokens = read('../src/styles/tokens.css');
  const guideCss = read('../src/styles/guide.css');
  const block = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`no ${selector}`);
    const body = css.slice(start, css.indexOf('\n}', start));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  const light = { ...block(tokens, ':root'), ...block(guideCss, ':root') };
  const dark = { ...light, ...block(tokens, 'html[data-theme="dark"]'), ...block(guideCss, 'html[data-theme="dark"]') };
  const resolve = (vars: Record<string, string>, name: string): string => {
    const v = vars[name];
    const ref = v && /^var\(--([a-z0-9-]+)\)$/.exec(v);
    if (ref) return resolve(vars, ref[1]!);
    if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`--${name}: ${v}`);
    return v;
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  // [text, surface, minimum]
  const PAIRS: Array<[string, string, number]> = [
    ['text', 'guide-bg', 4.5], // article
    ['ink', 'guide-bg', 4.5], // headings
    ['text-soft', 'guide-bg', 4.5], // subtitle, h5
    ['muted', 'guide-bg', 4.5], // crumbs, meta, thanks
    ['link', 'guide-bg', 4.5],
    ['link-hover', 'guide-bg', 4.5],
    ['focus', 'guide-bg', 3],
    ['leaf', 'guide-bg', 3], // progress bar
    ['ink', 'flesh-tint', 4.5], // inline code
    ['text', 'card', 4.5], // toc tile, sheet, contents button
    ['muted', 'card', 4.5], // toc time + hint
    ['muted', 'bg', 4.5], // toc numbers, button count
    ['leaf-strong', 'leaf-tint', 4.5], // current toc entry
    ['card', 'leaf', 4.5], // current toc number
    ['on-brown', 'brown', 4.5], // contents button while open
    ['text', 'bg', 4.5], // 404
    ['text-soft', 'bg', 4.5],
    ['muted', 'bg', 4.5],
  ];
  for (const [theme, vars] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${theme}: --${fg} on --${bg} >= ${min}`, () => {
        expect(ratio(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
