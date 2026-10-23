// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardUrl, PAGE as PAGE_FILE, topicForPath, weatherTopics, withTopic } from '../build/weather-topics.js';
import { isCard } from '../server/og-weather-cards.js';
import { initLensDock, PAGE_NOTES, sectionsOf, unitAloneOn } from '../src/scripts/weather-dock.js';
import { bindLens, createLens, LENS_KEY } from '../src/scripts/weather-lens.js';
import { bindPageLinks, bindShare, SHARED_MS, sharePage, shareTarget } from '../src/scripts/weather-share.js';
import { TOPICS, topicBySlug, topicOf, topicPath } from '../src/scripts/weather-topics.js';

// The weather report's pages: /weather/<topic> is weather/index.html with the topic's own
// title, tags and card, showing only the topic's tiles.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const CSS = readFileSync(resolve(process.cwd(), 'src/styles/weather.css'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const hosts = topicBySlug('hosts')!;
const today = topicBySlug('today')!;

const meta = (html: string, attr: string, name: string) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`))?.[1];

describe('the topics', () => {
  it('are diversity, trends, today, pds hosts and migration, each with a card the og function draws', () => {
    expect(TOPICS.map((t) => [t.slug, t.label])).toEqual([
      ['diversity', 'diversity'],
      ['trends', 'trends'],
      ['today', 'today'],
      ['hosts', 'pds hosts'],
      ['migration', 'migration'],
    ]);
    for (const t of TOPICS) {
      expect(isCard(t.card), t.slug).toBe(true);
      // their own words, and Poe's nudge in Poe's voice
      expect(t.pageTitle, t.slug).toMatch(/ · the atmosphere weather report · atpotato$/);
      expect(t.nudge, t.slug).toMatch(/^psst\. .* \(◕‿◕\)$/);
      expect(`${t.title} ${t.lede} ${t.description} ${t.nudge}`, t.slug).not.toMatch(/[A-Z—]/);
    }
    expect(new Set(TOPICS.map((t) => t.slug)).size).toBe(TOPICS.length);
  });

  it('each has its tiles in the page, every tile names only topics there are, and each is hidden off its page', () => {
    const doc = new DOMParser().parseFromString(MAIN, 'text/html');
    const tiles = [...doc.querySelectorAll<HTMLElement>('[data-topics]')];
    for (const tile of tiles) for (const slug of tile.dataset.topics!.split(' ')) expect(topicBySlug(slug), slug).not.toBeNull();
    for (const t of TOPICS) {
      expect(tiles.filter((x) => x.dataset.topics!.split(' ').includes(t.slug)).length, t.slug).toBeGreaterThan(0);
      expect(CSS).toContain(`html[data-weather-topic="${t.slug}"] .weather > [data-topics]:not([data-topics~="${t.slug}"])`);
    }
    // the pds hosts page is the hosts; moving house is the moves and the sign-ups
    const on = (slug: string) => tiles.filter((x) => x.dataset.topics!.split(' ').includes(slug)).map((x) => x.getAttribute('aria-labelledby'));
    expect(on('hosts')).toEqual(['weather-hosts-title', 'weather-sizes-title', 'weather-census-title']);
    expect(on('migration')).toEqual(['weather-arrivals-title', 'weather-winds-title']);
    // the header, the dock, the nav and how i measure it are on every page
    for (const sel of ['[data-weather-hero]', '[data-weather-dock]', '.weather-topics', '.weather-how']) expect(doc.querySelector(sel)!.hasAttribute('data-topics'), sel).toBe(false);
  });

  it("are the pages' nav, in order, after the whole report", () => {
    const doc = new DOMParser().parseFromString(MAIN, 'text/html');
    const links = [...doc.querySelectorAll<HTMLAnchorElement>('.weather-topics [data-topic-link]')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/weather', 'the whole report'],
      ...TOPICS.map((t) => [topicPath(t), t.label]),
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    // and each topic's namesake tile links to its page
    expect([...doc.querySelectorAll<HTMLAnchorElement>('[data-own-page]')].map((a) => a.getAttribute('href'))).toEqual(TOPICS.map(topicPath));
  });

  it('are found by their address, and only theirs', () => {
    expect(topicForPath('/weather/hosts')).toBe(hosts);
    expect(topicForPath('/weather/hosts/')).toBe(hosts);
    expect(topicForPath('/weather')).toBeNull();
    expect(topicForPath('/weather/nope')).toBeNull();
    expect(topicForPath('/weather/hosts/more')).toBeNull();
    expect(topicForPath('/garden/hosts')).toBeNull();
  });
});

describe("a topic's page", () => {
  const html = withTopic(PAGE, hosts);

  it('is the page with its own title, description, address and card', () => {
    expect(html).toContain('<html lang="en" data-weather-topic="hosts">');
    expect(html).toContain('<title>pds hosts and independence · the atmosphere weather report · atpotato</title>');
    expect(html).toContain('<link rel="canonical" href="https://atpota.to/weather/hosts">');
    expect(meta(html, 'property', 'og:url')).toBe('https://atpota.to/weather/hosts');
    expect(meta(html, 'property', 'og:title')).toBe(hosts.pageTitle);
    expect(meta(html, 'name', 'description')).toBe(hosts.description.replace(/'/g, '&#39;'));
    expect(meta(html, 'property', 'og:description')).toBe(meta(html, 'name', 'description'));
    expect(meta(html, 'property', 'og:image')).toBe('https://atpota.to/og/weather.png?card=hosts');
    expect(meta(html, 'property', 'og:image:alt')).toBe(hosts.alt);
    // the image's size and type are the card's, as on /weather
    expect([meta(html, 'property', 'og:image:width'), meta(html, 'property', 'og:image:height')]).toEqual(['1200', '630']);
    expect(html).toContain(`data-poe-nudge="${hosts.nudge}"`);
  });

  it("titles the header in the topic's words, and marks it in the nav", () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('h1')!.textContent).toBe('where the atmosphere lives');
    expect(doc.querySelector('[data-topic-lede]')!.textContent).toBe(hosts.lede);
    expect([...doc.querySelectorAll('[aria-current="page"][data-topic-link]')].map((a) => a.getAttribute('data-topic-link'))).toEqual(['hosts']);
    // the rest of the page is the page
    expect(doc.querySelector('[data-weather-report]')).not.toBeNull();
    expect(html.length - PAGE.length).toBeLessThan(2000);
  });

  it('every topic makes one, and each card is its own', () => {
    for (const t of TOPICS) {
      const page = withTopic(PAGE, t);
      expect(meta(page, 'property', 'og:image'), t.slug).toBe(cardUrl(t));
      expect(page, t.slug).toContain(`data-weather-topic="${t.slug}"`);
    }
    expect(new Set(TOPICS.map(cardUrl)).size).toBe(TOPICS.length);
  });

  it("won't make one from a page it can't find the parts of", () => {
    expect(() => withTopic(PAGE.replace(/<meta property="og:image" content="[^"]*">/, ''), hosts)).toThrow(/og:image/);
    expect(() => withTopic(PAGE.replace('data-topic-title', ''), hosts)).toThrow(/title/);
    expect(() => withTopic(PAGE.replace('data-topic-link="migration"', ''), topicBySlug('migration')!)).toThrow(/migration's link/);
  });
});

describe('the build', () => {
  it('writes each topic beside the built page, from it', () => {
    const plugin = weatherTopics({ root: process.cwd() });
    const emitted: Array<{ fileName: string; source: string }> = [];
    const hook = plugin.generateBundle as { order: string; handler: (this: unknown, o: unknown, b: unknown) => void };
    expect(hook.order).toBe('post');
    const built = PAGE.replace('<script type="module" src="/src/scripts/main.ts"></script>', '<script type="module" crossorigin src="/assets/main-abc123.js"></script>');
    hook.handler.call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) }, {}, { [PAGE_FILE]: { type: 'asset', source: built } });
    expect(emitted.map((f) => f.fileName)).toEqual(TOPICS.map((t) => `weather/${t.slug}.html`));
    for (const f of emitted) expect(f.source).toContain('/assets/main-abc123.js');
    expect(() => hook.handler.call({ emitFile: () => {} }, {}, {})).toThrow(/no weather\/index\.html/);
  });

  it('serves them under vite dev and preview at their own addresses', async () => {
    const plugin = weatherTopics({ root: process.cwd() });
    const use = (hook: unknown, server: object) => {
      let mw: ((req: { url: string; method?: string }, res: unknown, next: () => void) => void) | null = null;
      (hook as (s: unknown) => void)({ ...server, middlewares: { use: (fn: typeof mw) => (mw = fn) } });
      return mw!;
    };
    // preview: the built file
    const preview = use(plugin.configurePreviewServer, {});
    const req = { url: '/weather/migration?w=7d' };
    preview(req, {}, () => {});
    expect(req.url).toBe('/weather/migration.html?w=7d');
    const other = { url: '/weather' };
    preview(other, {}, () => {});
    expect(other.url).toBe('/weather');
    // dev: the source page, swapped, then transformed like any page
    const transformed: string[] = [];
    const dev = use(plugin.configureServer, { transformIndexHtml: async (url: string, html: string) => (transformed.push(url), html) });
    const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
    await new Promise<void>((done) =>
      dev(
        { url: '/weather/hosts', method: 'GET' },
        { set statusCode(v: number) { sent.status = v; }, setHeader: (k: string, v: string) => (sent.headers[k] = v), end: (b: string) => ((sent.body = b), done()) },
        () => done(),
      ),
    );
    expect(transformed).toEqual(['/weather/index.html']);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('data-weather-topic="hosts"');
    let passed = false;
    dev({ url: '/weather/nope', method: 'GET' }, {}, () => (passed = true));
    expect(passed).toBe(true);
  });
});

describe('the page, on a topic', () => {
  let report: HTMLElement;
  beforeEach(() => {
    localStorage.removeItem(LENS_KEY);
    history.replaceState(null, '', '/weather/hosts');
    document.documentElement.dataset.weatherTopic = 'hosts';
    document.body.innerHTML = MAIN;
    report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    window.requestAnimationFrame = (fn) => {
      fn(0);
      return 0;
    };
  });
  afterEach(() => {
    delete document.documentElement.dataset.weatherTopic;
  });

  it('knows which it is', () => {
    expect(topicOf(document)).toBe(hosts);
    delete document.documentElement.dataset.weatherTopic;
    expect(topicOf(document)).toBeNull();
  });

  it("is one section in the dock: the topic's, with what reaches it, and nowhere to jump", () => {
    expect(sectionsOf(report).map((s) => [s.key, s.label, [...s.lens]])).toEqual([['hosts', 'pds hosts', ['window']]]);
    initLensDock(report, createLens());
    const dock = report.querySelector<HTMLElement>('[data-weather-dock]')!;
    expect(dock.querySelector('[data-dock-section]')!.textContent).toBe('pds hosts');
    expect(dock.querySelector<HTMLElement>('[data-dock-nav]')!.hidden).toBe(true);
    expect(dock.querySelectorAll('[data-dock-nav] a')).toHaveLength(0);
    expect(dock.dataset.lensOff).toBe('measure unit');
    const note = dock.querySelector<HTMLElement>('[data-dock-note]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(PAGE_NOTES.window);
    expect(dock.querySelector<HTMLElement>('[data-dock-hint]')!.hidden).toBe(true);
    // the strip says only what reaches it: "pds hosts · 1h"
    expect([...dock.querySelectorAll<HTMLElement>('[data-dock-now] [data-part]')].filter((x) => !x.hidden).map((x) => x.textContent)).toEqual(['1h']);
  });

  it("today's page keeps its unit, by accounts or records: its tiles only ever count records", () => {
    document.documentElement.dataset.weatherTopic = 'today';
    expect(topicOf(document)).toBe(today);
    // only today's: the hosts don't follow the unit, and trends follow the measure too
    expect(TOPICS.filter(unitAloneOn).map((t) => t.slug)).toEqual(['today']);
    const lens = createLens();
    bindLens(report, lens, { unitAlone: true });
    initLensDock(report, lens);
    const unit = report.querySelector<HTMLSelectElement>('[data-lens-unit]')!;
    expect(lens.get().measure).toBe('accounts');
    expect(unit.disabled).toBe(false);
    const shown = () => [...report.querySelectorAll<HTMLElement>('[data-dock-now] [data-part]')].filter((x) => !x.hidden).map((x) => x.textContent);
    expect(shown()).toEqual(['per second']);
    unit.value = 'hour';
    unit.dispatchEvent(new Event('change'));
    expect(shown()).toEqual(['per hour']);
    // on the whole report it stands aside for accounts, as before
    const elsewhere = document.createElement('div');
    elsewhere.innerHTML = '<select data-lens-unit><option value="second">per second</option></select>';
    bindLens(elsewhere, createLens());
    expect(elsewhere.querySelector('select')!.disabled).toBe(true);
  });

  it("points the nav and the tiles' own-page links at the pages, lens and all", () => {
    const lens = createLens();
    bindPageLinks(report, lens);
    const href = (sel: string) => report.querySelector<HTMLAnchorElement>(sel)!.getAttribute('href');
    expect(href('[data-topic-link=""]')).toBe('/weather');
    expect(href('[data-topic-link="migration"]')).toBe('/weather/migration');
    lens.set({ window: 'week', measure: 'records' });
    expect(href('[data-topic-link=""]')).toBe('/weather?w=7d&m=records');
    expect(href('[data-own-page="trends"]')).toBe('/weather/trends?w=7d&m=records');
  });
});

describe('sharing', () => {
  const target = { title: 'pds hosts', url: 'https://atpota.to/weather/hosts?w=7d' };

  it("shares the page and its lens, never the section it's scrolled to", () => {
    history.replaceState(null, '', '/weather/hosts?w=7d#where-the-atmosphere-lives');
    document.title = 'pds hosts';
    expect(shareTarget(document)).toEqual({ title: 'pds hosts', url: `${location.origin}/weather/hosts?w=7d` });
  });

  it('uses the share sheet, or copies the link when there is none or it fails, and lets a closed sheet be', async () => {
    const share = vi.fn(async () => {});
    const copy = vi.fn(async () => {});
    expect(await sharePage(target, { share, copy })).toBe('shared');
    expect(share).toHaveBeenCalledWith(target);
    expect(copy).not.toHaveBeenCalled();
    expect(await sharePage(target, { copy })).toBe('copied');
    expect(copy).toHaveBeenCalledWith(target.url);
    const closed = Object.assign(new Error('closed'), { name: 'AbortError' });
    expect(await sharePage(target, { share: async () => Promise.reject(closed), copy })).toBe('cancelled');
    expect(await sharePage(target, { share: async () => Promise.reject(new Error('nothing to share to')), copy })).toBe('copied');
    expect(await sharePage(target, { copy: async () => Promise.reject(new Error('denied')) })).toBe('failed');
    expect(await sharePage(target, {})).toBe('failed');
  });

  it('says it copied the link, on the button and to screen readers, then goes back to how it was', async () => {
    vi.useFakeTimers();
    try {
      document.documentElement.dataset.weatherTopic = 'migration';
      document.body.innerHTML = MAIN;
      const copy = vi.fn(async () => {});
      bindShare(document, { copy });
      const button = document.querySelector<HTMLButtonElement>('[data-weather-share]')!;
      expect(button.getAttribute('aria-label')).toBe('share this page: migration');
      button.click();
      await vi.waitFor(() => expect(button.dataset.shared).toBe('copied'));
      expect(button.querySelector('[data-share-words]')!.textContent).toBe('link copied');
      expect(document.querySelector('[data-share-status]')!.textContent).toMatch(/copied/);
      vi.advanceTimersByTime(SHARED_MS);
      expect(button.querySelector('[data-share-words]')!.textContent).toBe('share this page');
      expect(button.dataset.shared).toBeUndefined();
    } finally {
      vi.useRealTimers();
      delete document.documentElement.dataset.weatherTopic;
    }
  });
});
