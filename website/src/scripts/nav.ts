/**
 * Header navigation. aria-current on the main nav links is set at build time by the
 * partials plugin (build/partials.ts), so this module only runs the phone menu:
 * the [data-nav-toggle] button opens the [data-nav-menu] sheet (CSS shows it as a
 * sheet at <=880px when html.js is present; the five links and the full wordmark need
 * about 880px side by side). While open: focus moves to the first
 * link, Tab is trapped inside the toggle + sheet, Esc or the scrim closes it and
 * focus returns to the toggle, choosing a link or "ask poe" closes it.
 *
 * On desktop, one hover pill slides between the nav links (components.css draws it
 * as the list's ::before from --pill-x / --pill-w).
 */

const MOBILE_QUERY = '(max-width: 880px)';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function initNav(root: Document = document): void {
  const header = root.querySelector<HTMLElement>('[data-site-header]');
  const toggle = header?.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const menu = header?.querySelector<HTMLElement>('[data-nav-menu]');
  const scrim = root.querySelector<HTMLElement>('[data-nav-scrim]');
  if (!header || !toggle || !menu || header.dataset.navReady === 'true') return;
  header.dataset.navReady = 'true';

  let open = false;

  const focusables = (): HTMLElement[] => [toggle, ...menu.querySelectorAll<HTMLElement>(FOCUSABLE)];

  const onKeydown = (event: KeyboardEvent) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, true);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    const active = root.activeElement as HTMLElement | null;
    if (!first || !last) return;
    if (event.shiftKey && (active === first || !header.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !header.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  function setOpen(next: boolean, restoreFocus: boolean): void {
    if (next === open) return;
    open = next;
    toggle!.setAttribute('aria-expanded', String(next));
    header!.classList.toggle('is-menu-open', next);
    if (scrim) scrim.hidden = !next;
    if (next) {
      root.addEventListener('keydown', onKeydown);
      const firstLink = menu!.querySelector<HTMLElement>(FOCUSABLE);
      // Wait a frame so the sheet is visible (visibility transitions) before focusing.
      requestAnimationFrame(() => firstLink?.focus());
    } else {
      root.removeEventListener('keydown', onKeydown);
      if (restoreFocus) toggle!.focus();
    }
  }

  toggle.addEventListener('click', () => setOpen(!open, false));
  scrim?.addEventListener('click', () => setOpen(false, true));
  menu.addEventListener('click', (event) => {
    if (!open) return;
    const target = event.target instanceof Element ? event.target.closest('a[href], [data-poe-open]') : null;
    if (target) setOpen(false, false);
  });

  if (typeof window.matchMedia === 'function') {
    window.matchMedia(MOBILE_QUERY).addEventListener('change', (event) => {
      if (!event.matches) setOpen(false, false);
    });
  }

  const list = menu.querySelector<HTMLElement>('.site-nav__list');
  if (list) initNavPill(list);
}

/** The sliding hover pill behind the desktop nav links. */
export function initNavPill(list: HTMLElement): void {
  const links = [...list.querySelectorAll<HTMLAnchorElement>('.site-nav__link')];

  const moveTo = (link: HTMLAnchorElement) => {
    // The current page already wears its own pill.
    if (link.getAttribute('aria-current') === 'page') {
      hide();
      return;
    }
    const appearing = list.dataset.pill !== 'show';
    if (appearing) list.dataset.pill = 'jump';
    list.style.setProperty('--pill-x', `${link.offsetLeft}px`);
    list.style.setProperty('--pill-w', `${link.offsetWidth}px`);
    if (appearing) {
      void list.offsetWidth;
      list.dataset.pill = 'show';
    }
  };
  const hide = () => {
    delete list.dataset.pill;
  };

  for (const link of links) {
    link.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') moveTo(link);
    });
    link.addEventListener('focus', () => {
      let keyboard = true;
      try {
        keyboard = link.matches(':focus-visible');
      } catch {
        // older engines without :focus-visible: treat every focus as keyboard focus
      }
      if (keyboard) moveTo(link);
    });
  }
  list.addEventListener('pointerleave', hide);
  list.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node && list.contains(event.relatedTarget))) hide();
  });
}
