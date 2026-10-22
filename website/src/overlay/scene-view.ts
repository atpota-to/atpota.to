/**
 * Draws a scene (scenes.ts) under the rest of the overlay: the backdrop, and either the
 * centre panel (starting, brb, ending) or the screen share's frame.
 *
 *   backdrops   day: the sky blue with drifting clouds, the sun and a green hill; night:
 *               deep blue with stars, tonight's moon and a dark hill; garden: butter sky
 *               over soil with sprouts; butter: sunburst rays turning slowly
 *   panel       the wordmark, the title and subtitle, and on the starting screen the
 *               countdown (a timer from when the scene is shown, or to a time; when it
 *               runs out it says so, and onDone lets Poe cheer), on the end screen the
 *               streamer's links
 *   frame       the backdrop with frameHoles cut out (clip-path), a soft rim round each
 *               window, the title along the bottom, and the weather in the column
 *
 * Every word is the streamer's and goes in through textContent.
 */

import { renderClouds } from '../scripts/weather-sky';
import { countdownText, frameHoles, framePath, type Scene } from './scenes';

/** How often the countdown ticks. */
export const TICK_MS = 250;
export const DONE_TEXT = 'any second now…';

export interface SceneView {
  /** Shows a scene, or none. A timer starts again only when its length changes. */
  show(scene: Scene | null): void;
}

export interface SceneViewOptions {
  /** The countdown ran out (once per countdown). */
  onDone?: () => void;
  win?: Window;
  now?: () => number;
}

export function mountScene(root: HTMLElement, opts: SceneViewOptions = {}): SceneView {
  const win = opts.win ?? window;
  const now = opts.now ?? (() => Date.now());
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const back = q('[data-ovsc-back]');
  const panel = q('[data-ovsc-panel]');
  const title = q('[data-ovsc-title]');
  const sub = q('[data-ovsc-sub]');
  const count = q('[data-ovsc-count]');
  const links = q('[data-ovsc-links]');
  const bar = q('[data-ovsc-bar]');
  const barTitle = q('[data-ovsc-bar-title]');
  const barSub = q('[data-ovsc-bar-sub]');
  const weather = q('[data-ovsc-weather]');
  const holes = q('[data-ovsc-holes]');
  const clouds = root.querySelector<HTMLElement>('[data-ovsc-clouds]');
  const doc = root.ownerDocument;

  let timer: number | undefined;
  let endsAt: number | null = null;
  let countdownKey = '';
  let done = false;

  const tick = () => {
    if (endsAt === null) return;
    const left = endsAt - now();
    const text = countdownText(left);
    count.textContent = text || DONE_TEXT;
    count.classList.toggle('is-done', !text);
    if (!text && !done) {
      done = true;
      opts.onDone?.();
    }
  };

  const place = (el: HTMLElement, r: { x: number; y: number; w: number; h: number }) => {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  };

  return {
    show(scene) {
      root.hidden = !scene;
      win.clearInterval(timer);
      if (!scene) {
        doc.body.removeAttribute('data-scene');
        return;
      }
      doc.body.dataset.scene = scene.kind;
      root.dataset.background = scene.background;
      if (clouds) renderClouds(clouds, scene.background === 'day' ? 6 : scene.background === 'garden' ? 3 : 0, win);

      const framed = scene.kind === 'screenshare';
      panel.hidden = framed;
      bar.hidden = !framed;
      weather.hidden = !framed;
      holes.hidden = !framed;
      if (framed) {
        const h = frameHoles(scene.camera);
        back.style.clipPath = `path(evenodd, '${framePath(h, scene.camera.shape)}')`;
        const [screenHole, cameraHole] = [q('[data-ovsc-hole="screen"]'), q('[data-ovsc-hole="camera"]')];
        place(screenHole, h.screen);
        cameraHole.hidden = !h.camera;
        if (h.camera) place(cameraHole, h.camera);
        cameraHole.classList.toggle('is-circle', scene.camera.shape === 'circle');
        place(bar, h.bar);
        weather.style.left = `${h.column.x}px`;
        weather.style.top = `${h.column.y}px`;
        weather.style.width = `${h.column.w}px`;
        barTitle.textContent = scene.title;
        barSub.textContent = scene.subtitle;
        barSub.hidden = !scene.subtitle;
        root.dataset.camera = scene.camera.side;
      } else {
        back.style.clipPath = '';
        title.textContent = scene.title;
        sub.textContent = scene.subtitle;
        sub.hidden = !scene.subtitle;
        links.replaceChildren(
          ...(scene.kind === 'ending' ? scene.links : []).map((text) => {
            const li = doc.createElement('li');
            li.textContent = text;
            return li;
          }),
        );
        links.hidden = links.childElementCount === 0;
      }

      // the starting screen's countdown
      const cd = scene.kind === 'starting' ? scene.countdown : null;
      const key = cd && cd.mode === 'timer' ? `timer:${cd.minutes}` : cd && cd.mode === 'clock' && cd.at ? `clock:${cd.at}` : '';
      if (key !== countdownKey) {
        countdownKey = key;
        done = false;
        endsAt = !cd || !key ? null : cd.mode === 'timer' ? now() + cd.minutes * 60_000 : Date.parse(cd.at!);
      }
      count.hidden = endsAt === null;
      if (endsAt !== null) {
        tick();
        timer = win.setInterval(tick, TICK_MS);
      }
    },
  };
}
