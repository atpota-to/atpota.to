/**
 * /overlay: Poe and the atmosphere's weather for a livestream, as an OBS browser source.
 * The page is transparent; params.ts lists what the URL can ask for, and /overlay/setup
 * (setup.ts) builds the URL with a preview.
 *
 *   weather   the live reading (/api/atmosphere), every LIVE_REFRESH_MS while it comes
 *   strip     from the weather station, every REFRESH_MS from the fallback sample, on the
 *             card, the strip or both
 *   poe       idles in its corner (poe.ts) and naps when the stream is quiet, says weather
 *             alerts when the sky changes (lines.ts), and with ?streamer= watches that
 *             stream.place chat (chat.ts): a cheer when the stream goes live and a goodbye
 *             when it ends, hellos to new chatters and welcome-backs to regulars
 *             (regulars.ts), thanks to new followers, and the commands !weather,
 *             !forecast, !apps, !pet and !poe
 *   demo      example lines every DEMO_MS, to see where the bubble lands
 */

import { fetchForecast, FORECAST_REFRESH_MS, type Forecast } from '../scripts/weather-forecast';
import { alertsFor, type Watch } from '../scripts/weather-alerts';
import { fetchReading, LIVE_REFRESH_MS, recordsPerSecond, REFRESH_MS, type Reading } from '../scripts/weather';
import { createNames, listen, NOBODY, resolveActor, type StreamEvent, type Who } from './chat';
import {
  alertLine,
  appsLine,
  ARRIVAL_EVERY_MS,
  COMMAND_ANY_MS,
  COMMAND_EACH_MS,
  COOLDOWN_MS,
  createGate,
  endedLine,
  followLine,
  forecastLine,
  helloLine,
  liveLine,
  PETS_STREAMER,
  petLine,
  poeLine,
  weatherLine,
} from './lines';
import { readParams } from './params';
import { mountOverlayPoe, type OverlayPoe } from './poe';
import { createRegulars } from './regulars';
import { createSounds } from './sounds';
import { mountWeatherCard, type WeatherCard } from './weather';

/** How often ?demo has Poe say another example line. */
const DEMO_MS = 10_000;

function start(): void {
  const params = readParams(location.search);
  document.documentElement.dataset.theme = params.theme;
  document.body.dataset.side = params.side;
  document.body.dataset.pieces = [...params.show].join(' ');

  const cards: WeatherCard[] = [];
  for (const [piece, selector] of [
    ['weather', '[data-ov-card]'],
    ['strip', '[data-ov-strip]'],
  ] as const) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    el.hidden = !params.show.has(piece);
    if (!el.hidden) cards.push(mountWeatherCard(el));
  }
  const corner = document.querySelector<HTMLElement>('[data-ov-poe]');
  if (corner) corner.hidden = !params.show.has('poe');
  const poe: OverlayPoe | null = corner && params.show.has('poe') ? mountOverlayPoe(corner, { sounds: createSounds(params.volume), napMs: params.nap * 60_000 }) : null;
  const gate = createGate();

  // ---------- the weather ----------
  let latest: Reading | null = null;
  let watch: Watch | null = null;
  const check = async () => {
    const reading = await fetchReading();
    if (reading) {
      latest = reading;
      for (const card of cards) card.render(reading);
      poe?.setPace(recordsPerSecond(reading));
      const seen = alertsFor(watch, reading);
      watch = seen.watch;
      if (poe && params.alerts) {
        for (const alert of seen.alerts) {
          if (gate(`alert:${alert.kind}`, alert.kind === 'arrival' ? ARRIVAL_EVERY_MS : COOLDOWN_MS)) poe.say(alertLine(alert));
        }
      }
    } else {
      for (const card of cards) card.failed();
    }
    window.setTimeout(() => void check(), reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS);
  };
  void check();

  let forecast: { at: number; f: Promise<Forecast | null> } | null = null;
  const readForecastNow = () => {
    if (!forecast || Date.now() - forecast.at > FORECAST_REFRESH_MS) forecast = { at: Date.now(), f: fetchForecast() };
    return forecast.f;
  };

  if (poe && params.demo) {
    const dame: Who = { handle: '@dame.is', avatar: null };
    const demo = [() => helloLine(dame), () => followLine({ handle: '@poe.atpota.to', avatar: null }), () => weatherLine(latest, dame), () => appsLine(latest, dame), () => petLine(dame, true), () => helloLine(dame, true), () => poeLine()];
    let i = 0;
    const next = () => poe.say(demo[i++ % demo.length]!());
    window.setTimeout(next, 1500);
    window.setInterval(next, DEMO_MS);
  }

  // ---------- the stream ----------
  if (!poe || !params.streamer) return;
  const names = createNames();
  void Promise.all([resolveActor(params.streamer), Promise.all(params.ignore.map((a) => resolveActor(a)))]).then(([streamer, ignored]) => {
    if (!streamer) {
      console.warn(`[overlay] couldn't find the streamer "${params.streamer}"`);
      return;
    }
    const skip = new Set(ignored.filter((d): d is string => d !== null));
    const regulars = createRegulars(streamer);
    const said = new Set<string>();
    const onEvent = async (e: StreamEvent) => {
      if (e.kind === 'live' || e.kind === 'ended') {
        if (said.has(`${e.kind}:${e.rkey}`)) return;
        said.add(`${e.kind}:${e.rkey}`);
        poe.say(e.kind === 'live' ? liveLine(e.title) : endedLine());
        return;
      }
      if (skip.has(e.did)) return;
      poe.stir();
      if (e.kind === 'follow') {
        if (params.follows && gate(`follow:${e.did}`, Infinity)) poe.say(followLine(await names(e.did)));
        return;
      }
      if (!params.chat) return;
      const greeting = e.did === streamer ? null : regulars.greet(e.did);
      if (e.command) {
        if (!gate(`${e.command}:${e.did}`, COMMAND_EACH_MS) || !gate(e.command, COMMAND_ANY_MS)) return;
        const who = e.command === 'poe' ? NOBODY : await names(e.did);
        if (e.command === 'weather') poe.say(weatherLine(latest, who));
        else if (e.command === 'apps') poe.say(appsLine(latest, who));
        else if (e.command === 'forecast') poe.say(forecastLine(await readForecastNow(), who));
        else if (e.command === 'pet') poe.say(petLine(who, streamer === PETS_STREAMER));
        else poe.say(poeLine());
        return;
      }
      if (greeting) poe.say(helloLine(await names(e.did), greeting === 'welcome-back'));
    };
    listen(streamer, params.follows, (e) => void onEvent(e));
  });
}

start();
