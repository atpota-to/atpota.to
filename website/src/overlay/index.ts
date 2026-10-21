/**
 * /overlay: Poe and the atmosphere's weather for a livestream, as an OBS browser source.
 * The page is transparent; params.ts lists what the URL can ask for.
 *
 *   weather   the live reading (/api/atmosphere), every LIVE_REFRESH_MS while it comes
 *             from the weather station, every REFRESH_MS from the fallback sample
 *   poe       idles in its corner (poe.ts), says weather alerts when the sky changes
 *             (lines.ts), and with ?streamer= watches that stream.place chat (chat.ts):
 *             hellos to new chatters, thanks to new followers, and the commands
 *             !weather, !pet and !poe
 *   demo      example lines every DEMO_MS, to see where the bubble lands
 */

import { alertsFor, type Watch } from '../scripts/weather-alerts';
import { fetchReading, LIVE_REFRESH_MS, recordsPerSecond, REFRESH_MS, type Reading } from '../scripts/weather';
import { createNames, listen, resolveActor, type StreamEvent } from './chat';
import { alertLine, ARRIVAL_EVERY_MS, COMMAND_ANY_MS, COMMAND_EACH_MS, COOLDOWN_MS, createGate, followLine, helloLine, petLine, poeLine, weatherLine } from './lines';
import { readParams } from './params';
import { mountOverlayPoe, type OverlayPoe } from './poe';
import { mountWeatherCard } from './weather';

/** How often ?demo has Poe say another example line. */
const DEMO_MS = 10_000;

function start(): void {
  const params = readParams(location.search);
  const root = document.documentElement;
  root.dataset.theme = params.theme;
  document.body.dataset.side = params.side;

  const card = document.querySelector<HTMLElement>('[data-weather-tile]');
  const corner = document.querySelector<HTMLElement>('[data-ov-poe]');
  if (card) card.hidden = !params.show.has('weather');
  if (corner) corner.hidden = !params.show.has('poe');
  const weather = card && params.show.has('weather') ? mountWeatherCard(card) : null;
  const poe: OverlayPoe | null = corner && params.show.has('poe') ? mountOverlayPoe(corner) : null;
  const gate = createGate();

  // ---------- the weather ----------
  let latest: Reading | null = null;
  let watch: Watch | null = null;
  const check = async () => {
    const reading = await fetchReading();
    if (reading) {
      latest = reading;
      weather?.render(reading);
      poe?.setPace(recordsPerSecond(reading));
      const seen = alertsFor(watch, reading);
      watch = seen.watch;
      if (poe && params.alerts) {
        for (const alert of seen.alerts) {
          if (gate(`alert:${alert.kind}`, alert.kind === 'arrival' ? ARRIVAL_EVERY_MS : COOLDOWN_MS)) poe.say(alertLine(alert));
        }
      }
    } else if (card && card.dataset.state !== 'ready') {
      card.dataset.state = 'error';
    }
    window.setTimeout(() => void check(), reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS);
  };
  void check();

  if (poe && params.demo) {
    const demo = [() => helloLine('@dame.is'), () => followLine('@poe.atpota.to'), () => weatherLine(latest, '@dame.is'), () => petLine('@atpota.to'), () => poeLine()];
    let i = 0;
    const next = () => poe.say(demo[i++ % demo.length]!());
    window.setTimeout(next, 1500);
    window.setInterval(next, DEMO_MS);
  }

  // ---------- the stream ----------
  if (!poe || !params.streamer || (!params.chat && !params.follows)) return;
  const names = createNames();
  void resolveActor(params.streamer).then((streamer) => {
    if (!streamer) {
      console.warn(`[overlay] couldn't find the streamer "${params.streamer}"`);
      return;
    }
    const greeted = new Set<string>([streamer]);
    const onEvent = async (e: StreamEvent) => {
      if (e.kind === 'follow') {
        if (params.follows && gate(`follow:${e.did}`, Infinity)) poe.say(followLine(await names(e.did)));
        return;
      }
      if (!params.chat) return;
      if (e.command) {
        if (!gate(`${e.command}:${e.did}`, COMMAND_EACH_MS) || !gate(e.command, COMMAND_ANY_MS)) return;
        const who = await names(e.did);
        if (e.command === 'weather') poe.say(weatherLine(latest, who));
        else if (e.command === 'pet') poe.say(petLine(who));
        else poe.say(poeLine());
        greeted.add(e.did);
        return;
      }
      if (greeted.has(e.did)) return;
      greeted.add(e.did);
      poe.say(helloLine(await names(e.did)));
    };
    listen(streamer, params.follows, (e) => void onEvent(e));
  });
}

start();
