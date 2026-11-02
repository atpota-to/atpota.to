// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { SHARE_APP_KEY, initShare } from '../src/blog/share.js';
import {
  BLUESKY_APP,
  composeUrl,
  loadShareApps,
  MAX_SHARE_TITLE,
  resetShareCache,
  shareApps,
  shareHtml,
  shareText,
  toShareApp,
  WAYPOINTS_URL,
} from '../server/blog/share.js';
import type { KeyValueStore } from '../src/poe/storage.js';

// "share this issue" at the bottom of a post: Aturi's compose waypoints as a menu
// (server/blog/share.ts), and the browser's part (src/blog/share.ts).

const waypoint = (id: string, name: string, template: string | null, prefillsText = true) => ({
  id,
  name,
  composeIntent: template === null ? null : { url: template.replace('{text}', 'hi'), urlTemplate: template, textParam: 'text', prefillsText },
});

/** What aturi.to/api/waypoints?capability=compose answers, trimmed. */
const AT_URI_WAYPOINTS = {
  ok: true,
  waypoints: [
    waypoint('anisota', 'Anisota', 'https://anisota.net/intent/compose?text={text}'),
    waypoint('bluesky', 'Bluesky', 'https://bsky.app/intent/compose?text={text}'),
    waypoint('impro', 'Impro', 'https://impro.social/intent/compose', false),
    waypoint('deer', 'Deer', 'https://deer.social/intent/compose?text={text}'),
  ],
};

describe('apps from aturi', () => {
  it('keeps apps that fill in the text, Bluesky first, names in lowercase', () => {
    expect(shareApps(AT_URI_WAYPOINTS)).toEqual([
      { id: 'bluesky', name: 'bluesky', template: 'https://bsky.app/intent/compose?text={text}' },
      { id: 'anisota', name: 'anisota', template: 'https://anisota.net/intent/compose?text={text}' },
      { id: 'deer', name: 'deer', template: 'https://deer.social/intent/compose?text={text}' },
    ]);
  });

  it('refuses templates that are not https, or have no single {text}, and odd ids or names', () => {
    expect(toShareApp(waypoint('evil', 'Evil', 'javascript:alert({text})'))).toBeNull();
    expect(toShareApp(waypoint('plain', 'Plain', 'http://plain.test/intent/compose?text={text}'))).toBeNull();
    expect(toShareApp(waypoint('twice', 'Twice', 'https://twice.test/?a={text}&b={text}'))).toBeNull();
    expect(toShareApp(waypoint('none', 'None', 'https://none.test/intent/compose'))).toBeNull();
    expect(toShareApp(waypoint('gone', 'Gone', null))).toBeNull();
    expect(toShareApp(waypoint('Bad Id', 'Bad', 'https://bad.test/?text={text}'))).toBeNull();
    expect(toShareApp(waypoint('long', 'x'.repeat(41), 'https://long.test/?text={text}'))).toBeNull();
    expect(toShareApp({ id: 'nope' })).toBeNull();
  });

  it('still offers Bluesky when aturi lists nothing usable, and drops repeats', () => {
    expect(shareApps({ waypoints: 'nope' })).toEqual([BLUESKY_APP]);
    expect(shareApps(null)).toEqual([BLUESKY_APP]);
    const twice = shareApps({ waypoints: [AT_URI_WAYPOINTS.waypoints[3], AT_URI_WAYPOINTS.waypoints[3]] });
    expect(twice.map((a) => a.id)).toEqual(['bluesky', 'deer']);
  });
});

describe('loadShareApps', () => {
  beforeEach(() => resetShareCache());

  it('reads aturi once and keeps the list', async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(AT_URI_WAYPOINTS), { status: 200 });
    }) as typeof fetch;
    expect((await loadShareApps(fetchFn)).map((a) => a.id)).toEqual(['bluesky', 'anisota', 'deer']);
    expect((await loadShareApps(fetchFn)).map((a) => a.id)).toEqual(['bluesky', 'anisota', 'deer']);
    expect(urls).toEqual([WAYPOINTS_URL]);
  });

  it('falls back to Bluesky alone when aturi fails, and waits before asking again', async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response('down', { status: 502 });
    }) as typeof fetch;
    expect(await loadShareApps(down)).toEqual([BLUESKY_APP]);
    expect(await loadShareApps(down)).toEqual([BLUESKY_APP]);
    expect(calls).toBe(1);
    const thrown = (async () => {
      throw new TypeError('network');
    }) as typeof fetch;
    resetShareCache();
    expect(await loadShareApps(thrown)).toEqual([BLUESKY_APP]);
  });
});

describe('the menu', () => {
  const url = 'https://atpota.to/blog/issue-2';

  it('writes the dispatch, the title and the address, clipping a long title', () => {
    expect(shareText("poe's atmosphere dispatch", '  a  big\nweek ', url)).toBe(`poe's atmosphere dispatch: a big week\n\n${url}`);
    const long = shareText('d', 'x'.repeat(400), url);
    expect(long.split('\n')[0]).toBe(`d: ${'x'.repeat(MAX_SHARE_TITLE - 1)}…`);
  });

  it('fills the template with the text encoded', () => {
    expect(composeUrl(BLUESKY_APP, 'a & b\n#c')).toBe('https://bsky.app/intent/compose?text=a%20%26%20b%0A%23c');
  });

  it('is a menu of every app, each opening its composer in a new tab', () => {
    document.body.innerHTML = shareHtml(shareApps(AT_URI_WAYPOINTS), `"<b>"\n\n${url}`);
    const menu = document.querySelector('details[data-blog-share]')!;
    expect(menu.querySelector('summary')!.textContent).toBe('share this issue');
    // a phone shows just "share" (blog.css hides the rest)
    expect(menu.querySelector('summary .post-share__long')!.textContent).toBe(' this issue');
    const links = [...menu.querySelectorAll<HTMLAnchorElement>('a[data-share-app]')];
    expect(links.map((a) => a.textContent)).toEqual(['bluesky', 'anisota', 'deer']);
    expect(links[0]!.getAttribute('href')).toBe(`https://bsky.app/intent/compose?text=${encodeURIComponent(`"<b>"\n\n${url}`)}`);
    expect(links.every((a) => a.target === '_blank' && a.rel === 'noopener')).toBe(true);
    expect(menu.querySelector('.post-share__fine a')!.getAttribute('href')).toBe('https://aturi.to');
    expect(document.body.innerHTML).not.toContain('<b>');
  });

  it('is a plain "share on bluesky" link when Bluesky is the only app', () => {
    document.body.innerHTML = shareHtml([BLUESKY_APP], 'hi');
    expect(document.querySelector('details')).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>('a[data-share-app="bluesky"]')!;
    expect(link.textContent).toBe('share on bluesky');
    expect(link.getAttribute('href')).toBe('https://bsky.app/intent/compose?text=hi');
  });
});

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      data.set(k, v);
      return true;
    },
    remove: (k) => void data.delete(k),
  };
}

describe('initShare', () => {
  function mount(store = memoryStore()) {
    document.body.innerHTML = `<main>${shareHtml(shareApps(AT_URI_WAYPOINTS), 'hi')}</main><p id="outside">elsewhere</p>`;
    initShare(document, store);
    const menu = document.querySelector<HTMLDetailsElement>('details[data-blog-share]')!;
    const ids = () => [...menu.querySelectorAll<HTMLAnchorElement>('a[data-share-app]')].map((a) => a.dataset.shareApp);
    return { menu, store, ids, app: (id: string) => menu.querySelector<HTMLAnchorElement>(`a[data-share-app="${id}"]`)! };
  }

  it("lists the reader's last app first", () => {
    expect(mount().ids()).toEqual(['bluesky', 'anisota', 'deer']);
    expect(mount(memoryStore({ [SHARE_APP_KEY]: 'deer' })).ids()).toEqual(['deer', 'bluesky', 'anisota']);
    // an app aturi no longer lists changes nothing
    expect(mount(memoryStore({ [SHARE_APP_KEY]: 'gone' })).ids()).toEqual(['bluesky', 'anisota', 'deer']);
  });

  it('remembers the app picked and closes', () => {
    const { menu, store, app } = mount();
    menu.open = true;
    app('anisota').addEventListener('click', (e) => e.preventDefault());
    app('anisota').click();
    expect(store.data.get(SHARE_APP_KEY)).toBe('anisota');
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('summary'));
  });

  it('closes on a click outside, and on Escape back on the button', () => {
    const { menu } = mount();
    menu.open = true;
    menu.querySelector<HTMLElement>('.post-share__label')!.click();
    expect(menu.open).toBe(true);
    document.getElementById('outside')!.click();
    expect(menu.open).toBe(false);
    menu.open = true;
    menu.querySelector('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('summary'));
  });
});
