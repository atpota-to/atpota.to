/**
 * Guide page behaviour (spec section 3.2). main.ts imports this module when
 * <body data-page="guide"> and calls init() once.
 *
 * - Reading progress: the fixed bar at the top ([data-reading-progress]) fills as the
 *   article is read. Passive scroll + resize listeners, one rAF per frame.
 * - Contents tracking: an IntersectionObserver on the article's h2s marks the current
 *   section with aria-current="true" on every .toc-link (desktop tile and phone sheet)
 *   and updates the "n/7" count on the contents button.
 * - Contents sheet (< 1200px): the fixed bottom-left "contents" button opens a modal
 *   <dialog>. It closes on Esc, the backdrop, the close button, a link (focus moves to
 *   the chosen section), "/" (so Poe can open), or when the window grows to the desktop
 *   layout. Otherwise focus returns to the button.
 */

const DESKTOP_QUERY = '(min-width: 1200px)';
/** A section is "current" once its heading has crossed this fraction of the viewport. */
const ACTIVE_LINE = 0.3;

/** 0..1 reading progress of an element with this viewport-relative top and height. */
export function readingProgress(top: number, height: number, viewportHeight: number): number {
  const scrollable = height - viewportHeight;
  if (scrollable <= 0) return top <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -top / scrollable));
}

/** Index of the current section: the last heading above the active line, else the first. */
export function activeSectionIndex(tops: readonly number[], viewportHeight: number, line = ACTIVE_LINE): number {
  const limit = viewportHeight * line;
  let index = 0;
  for (let i = 0; i < tops.length; i++) {
    if ((tops[i] ?? Infinity) <= limit) index = i;
    else break;
  }
  return index;
}

/** Fixed top bar. Returns an update function (also run on scroll/resize). */
export function initReadingProgress(article: HTMLElement, bar: HTMLElement): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    const rect = article.getBoundingClientRect();
    const progress = readingProgress(rect.top, rect.height, window.innerHeight);
    bar.style.transform = `scaleX(${progress.toFixed(4)})`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(article);
  update();
  return update;
}

export interface TocTracking {
  /** Recompute the current section now. */
  update: () => void;
  current: () => number;
}

/** Last index whose flag is set, else 0 (the first section counts as current at the top). */
export function lastAbove(flags: readonly boolean[]): number {
  for (let i = flags.length - 1; i >= 0; i--) if (flags[i]) return i;
  return 0;
}

/**
 * The observer's root reaches far above the viewport and ends at the active line, so a
 * heading "intersects" exactly while it sits above that line. Its state then flips
 * whenever it crosses the line in either direction, including instant jumps (End key,
 * scrollbar drags, #links) that a band around the line alone would miss.
 */
const FAR_ABOVE_PX = 1_000_000;

/** Marks the current section in every toc list; calls onChange(index, total) when it changes. */
export function initTocTracking(
  headings: readonly HTMLElement[],
  root: ParentNode,
  onChange?: (index: number, total: number) => void,
): TocTracking {
  let current = -1;
  const linksFor = (id: string) =>
    Array.from(root.querySelectorAll<HTMLAnchorElement>('a.toc-link')).filter((a) => a.getAttribute('href') === `#${id}`);

  const apply = (next: number) => {
    if (headings.length === 0 || next === current) return;
    current = next;
    root.querySelectorAll('a.toc-link[aria-current]').forEach((a) => a.removeAttribute('aria-current'));
    const heading = headings[next];
    if (heading) for (const link of linksFor(heading.id)) link.setAttribute('aria-current', 'true');
    onChange?.(next, headings.length);
  };

  /** Layout-reading fallback (no IntersectionObserver), also exposed for callers. */
  const update = () => {
    if (headings.length === 0) return;
    apply(activeSectionIndex(headings.map((h) => h.getBoundingClientRect().top), window.innerHeight));
  };

  if (typeof IntersectionObserver === 'function') {
    const above = headings.map(() => false);
    const indexOf = new Map(headings.map((h, i) => [h as Element, i]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const i = indexOf.get(entry.target);
          if (i !== undefined) above[i] = entry.isIntersecting;
        }
        apply(lastAbove(above));
      },
      { rootMargin: `${FAR_ABOVE_PX}px 0px -${100 - ACTIVE_LINE * 100}% 0px`, threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
  } else {
    let frame = 0;
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    update();
  }
  return { update, current: () => current };
}

export interface ContentsSheet {
  open: () => void;
  close: (restoreFocus?: boolean) => void;
  isOpen: () => boolean;
}

/** The phone/tablet contents sheet: a modal <dialog> opened by the fixed contents button. */
export function initContentsSheet(button: HTMLButtonElement, dialog: HTMLDialogElement): ContentsSheet {
  const html = document.documentElement;
  const native = typeof dialog.showModal === 'function';
  let restoreFocus = true;
  let pressedOnBackdrop = false;

  const isOpen = () => dialog.open || dialog.hasAttribute('open');

  const onFallbackKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };

  const settle = () => {
    button.setAttribute('aria-expanded', 'false');
    html.classList.remove('is-toc-open');
    document.removeEventListener('keydown', onFallbackKeydown);
  };

  // Runs for every close (our close(), Esc via the native "cancel", form methods):
  // the native "close" event is queued, so settle() already ran when we closed it.
  const finish = () => {
    settle();
    if (restoreFocus && button.isConnected && !button.hidden) button.focus({ preventScroll: true });
    restoreFocus = true;
  };

  function open(): void {
    if (isOpen()) return;
    restoreFocus = true;
    if (native) {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
      document.addEventListener('keydown', onFallbackKeydown);
    }
    button.setAttribute('aria-expanded', 'true');
    html.classList.add('is-toc-open');
    const target =
      dialog.querySelector<HTMLElement>('a.toc-link[aria-current]') ?? dialog.querySelector<HTMLElement>('a.toc-link');
    target?.focus();
  }

  function close(restore = true): void {
    if (!isOpen()) return;
    restoreFocus = restore;
    // Unlock page scrolling before a #section link is followed (same click).
    settle();
    if (native) {
      dialog.close(); // queues "close", which runs finish()
    } else {
      dialog.removeAttribute('open');
      finish();
    }
  }

  dialog.addEventListener('close', finish);

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  dialog.querySelector<HTMLElement>('[data-toc-close]')?.addEventListener('click', () => close());

  // Backdrop: with a padding-less dialog wrapping one panel, only the ::backdrop
  // reports the dialog itself as the target. Require the press to start there too.
  dialog.addEventListener('pointerdown', (event) => {
    pressedOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressedOnBackdrop) close();
    pressedOnBackdrop = false;
  });

  // A contents link: close, let the browser follow the #section link, then move focus
  // to that heading so the next Tab continues from the section that was chosen.
  dialog.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a.toc-link') : null;
    if (!link) return;
    const id = decodeURIComponent((link.getAttribute('href') ?? '').slice(1));
    const heading = id ? document.getElementById(id) : null;
    close(false);
    if (!heading) return;
    requestAnimationFrame(() => {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    });
  });

  dialog.addEventListener('keydown', (event) => {
    // "/" opens Poe (src/poe): close the modal first so Poe is not left behind its inert
    // backdrop. The key event keeps bubbling to Poe's listener; focus is back on the button.
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      close(true);
      return;
    }
    // Keep Tab inside the sheet (wrap at both ends), like the header's phone menu.
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DESKTOP_QUERY).addEventListener('change', (event) => {
      if (event.matches) close(false);
    });
  }

  return { open, close, isOpen };
}

/** Hides the fixed contents button while the footer is on screen. */
function initButtonVisibility(button: HTMLElement): void {
  const footer = document.querySelector('.site-footer');
  if (!footer || typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) button.classList.toggle('is-away', entry.isIntersecting);
    },
    { rootMargin: '0px 0px -72px 0px', threshold: 0 },
  );
  observer.observe(footer);
}

export function init(): void {
  const article = document.querySelector<HTMLElement>('article.guide');
  const body = article?.querySelector<HTMLElement>('.guide__body');
  if (!article || !body) return;

  const bar = document.querySelector<HTMLElement>('[data-reading-progress]');
  if (bar) initReadingProgress(article, bar);

  const button = document.querySelector<HTMLButtonElement>('[data-toc-open]');
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-toc-sheet]');
  const count = button?.querySelector<HTMLElement>('[data-toc-count]');

  const headings = Array.from(body.querySelectorAll<HTMLElement>('h2[id]'));
  initTocTracking(headings, document, (index, total) => {
    if (count) count.textContent = `${index + 1}/${total}`;
  });

  if (button && dialog) {
    initContentsSheet(button, dialog);
    button.hidden = false;
    initButtonVisibility(button);
  }
}
