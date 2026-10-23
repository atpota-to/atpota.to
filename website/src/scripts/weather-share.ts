/**
 * Getting around the report's pages, and sharing them (weather/index.html .weather-topics,
 * src/scripts/weather-topics.ts):
 *
 *   bindPageLinks  the pages' nav and each tile's "on its own page" link carry the lens
 *                  (?w=7d&m=records), so a page opens on what the reader was looking at.
 *                  On a phone the nav scrolls sideways, opening with the current page in
 *                  view, its edges faded where there's more ([data-more="start end"]).
 *   bindShare      "share this page": the phone's share sheet where there is one, else the
 *                  link copied, said in the button and to screen readers. The link is the
 *                  page and its lens, never the #section it was scrolled to.
 */

import { searchFor, type Lens } from './weather-lens';
import { topicBySlug, topicPath, topicOf } from './weather-topics';

/** How long "link copied" stays on the button. */
export const SHARED_MS = 2400;

export function bindPageLinks(root: HTMLElement, lens: Lens): void {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-topic-link], [data-own-page]')];
  const point = () => {
    const search = searchFor(lens.get());
    for (const a of links) a.href = `${topicPath(topicBySlug(a.dataset.topicLink ?? a.dataset.ownPage))}${search}`;
  };
  point();
  lens.onChange(point);
  // the current page in view, where the nav scrolls, and its edges faded where there's more
  const list = root.querySelector<HTMLElement>('.weather-topics__list');
  if (!list) return;
  const current = list.querySelector<HTMLElement>('[aria-current="page"]');
  if (current && list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2);
  const edges = () => {
    const more = [list.scrollLeft > 2 ? 'start' : '', list.scrollLeft + list.clientWidth < list.scrollWidth - 2 ? 'end' : ''].filter(Boolean).join(' ');
    if (more) list.dataset.more = more;
    else delete list.dataset.more;
  };
  edges();
  list.addEventListener('scroll', edges, { passive: true });
  list.ownerDocument.defaultView?.addEventListener('resize', edges, { passive: true });
}

/** What's being shared: the page's title, and its address without the #section. */
export function shareTarget(doc: Document = document): { title: string; url: string } {
  const loc = doc.defaultView?.location ?? location;
  return { title: doc.title, url: `${loc.origin}${loc.pathname}${loc.search}` };
}

export interface ShareDeps {
  share?: (data: ShareData) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

/** Shares, or copies: "shared", "copied", "cancelled" (the reader closed the sheet), or "failed". */
export async function sharePage(target: { title: string; url: string }, deps: ShareDeps): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (deps.share) {
    try {
      await deps.share({ title: target.title, url: target.url });
      return 'shared';
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return 'cancelled';
      // no sheet after all (a desktop browser that has share but nothing to share to): copy instead
    }
  }
  if (!deps.copy) return 'failed';
  try {
    await deps.copy(target.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

const SAID: Record<'copied' | 'failed', [button: string, status: string]> = {
  copied: ['link copied', 'the link to this page is copied.'],
  failed: ["couldn't copy it", "couldn't copy the link. the address bar has it."],
};

export function bindShare(root: ParentNode, deps?: ShareDeps): void {
  const button = root.querySelector<HTMLButtonElement>('[data-weather-share]');
  if (!button) return;
  const words = button.querySelector<HTMLElement>('[data-share-words]');
  const status = root.querySelector<HTMLElement>('[data-share-status]');
  const doc = button.ownerDocument;
  const nav = doc.defaultView?.navigator;
  const use: ShareDeps = deps ?? {
    // the share sheet on a phone; on a desktop the link is the thing, so it's copied
    share: nav?.share && nav.maxTouchPoints > 0 ? (data) => nav.share(data) : undefined,
    copy: nav?.clipboard ? (text) => nav.clipboard.writeText(text) : undefined,
  };
  const idle = words?.textContent ?? '';
  // the topic's own name for the screen reader, where the button only says "share this page"
  const topic = topicOf(doc);
  if (topic) button.setAttribute('aria-label', `share this page: ${topic.label}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    const done = await sharePage(shareTarget(doc), use);
    if (done !== 'copied' && done !== 'failed') return;
    const [said, heard] = SAID[done];
    if (words) words.textContent = said;
    if (status) status.textContent = heard;
    button.dataset.shared = done;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (words) words.textContent = idle;
      if (status) status.textContent = '';
      delete button.dataset.shared;
    }, SHARED_MS);
  });
}
