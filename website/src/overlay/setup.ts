/**
 * /overlay/setup: a form for the overlay's settings (params.ts), the URL they make, and a
 * preview of it with ?demo over a pretend stream, so a streamer can see where Poe and the
 * weather land before pasting the URL into OBS.
 *
 * The preview is the real overlay in an iframe at 1920x1080, scaled down to fit. It's
 * rebuilt a moment after the form stops changing (PREVIEW_DELAY_MS), not on every key.
 */

import { actorOf, DEFAULT_NAP, DEFAULT_VOLUME, PIECES, toSearch, type OverlayParams, type Piece } from './params';

export const PREVIEW_DELAY_MS = 400;
const WIDTH = 1920;

/** The form's settings, as the overlay reads them. */
export function paramsFrom(form: HTMLFormElement): OverlayParams {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? '');
  const show = new Set(data.getAll('show').map(String).filter((s): s is Piece => (PIECES as readonly string[]).includes(s)));
  const number = (name: string, fallback: number) => {
    const n = Number(text(name));
    return Number.isFinite(n) && text(name) !== '' ? n : fallback;
  };
  return {
    show,
    streamer: actorOf(text('streamer')),
    chat: data.has('chat'),
    follows: data.has('follows'),
    alerts: data.has('alerts'),
    ignore: [...new Set(text('ignore').split(/[\s,]+/).map(actorOf).filter((a): a is string => a !== null))],
    volume: number('volume', DEFAULT_VOLUME),
    nap: number('nap', DEFAULT_NAP),
    side: text('side') === 'left' ? 'left' : 'right',
    theme: text('theme') === 'dark' ? 'dark' : 'light',
    demo: false,
  };
}

export function overlayUrl(p: OverlayParams, origin: string): string {
  return `${origin}/overlay${toSearch(p)}`;
}

export function init(root: Document = document): void {
  const form = root.querySelector<HTMLFormElement>('[data-ovs-form]');
  const frame = root.querySelector<HTMLIFrameElement>('[data-ovs-frame]');
  const preview = root.querySelector<HTMLElement>('[data-ovs-preview]');
  const url = root.querySelector<HTMLInputElement>('[data-ovs-url]');
  const copy = root.querySelector<HTMLButtonElement>('[data-ovs-copy]');
  const open = root.querySelector<HTMLAnchorElement>('[data-ovs-open]');
  const status = root.querySelector<HTMLElement>('[data-ovs-status]');
  if (!form || !frame || !preview || !url) return;
  const volumeOut = form.querySelector<HTMLOutputElement>('output[name="volumeOut"]');

  let timer: number | undefined;
  let shown = '';
  const update = () => {
    const p = paramsFrom(form);
    if (volumeOut) volumeOut.value = p.volume > 0 ? String(p.volume) : 'off';
    url.value = overlayUrl(p, location.origin);
    if (open) open.href = url.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const src = `/overlay${toSearch({ ...p, demo: true, volume: 0 })}`;
      if (src !== shown) frame.src = shown = src;
    }, PREVIEW_DELAY_MS);
  };
  form.addEventListener('input', update);
  form.addEventListener('submit', (e) => e.preventDefault());
  update();

  // the 1920x1080 overlay, scaled to the box it sits in
  const fit = () => preview.style.setProperty('--scale', String(preview.clientWidth / WIDTH));
  fit();
  new ResizeObserver(fit).observe(preview);

  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url.value);
      if (status) status.textContent = 'copied (◕‿◕)';
    } catch {
      url.select();
      if (status) status.textContent = 'select it and copy';
    }
    window.setTimeout(() => {
      if (status) status.textContent = '';
    }, 3000);
  });
}
