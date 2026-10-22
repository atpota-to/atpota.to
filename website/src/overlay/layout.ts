/**
 * Where everything sits on the 1920x1080 overlay, from the config (config.ts):
 *
 *   six slots   top-left, top-center, top-right, bottom-left, bottom-center, bottom-right.
 *               Widgets in one slot stack, in the order the config lists them; a bottom
 *               slot on Poe's side sits above Poe. The strip runs along the top or the
 *               bottom edge, short of Poe when it's on the same edge.
 *   sizes       each widget's scale (CSS zoom, so a bigger one pushes the next one along)
 *   styles      a widget's style as data-style (config.ts WIDGET_STYLES); the chat's side
 *               strip takes its slot's whole edge, short of Poe on its side
 *   Poe         the bottom-left or bottom-right corner (body[data-side]), its size as
 *               --ov-poe-width
 *
 * The widgets stay in the page all along; a widget that isn't in the config is hidden.
 */

import { SLOTS, type OverlayConfig, type Slot, type WidgetKind } from './config';

export const POE_WIDTH = 300;

export interface Layout {
  apply(config: OverlayConfig): Set<WidgetKind>;
}

export function createLayout(doc: Document = document): Layout {
  const body = doc.body;
  const slots = new Map<Slot, HTMLElement>();
  for (const slot of SLOTS) {
    let el = doc.querySelector<HTMLElement>(`[data-ov-slot="${slot}"]`);
    if (!el) {
      el = doc.createElement('div');
      el.className = `ov-slot ov-slot--${slot}`;
      el.dataset.ovSlot = slot;
      body.append(el);
    }
    slots.set(slot, el);
  }
  const widgets = new Map<WidgetKind, HTMLElement>();
  for (const el of doc.querySelectorAll<HTMLElement>('[data-ov-widget]')) widgets.set(el.dataset.ovWidget as WidgetKind, el);

  return {
    apply(config) {
      const shown = new Set<WidgetKind>();
      for (const w of config.widgets) {
        const el = widgets.get(w.kind);
        const slot = slots.get(w.slot);
        if (!el || !slot) continue;
        shown.add(w.kind);
        slot.append(el);
        el.hidden = false;
        el.style.setProperty('zoom', String(w.scale / 100));
        if (w.style) el.dataset.style = w.style;
        else delete el.dataset.style;
      }
      for (const [kind, el] of widgets) if (!shown.has(kind)) el.hidden = true;
      for (const slot of slots.values()) slot.hidden = ![...slot.children].some((c) => !(c as HTMLElement).hidden);
      body.dataset.side = config.poe.side;
      body.dataset.poe = config.poe.show ? 'on' : 'off';
      doc.documentElement.style.setProperty('--ov-poe-width', `${(POE_WIDTH * config.poe.scale) / 100}px`);
      doc.documentElement.dataset.theme = config.theme;
      return shown;
    },
  };
}
