/**
 * Poe, the corner helper on every page (SPEC 4.6). main.ts calls mountPoe() once
 * per page after theme/nav/mascot setup. The widget's styles live in
 * src/styles/poe.css and are imported here, so Vite bundles them into every
 * page's shared CSS.
 *
 * Ways in: the corner potato, any [data-poe-open] element, the window event
 * "poe:open", the "/" key, and the highlight-to-ask pill inside [data-poe-askable].
 */
import '../styles/poe.css';
import { preloadFaces } from '../scripts/mascot';
import { PoeWidget, type PoeWidgetOptions } from './ui';

let widget: PoeWidget | null = null;

export function mountPoe(options: PoeWidgetOptions = {}): PoeWidget | null {
  if (widget) return widget;
  const doc = options.doc ?? document;
  if (!doc.body || doc.getElementById('poe-root')) return null;
  widget = new PoeWidget(options);
  widget.mount();
  try {
    preloadFaces();
  } catch {
    // preloading is a nicety
  }
  return widget;
}

/** Test hook. */
export function unmountPoe(): void {
  widget?.destroy();
  widget = null;
}

export { PoeWidget };
