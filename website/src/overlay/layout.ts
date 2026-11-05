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
 *               There they're tiles that fill their room: below the screen a row as tall
 *               as the room and reaching the screen's edges (tileRow); under the camera a
 *               stack exactly as wide as the camera, short of Poe (squeezeStack). They
 *               shrink to fit, never past the size the streamer asked for
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

export interface Tile {
  /** Its size at zoom 1 (its own width, or as wide as it takes). */
  w: number;
  h: number;
  /** The most it may be (the streamer's size), as a zoom. */
  max: number;
  /** It stretches along the row (the strip): it takes what's left over. */
  flex?: boolean;
}

export interface Placed {
  zoom: number;
  /** Its box on the frame, in the frame's pixels (its own are these over its zoom). */
  w: number;
  h: number;
}

/**
 * The row under the screen as tiles: every widget as tall as the room, each zoomed to fit
 * that height (never past its size), and all of them across the room's width, short of the
 * bar's least (`barMin`, 0 without the bar). What's left over goes to the bar, or the
 * strip, or else to the widgets, each by its share, so the row reaches the screen's edges.
 */
export function tileRow(items: readonly Tile[], room: { w: number; h: number }, barMin = 0, gap = FRAME_GAP): Placed[] {
  if (!items.length || room.w <= 0 || room.h <= 0) return items.map((i) => ({ zoom: i.max, w: i.w * i.max, h: i.h * i.max }));
  const zooms = items.map((i) => (i.h > 0 ? Math.min(i.max, room.h / i.h) : i.max));
  let widths = items.map((i, n) => (i.flex ? 0 : i.w * zooms[n]!));
  const space = Math.max(0, room.w - (barMin > 0 ? barMin + gap : 0) - gap * (items.length - 1));
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum > space && sum > 0) {
    const g = space / sum;
    items.forEach((i, n) => {
      if (!i.flex) zooms[n]! *= g;
    });
    widths = widths.map((w) => w * g);
  }
  const used = widths.reduce((a, b) => a + b, 0);
  const left = Math.max(0, space - used);
  const flexes = items.filter((i) => i.flex).length;
  if (flexes) {
    // the strip shares what's left with the bar, when there is one
    const share = left / (flexes + (barMin > 0 ? 1 : 0));
    widths = widths.map((w, n) => (items[n]!.flex ? share : w));
  } else if (barMin === 0 && used > 0) widths = widths.map((w) => w + (left * w) / used);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return items.map((_, n) => ({ zoom: r(Math.max(0.1, zooms[n]!)), w: Math.round(widths[n]!), h: room.h }));
}

/** How much a stack of `heights` (with gaps) has to shrink to stand in `room` (1 if it fits). */
export function squeezeStack(heights: readonly number[], room: number, gap = FRAME_GAP): number {
  const total = heights.reduce((a, b) => a + b, 0);
  const space = room - gap * Math.max(0, heights.length - 1);
  return total > space && total > 0 ? Math.max(0.1, space / total) : 1;
}

/** How often the frame's widgets are fitted again, as their readings and records change their size. */
export const REFIT_MS = 2000;

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

  const box = (el: HTMLElement, zoom: number, w: number | null, h: number | null) => {
    el.style.setProperty('zoom', String(zoom));
    el.style.width = w === null ? '' : `${Math.round((w / zoom) * 100) / 100}px`;
    el.style.height = h === null ? '' : `${Math.round((h / zoom) * 100) / 100}px`;
  };

  /**
   * Lays the frame's widgets out as tiles in their slots: under the screen a row as tall as
   * the room and as wide as the screen (tileRow); under the camera a stack as wide as the
   * camera, standing short of Poe (squeezeStack). Each is measured at zoom 1 first.
   */
  const fit = () => {
    for (const [place, slot] of frameSlots) {
      const here = framed.filter((f) => f.w.place === place && f.el.parentElement === slot);
      if (slot.hidden || !here.length) continue;
      if (place === 'below') {
        const room = slot.parentElement!;
        const bar = room.querySelector<HTMLElement>('[data-ovsc-bar]');
        const tiles = here.map(({ el, w }) => {
          box(el, 1, null, null);
          return { w: el.offsetWidth, h: el.offsetHeight, max: w.scale / 100, flex: w.kind === 'strip' };
        });
        const placed = tileRow(tiles, { w: room.clientWidth, h: room.clientHeight }, bar && !bar.hidden ? BAR_MIN : 0);
        here.forEach(({ el }, n) => box(el, placed[n]!.zoom, placed[n]!.w, placed[n]!.h));
        continue;
      }
      const width = slot.clientWidth;
      const room = slot.clientHeight - (body.dataset.poe === 'on' ? poeHeight(doc) : 0);
      const zooms = here.map(({ w }) => w.scale / 100);
      // a narrower zoom makes a widget wider in its own pixels, so shorter: measure again
      for (let round = 0; round < 3; round++) {
        const heights = here.map(({ el }, n) => {
          box(el, 1, width / zooms[n]!, null);
          return el.offsetHeight * zooms[n]!;
        });
        const g = squeezeStack(heights, room);
        if (g >= 1) break;
        zooms.forEach((z, n) => (zooms[n] = Math.max(0.1, z * g)));
      }
      here.forEach(({ el }, n) => box(el, zooms[n]!, width, null));
    }
  };
  let refit: number | undefined;

  return {
    apply(config, frame = []) {
      const shown = new Set<WidgetKind>();
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
        box(el, w.scale / 100, null, null);
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
      win?.clearInterval(refit);
      refit = framed.length && win ? win.setInterval(fit, REFIT_MS) : undefined;
      if (framed.length) void doc.fonts?.ready.then(() => fit());
      return shown;
    },
  };
}

/** How tall Poe stands above the foot of the column (its width × 0.68, as overlay.css has it), and a little air. */
function poeHeight(doc: Document): number {
  const width = parseFloat(doc.documentElement.style.getPropertyValue('--ov-poe-width')) || POE_WIDTH;
  return width * 0.68 + 30;
}
