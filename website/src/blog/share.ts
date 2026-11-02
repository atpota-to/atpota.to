/**
 * "share this issue" in a post's comments header (server/blog/share.ts renders it): a
 * <details> menu of apps to post about the issue from, which works without this module.
 * This makes it behave like a menu: a click outside or Escape closes it, picking an app
 * closes it, and it opens upward when there isn't room below. It also remembers the app a
 * reader picks and lists that one first next time, on every issue.
 *
 * The links are the server's, already filled in for this issue; nothing here builds a URL
 * or HTML.
 */

import type { KeyValueStore } from '../poe/storage';
import { localStoreFor } from './state';

/** localStorage: the id of the app a reader last shared from (an Aturi waypoint id). */
export const SHARE_APP_KEY = 'blog:share-app';
/** Room the menu wants below the button before it opens upward instead. */
const GAP = 12;

export function initShare(root: Document = document, store: KeyValueStore = localStoreFor()): void {
  const menu = root.querySelector<HTMLDetailsElement>('details[data-blog-share]');
  const toggle = menu?.querySelector<HTMLElement>('summary');
  const list = menu?.querySelector<HTMLElement>('[data-share-list]');
  const panel = list?.parentElement;
  if (!menu || !toggle || !list || !panel || menu.dataset.shareBound === 'true') return;
  menu.dataset.shareBound = 'true';
  const win = root.defaultView;

  const apps = [...list.querySelectorAll<HTMLAnchorElement>('a[data-share-app]')];
  // the reader's own app first
  const remembered = store.get(SHARE_APP_KEY);
  const mine = apps.find((a) => a.dataset.shareApp === remembered)?.closest('li');
  if (mine && mine !== list.firstElementChild) list.prepend(mine);

  menu.addEventListener('toggle', () => {
    if (!menu.open) {
      delete menu.dataset.up;
      return;
    }
    // upward when the menu would run off the bottom of the window and fits above
    const button = toggle.getBoundingClientRect();
    const height = panel.getBoundingClientRect().height;
    const below = (win?.innerHeight ?? Infinity) - button.bottom;
    if (below < height + GAP && button.top > height + GAP) menu.dataset.up = '';
  });

  function close(focus: boolean): void {
    if (!menu!.open) return;
    menu!.open = false;
    if (focus) toggle!.focus();
  }

  root.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target as Node)) close(false);
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    close(true);
  });
  for (const app of apps) {
    app.addEventListener('click', () => {
      if (app.dataset.shareApp) store.set(SHARE_APP_KEY, app.dataset.shareApp);
      close(true);
    });
  }
}
