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
 *   the frame   a screen share scene's own widgets (scenes.ts FrameWidget) go in its two
 *               frame slots instead (data-ov-frame-slot: below the screen, beside it under
 *               the camera), and win over the layout's when both want the same widget.
 *               There they shrink to fit (fitSlot): below the screen, a row no taller than
 *               the room there; under the camera, a stack no wider than the column, short
 *               of Poe when it stands there
 *
 * The widgets stay in the page all along; a widget that isn't in the config is hidden.
 */

import { SLOTS, type OverlayConfig, type Slot, type WidgetKind } from './config';
import type { FrameWidget, FramePlace } from './scenes';

export const POE_WIDTH = 300;

/** The gap between widgets in a frame slot (overlay.css .ovsc__slot). */
export const FRAME_GAP = 18;
/** The narrowest the bar keeps beside the widgets under the screen. */
export const BAR_MIN = 480;

export interface Layout {
  /** Shows the config's widgets in their slots, and `frame`'s on the screen share's frame. */
  apply(config: OverlayConfig, frame?: readonly FrameWidget[]): Set<WidgetKind>;
}

export interface Fitted {
  /** Its size at zoom 1. */
  w: number;
  h: number;
  /** The most it may be (the streamer's size), as a zoom. */
  max: number;
  /** It stretches along the row (the strip), so its width doesn't count. */
  flex?: boolean;
}

/**
 * The zoom for each widget in a frame slot of room × room.h: in a row, each no taller than
 * the room and all of them no wider; in a column, each no wider and all no taller. Never
 * bigger than the streamer asked for.
 */
export function fitSlot(items: readonly Fitted[], room: { w: number; h: number }, row: boolean, gap = FRAME_GAP): number[] {
  if (!items.length || room.w <= 0 || room.h <= 0) return items.map((i) => i.max);
  const cross = row ? room.h : room.w;
  const zooms = items.map((i) => {
    const across = row ? i.h : i.w;
    return across > 0 ? Math.min(i.max, cross / across) : i.max;
  });
  const along = items.reduce((sum, i, n) => sum + (row && i.flex ? 0 : (row ? i.w : i.h) * zooms[n]!), 0);
  const space = (row ? room.w : room.h) - gap * (items.length - 1);
  const squeeze = along > space && along > 0 ? Math.max(0, space) / along : 1;
  return zooms.map((z) => Math.max(0.1, Math.round(z * squeeze * 1000) / 1000));
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
  const frameSlots = new Map<FramePlace, HTMLElement>();
  for (const el of doc.querySelectorAll<HTMLElement>('[data-ov-frame-slot]')) frameSlots.set(el.dataset.ovFrameSlot as FramePlace, el);
  const win = doc.defaultView;
  let framed: Array<{ el: HTMLElement; w: FrameWidget }> = [];

  /** Shrinks the frame's widgets to fit their slots, measuring each at its own size first. */
  const fit = () => {
    for (const [place, slot] of frameSlots) {
      const here = framed.filter((f) => f.w.place === place && f.el.parentElement === slot);
      if (slot.hidden || !here.length) continue;
      const row = place === 'below';
      const measured = here.map(({ el, w }) => {
        el.style.setProperty('zoom', '1');
        return { w: el.offsetWidth, h: el.offsetHeight, max: w.scale / 100, flex: w.kind === 'strip' };
      });
      // under the screen the bar keeps some room; under the camera, Poe stands at the foot
      const bar = row ? slot.parentElement?.querySelector<HTMLElement>('[data-ovsc-bar]') : null;
      const poe = !row && body.dataset.poe === 'on' ? doc.querySelector<HTMLElement>('[data-ov-poe]') : null;
      const room = {
        w: row ? (slot.parentElement?.clientWidth ?? 0) - (bar && !bar.hidden ? BAR_MIN + FRAME_GAP : 0) : slot.clientWidth,
        h: row ? (slot.parentElement?.clientHeight ?? 0) : slot.clientHeight - (poe ? poeHeight(doc) : 0),
      };
      const zooms = fitSlot(measured, room, row);
      here.forEach(({ el }, n) => el.style.setProperty('zoom', String(zooms[n])));
    }
  };
  // a widget's size changes as its readings and records come in: fit again
  const watcher = win && typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => fit()) : null;

  return {
    apply(config, frame = []) {
      const shown = new Set<WidgetKind>();
      watcher?.disconnect();
      framed = [];
      for (const w of frame) {
        const el = widgets.get(w.kind);
        const slot = frameSlots.get(w.place);
        if (!el || !slot) continue;
        shown.add(w.kind);
        slot.append(el);
        el.hidden = false;
        if (w.style) el.dataset.style = w.style;
        else delete el.dataset.style;
        framed.push({ el, w });
      }
      for (const w of config.widgets) {
        const el = widgets.get(w.kind);
        const slot = slots.get(w.slot);
        if (!el || !slot || shown.has(w.kind)) continue;
        shown.add(w.kind);
        slot.append(el);
        el.hidden = false;
        el.style.setProperty('zoom', String(w.scale / 100));
        if (w.style) el.dataset.style = w.style;
        else delete el.dataset.style;
      }
      for (const [kind, el] of widgets) if (!shown.has(kind)) el.hidden = true;
      for (const slot of [...slots.values(), ...frameSlots.values()]) slot.hidden = ![...slot.children].some((c) => !(c as HTMLElement).hidden);
      body.dataset.side = config.poe.side;
      body.dataset.poe = config.poe.show ? 'on' : 'off';
      doc.documentElement.style.setProperty('--ov-poe-width', `${(POE_WIDTH * config.poe.scale) / 100}px`);
      doc.documentElement.dataset.theme = config.theme;
      fit();
      for (const { el } of framed) watcher?.observe(el);
      return shown;
    },
  };
}

/** How tall Poe stands above the foot of the column (its width × 0.68, as overlay.css has it), and a little air. */
function poeHeight(doc: Document): number {
  const width = parseFloat(doc.documentElement.style.getPropertyValue('--ov-poe-width')) || POE_WIDTH;
  return width * 0.68 + 30;
}
