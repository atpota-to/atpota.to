/**
 * The "/" shortcut (SPEC 4.6): opens Poe unless focus is somewhere the visitor
 * types (input, textarea, select, contenteditable, ARIA text boxes) or a modifier
 * key is held. Shift is not treated as a modifier: event.key is already "/" after
 * the keyboard layout is applied, and some layouts (German, Nordic) need Shift
 * to type a slash at all. Ctrl, Alt (including AltGr) and Meta are modifiers.
 */

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** True when `el` (or an ancestor) takes text input. */
export function isTypingTarget(el: Element | null | undefined): boolean {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // jsdom and some older engines do not implement isContentEditable; check the attribute too.
  const editable = el.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  const role = el.getAttribute('role');
  if (role && TEXT_ROLES.has(role)) return true;
  return false;
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

export function hasModifier(event: KeyLike): boolean {
  return Boolean(event.ctrlKey || event.altKey || event.metaKey);
}

/** Should this keydown open Poe? `active` is document.activeElement. */
export function isSlashShortcut(event: KeyLike, active: Element | null): boolean {
  if (event.key !== '/') return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (hasModifier(event)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (isTypingTarget(target) || isTypingTarget(active)) return false;
  return true;
}

/** Another modal dialog (a native <dialog> opened with showModal) owns the page. */
export function otherModalOpen(doc: Document, own: Element | null): boolean {
  for (const dialog of Array.from(doc.querySelectorAll('dialog[open]'))) {
    if (own && own.contains(dialog)) continue;
    try {
      if (dialog.matches(':modal')) return true;
    } catch {
      return true; // engine without :modal; an open dialog is enough to stay out of the way
    }
  }
  return false;
}
