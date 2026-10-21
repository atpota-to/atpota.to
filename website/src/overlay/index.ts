/**
 * /overlay: Poe and the atmosphere's weather for a livestream, as an OBS browser source.
 * The page is transparent. /overlay?streamer=<handle> takes its settings from that
 * streamer's to.atpota.poe.overlay record (config.ts, store.ts), saved by /overlay/setup,
 * and follows it live: a save shows on stream as soon as Jetstream relays it. Settings in
 * the URL override the record (params.ts); without a streamer it's the defaults.
 *
 *   weather   the live reading (/api/atmosphere), every LIVE_REFRESH_MS while it comes
 *             from the weather station, every REFRESH_MS from the fallback sample, for the
 *             widgets in their slots (weather.ts, layout.ts)
 *   poe       idles in its bottom corner (poe.ts), facing into the screen (mirror.ts), naps
 *             when the stream is quiet, gets visitors now and then (visitors.ts), says
 *             weather alerts when the sky changes (lines.ts), and with ?streamer= watches
 *             that stream.place chat (chat.ts): a cheer when the stream goes live and a
 *             goodbye when it ends, hellos to new chatters and welcome-backs to regulars
 *             (regulars.ts), thanks to new followers, and the commands !weather,
 *             !forecast, !apps, !pet and !poe
 *   demo      example lines every DEMO_MS, and visitors more often, to see where things land
 */

import { fetchForecast, FORECAST_REFRESH_MS, type Forecast } from '../scripts/weather-forecast';
import { alertsFor, type Watch } from '../scripts/weather-alerts';
import { preloadFaces } from '../scripts/mascot';
import { paintMoons } from '../scripts/moon';
import { fetchReading, LIVE_REFRESH_MS, recordsPerSecond, REFRESH_MS, type Reading } from '../scripts/weather';
import { createNames, listen, NOBODY, resolveActor, type StreamEvent, type Who } from './chat';
import { DEFAULT_CONFIG, fromRecord, withOverrides, type OverlayConfig } from './config';
import { createLayout } from './layout';
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
import { leftFaces, RIGHT_FACES } from './mirror';
import { readParams } from './params';
import { mountOverlayPoe } from './poe';
import { createRegulars } from './regulars';
import { createSounds } from './sounds';
import { readPublicConfig } from './store';
import { createVisitors } from './visitors';
import { mountWidgets } from './weather';

/** How often ?demo has Poe say another example line. */
const DEMO_MS = 10_000;
/** How long the first look waits for the streamer's saved settings before showing the defaults. */
const CONFIG_WAIT_MS = 4000;

async function start(): Promise<void> {
  const params = readParams(location.search);
  const layout = createLayout();
  const widgets = mountWidgets(document);
  const corner = document.querySelector<HTMLElement>('[data-ov-poe]')!;
  const poe = mountOverlayPoe(corner);
  preloadFaces();
  // the weather suns turn into tonight's moon in the dark theme, as everywhere on the site
  paintMoons();
  const visitors = createVisitors({ corner, react: (face, ms) => poe.react(face, ms), side: 'right', scale: 1, demo: params.demo });
  const gate = createGate();

  // ---------- settings ----------
  let config: OverlayConfig = withOverrides(DEFAULT_CONFIG, params.overrides);
  let skip = new Set<string>();
  let volume = -1;
  const apply = (next: OverlayConfig) => {
    config = next;
    widgets.showing(layout.apply(config));
    poe.setNap(config.nap * 60_000);
    if (config.volume !== volume) poe.setSounds(createSounds((volume = config.volume)));
    if (config.poe.side === 'left') void leftFaces().then((faces) => config.poe.side === 'left' && poe.setFaces(faces));
    else poe.setFaces(RIGHT_FACES);
    visitors.setSide(config.poe.side);
    visitors.setScale(config.poe.scale / 100);
    visitors.setEnabled(config.poe.show && config.visitors);
    void Promise.all(config.ignore.map((a) => resolveActor(a))).then((dids) => {
      skip = new Set(dids.filter((d): d is string => d !== null));
    });
  };

  const streamerDid = params.streamer ? await resolveActor(params.streamer) : null;
  if (params.streamer && !streamerDid) console.warn(`[overlay] couldn't find the streamer "${params.streamer}"`);
  if (streamerDid) {
    const saved = await Promise.race([readPublicConfig(streamerDid), new Promise<undefined>((r) => window.setTimeout(r, CONFIG_WAIT_MS))]);
    if (saved) config = withOverrides(saved.config, params.overrides);
  }
  apply(config);

  // ---------- the weather ----------
  let latest: Reading | null = null;
  let watch: Watch | null = null;
  const check = async () => {
    const reading = await fetchReading();
    if (reading) {
      latest = reading;
      widgets.render(reading);
      poe.setPace(recordsPerSecond(reading));
      const seen = alertsFor(watch, reading);
      watch = seen.watch;
      if (config.poe.show && config.alerts) {
        for (const alert of seen.alerts) {
          if (gate(`alert:${alert.kind}`, alert.kind === 'arrival' ? ARRIVAL_EVERY_MS : COOLDOWN_MS)) poe.say(alertLine(alert));
        }
      }
    } else widgets.failed();
    window.setTimeout(() => void check(), reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS);
  };
  void check();

  let forecast: { at: number; f: Promise<Forecast | null> } | null = null;
  const readForecastNow = () => {
    if (!forecast || Date.now() - forecast.at > FORECAST_REFRESH_MS) forecast = { at: Date.now(), f: fetchForecast() };
    return forecast.f;
  };

  if (params.demo) {
    const dame: Who = { handle: '@dame.is', avatar: null };
    const demo = [() => helloLine(dame), () => followLine({ handle: '@poe.atpota.to', avatar: null }), () => weatherLine(latest, dame), () => appsLine(latest, dame), () => petLine(dame, true), () => helloLine(dame, true), () => poeLine()];
    let i = 0;
    const next = () => {
      if (config.poe.show) poe.say(demo[i++ % demo.length]!());
    };
    window.setTimeout(next, 1500);
    window.setInterval(next, DEMO_MS);
  }

  // ---------- the stream ----------
  if (!streamerDid) return;
  const streamer = streamerDid;
  const names = createNames();
  const regulars = createRegulars(streamer);
  const said = new Set<string>();
  const onEvent = async (e: StreamEvent) => {
    if (e.kind === 'config') return apply(withOverrides(fromRecord(e.value), params.overrides));
    if (!config.poe.show) return;
    if (e.kind === 'live' || e.kind === 'ended') {
      if (said.has(`${e.kind}:${e.rkey}`)) return;
      said.add(`${e.kind}:${e.rkey}`);
      poe.say(e.kind === 'live' ? liveLine(e.title) : endedLine());
      return;
    }
    if (skip.has(e.did)) return;
    poe.stir();
    if (e.kind === 'follow') {
      if (config.follows && gate(`follow:${e.did}`, Infinity)) poe.say(followLine(await names(e.did)));
      return;
    }
    if (!config.chat) return;
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
  // Follows are asked for all along (a saved change can turn them on); unwanted ones are dropped above.
  listen(streamer, true, (e) => void onEvent(e));
}

void start();
