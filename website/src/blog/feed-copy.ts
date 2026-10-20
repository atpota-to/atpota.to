/**
 * The round rss buttons (server/blog/subscribe.ts feedButtonHtml): a tap copies the feed's
 * address for pasting into a reader, and a little bubble says so. If the clipboard says no,
 * the tap falls through to the link and the browser opens the feed instead.
 */

const COPIED_MS = 1800;

export function initFeedCopy(root: ParentNode = document): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-copy-feed]')) {
    if (link.dataset.copyBound === 'true') continue;
    link.dataset.copyBound = 'true';
    const url = link.dataset.copyFeed ?? link.href;
    const bubble = link.querySelector<HTMLElement>('[data-copy-feed-bubble]');
    const status = link.querySelector<HTMLElement>('[data-copy-feed-status]');
    let hideTimer: number | undefined;

    link.addEventListener('click', (event) => {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      clipboard.writeText(url).then(
        () => {
          if (bubble) {
            bubble.textContent = 'rss link copied!';
            bubble.classList.add('is-showing');
          }
          if (status) status.textContent = 'rss feed link copied';
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => {
            bubble?.classList.remove('is-showing');
            if (status) status.textContent = '';
          }, COPIED_MS);
        },
        () => {
          window.location.href = link.href;
        },
      );
    });
  }
}
