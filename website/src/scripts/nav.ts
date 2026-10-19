/**
 * Header navigation. aria-current on the main nav links is set at build time by the
 * partials plugin (build/partials.ts), so this module only runs the phone menu:
 * the [data-nav-toggle] button opens the [data-nav-menu] sheet (CSS shows it as a
 * sheet at <=720px when html.js is present). While open: focus moves to the first
 * link, Tab is trapped inside the toggle + sheet, Esc or the scrim closes it and
 * focus returns to the toggle, choosing a link or "ask poe" closes it.
 */

const MOBILE_QUERY = '(max-width: 720px)';
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
}
