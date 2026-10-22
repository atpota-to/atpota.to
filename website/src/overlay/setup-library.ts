/**
 * The setup page's front page (overlay/setup.html, data-ovs-library): a card for each saved
 * layout and screen, with a sketch of it, its name, a line about it, and buttons (edit,
 * copy its URL, open it, and for a layout duplicate). setup.ts decides what the buttons do.
 *
 *   layout sketch   a little 16:9 screen with a chip in each slot for each widget there,
 *                   and Poe in its corner (layout.ts places the real ones the same way)
 *   screen sketch   the screen's sky (or Anisota's black) with its title on it
 *
 * Names and titles are the streamer's and go in through textContent.
 */

import { MASCOT_URLS } from '../scripts/mascot';
import { SLOTS, WIDGET_GROUPS, type OverlayConfig, type WidgetKind } from './config';
import { SCENE_NAMES, type Scene } from './scenes';

/** A word for each widget, for the sketch. */
export const WIDGET_SHORT: Record<WidgetKind, string> = {
  card: 'weather',
  strip: 'strip',
  badge: 'badge',
  apps: 'apps',
  forecast: 'forecast',
  pulse: 'pulse',
  moon: 'moon',
  mark: 'mark',
  loader: 'loader',
  tid: 'tid clock',
  flushes: 'flushes',
  status: 'status',
  music: 'music',
  chat: 'chat',
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "poe bottom right · 2 weather widgets · anisota's moon · music, chat", or what's missing. */
export function layoutSummary(c: OverlayConfig): string {
  const parts = [c.poe.show ? `poe bottom ${c.poe.side}` : 'no poe'];
  const weather = c.widgets.filter((w) => WIDGET_GROUPS.weather.includes(w.kind)).length;
  const anisota = c.widgets.filter((w) => WIDGET_GROUPS.anisota.includes(w.kind)).map((w) => WIDGET_SHORT[w.kind]);
  if (weather) parts.push(count(weather, 'weather widget'));
  if (anisota.length) parts.push(`anisota's ${anisota.join(' and ')}`);
  const rest = c.widgets.filter((w) => !WIDGET_GROUPS.weather.includes(w.kind) && !WIDGET_GROUPS.anisota.includes(w.kind)).map((w) => WIDGET_SHORT[w.kind]);
  if (rest.length) parts.push(rest.join(', '));
  if (!c.widgets.length) parts.push('no widgets');
  return parts.join(' · ');
}

/** "be right back screen · coding-brb". */
export function screenSummary(s: Scene, id: string): string {
  return `${SCENE_NAMES[s.kind]} screen${id === s.kind ? '' : ` · ${id}`}`;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function layoutSketch(doc: Document, c: OverlayConfig): HTMLElement {
  const box = el(doc, 'div', { class: 'ovs-sketch', 'data-theme': c.theme, 'aria-hidden': 'true' });
  for (const slot of SLOTS) {
    const here = c.widgets.filter((w) => w.slot === slot);
    if (!here.length) continue;
    const stack = el(doc, 'div', { class: `ovs-sketch__slot ovs-sketch__slot--${slot}` });
    for (const w of here) stack.append(el(doc, 'span', { class: `ovs-sketch__chip${WIDGET_GROUPS.anisota.includes(w.kind) ? ' is-anisota' : ''}`, 'data-kind': w.kind }, WIDGET_SHORT[w.kind]));
    box.append(stack);
  }
  if (c.poe.show) box.append(el(doc, 'img', { class: `ovs-sketch__poe ovs-sketch__poe--${c.poe.side}`, src: MASCOT_URLS.happy, alt: '' }));
  return box;
}

export function screenSketch(doc: Document, s: Scene): HTMLElement {
  const box = el(doc, 'div', { class: 'ovs-sketch ovs-sketch--screen', 'data-kind': s.kind, 'data-background': s.background, 'aria-hidden': 'true' });
  if (s.kind === 'screenshare') {
    box.append(el(doc, 'span', { class: 'ovs-sketch__window' }));
    if (s.camera.side !== 'none') box.append(el(doc, 'span', { class: `ovs-sketch__cam ovs-sketch__cam--${s.camera.side}` }));
  } else {
    box.append(el(doc, 'span', { class: 'ovs-sketch__title' }, s.title || (s.kind === 'loading' ? 'anisota' : SCENE_NAMES[s.kind])));
    if (s.kind === 'clock') box.append(el(doc, 'span', { class: 'ovs-sketch__tid' }, '3m2tidclock22'));
  }
  return box;
}

export interface CardAction {
  label: string;
  /** A link instead of a button (opens in a new tab). */
  href?: string;
  primary?: boolean;
  /** What it says for a moment after a click ("copied"). */
  done?: string;
  run?: () => void | Promise<unknown>;
}

export interface CardSpec {
  id: string;
  name: string;
  meta: string;
  sketch: HTMLElement;
  /** Shown on the card, in a small badge ("main"). */
  badge?: string;
  actions: CardAction[];
}

export const DONE_MS = 2000;

export function card(doc: Document, spec: CardSpec, win: Window = doc.defaultView ?? window): HTMLLIElement {
  const li = el(doc, 'li', { class: 'ovs-card', 'data-id': spec.id });
  const words = el(doc, 'div', { class: 'ovs-card__words' });
  const title = el(doc, 'h3', { class: 'ovs-card__name' }, spec.name);
  if (spec.badge) title.append(' ', el(doc, 'span', { class: 'ovs-card__badge' }, spec.badge));
  words.append(title, el(doc, 'p', { class: 'ovs-card__meta' }, spec.meta));
  const buttons = el(doc, 'div', { class: 'ovs-card__actions' });
  for (const a of spec.actions) {
    const cls = `btn btn--sm ${a.primary ? 'btn--primary' : 'btn--outline'}`;
    if (a.href) {
      buttons.append(el(doc, 'a', { class: cls, href: a.href, target: '_blank', rel: 'noopener' }, a.label));
      continue;
    }
    const b = el(doc, 'button', { type: 'button', class: cls, 'data-action': a.label }, a.label);
    b.addEventListener('click', async () => {
      await a.run?.();
      if (!a.done) return;
      b.textContent = a.done;
      win.setTimeout(() => (b.textContent = a.label), DONE_MS);
    });
    buttons.append(b);
  }
  li.append(spec.sketch, words, buttons);
  return li;
}
