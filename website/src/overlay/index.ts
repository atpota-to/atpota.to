/**
 * /overlay: Poe and the atmosphere's weather for a livestream, as an OBS browser source.
 * The page is transparent. /overlay?streamer=<handle> takes its settings from that
 * streamer's to.atpota.poe.overlay record (config.ts, store.ts: their main layout, or
 * &layout=<id> for another), saved by /overlay/setup,
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
 *   scene     with &scene=<screen>, a full-screen scene under it all (scenes.ts,
 *             scene-view.ts), from the streamer's to.atpota.poe.scene record at that id
 *             (starting, brb, ending, screenshare, or one they named), followed live too; a
 *             scene can hide Poe and the widgets, and the screen share puts Poe on its
 *             camera's side
 *   anisota   Anisota's moon, mark and loader as widgets, and its loading screen as a
 *             scene (anisota.ts), for streamers who use it
 *   tid       the time as an atproto TID, ticking, as a widget and a waiting screen (tid.ts)
 *   records   the streamer's flushes, status and vitals, and teal.fm music (records.ts),
 *             read from their repo while on screen and again when Jetstream says they
 *             changed; ?who= reads someone's without a streamer (the setup preview)
 *   chat      the stream.place chat on screen, when the streamer turns it on (onscreen.ts)
 *   demo      example lines every DEMO_MS, and visitors more often, to see where things land;
 *             example chat, and example records when there's nobody to read
 */

import { fetchForecast, FORECAST_REFRESH_MS, type Forecast } from '../scripts/weather-forecast';
import { alertsFor, type Watch } from '../scripts/weather-alerts';
import { preloadFaces } from '../scripts/mascot';
import { paintMoons } from '../scripts/moon';
import { fetchReading, LIVE_REFRESH_MS, recordsPerSecond, REFRESH_MS, type Reading } from '../scripts/weather';
import { createNames, listen, NOBODY, resolveActor, type StreamEvent, type Who } from './chat';
import { DEFAULT_CONFIG, fromRecord, withOverrides, type OverlayConfig } from './config';
import { mountAnisota } from './anisota';
import { mountOnscreenChat } from './onscreen';
import { mountRecords } from './records';
import { mountTid } from './tid';
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
import { mountScene } from './scene-view';
import { fromSceneRecord, readSceneParams, SCENE_DEFAULTS, withSceneOverrides, type Scene } from './scenes';
import { readPublicConfig, readPublicScene } from './store';
import { createVisitors } from './visitors';
import { mountWeatherCard, mountWidgets } from './weather';

/** How often ?demo has Poe say another example line. */
const DEMO_MS = 10_000;
/** How long the first look waits for the streamer's saved settings before showing the defaults. */
const CONFIG_WAIT_MS = 4000;

async function start(): Promise<void> {
  const params = readParams(location.search);
  const sceneParams = readSceneParams(location.search);
  const layout = createLayout();
  const widgets = mountWidgets(document);
  const corner = document.querySelector<HTMLElement>('[data-ov-poe]')!;
  const poe = mountOverlayPoe(corner);
  preloadFaces();
  // the weather suns turn into tonight's moon in the dark theme, as everywhere on the site
  paintMoons();
  mountAnisota(document);
  mountTid(document);
  const records = mountRecords(document);
  const chatEl = document.querySelector<HTMLElement>('[data-ov-widget="chat"]');
  const onscreen = chatEl ? mountOnscreenChat(chatEl) : null;
  const visitors = createVisitors({ corner, react: (face, ms) => poe.react(face, ms), side: 'right', scale: 1, demo: params.demo });
  const gate = createGate();

  const sceneRoot = document.querySelector<HTMLElement>('[data-ov-scene]')!;
  const sceneView = mountScene(sceneRoot, {
    onDone: () => {
      if (config.poe.show) poe.say({ label: "it's time", text: "here we go! (◕‿◕)", face: 'happy', hop: true, burst: 'leaves', sound: 'live', rank: 4 });
    },
  });
  const sceneWeather = mountWeatherCard(sceneRoot.querySelector<HTMLElement>('[data-ovsc-weather]')!);

  // ---------- settings ----------
  let saved: OverlayConfig = withOverrides(DEFAULT_CONFIG, params.overrides);
  let config = saved;
  const sceneHint = sceneParams.kind ?? 'starting';
  let scene: Scene | null = sceneParams.id ? withSceneOverrides(SCENE_DEFAULTS[sceneHint], sceneParams.overrides) : null;
  let skip = new Set<string>();
  let volume = -1;
  /** The settings as the scene shows them: without Poe or the widgets, or with Poe on the camera's side. */
  const onScene = (c: OverlayConfig): OverlayConfig => {
    if (!scene) return c;
    const out = { ...c, poe: { ...c.poe }, widgets: scene.showWidgets ? c.widgets : [] };
    if (!scene.showPoe) out.poe.show = false;
    if (scene.kind === 'screenshare') out.poe.side = scene.camera.side === 'left' ? 'left' : 'right';
    return out;
  };
  const apply = (next: OverlayConfig) => {
    saved = next;
    config = onScene(next);
    sceneView.show(scene);
    const shown = layout.apply(config);
    widgets.showing(shown);
    records.showing(shown);
    poe.setNap(config.nap * 60_000);
    if (config.volume !== volume) poe.setSounds(createSounds((volume = config.volume)));
    if (config.poe.side === 'left') void leftFaces().then((faces) => config.poe.side === 'left' && poe.setFaces(faces));
    else poe.setFaces(RIGHT_FACES);
    visitors.setSide(config.poe.side);
    visitors.setScale(config.poe.scale / 100);
    visitors.setEnabled(config.poe.show && config.visitors);
    void Promise.all(config.ignore.map((a) => resolveActor(a))).then((dids) => {
      skip = new Set(dids.filter((d): d is string => d !== null));
      onscreen?.setSkip(skip);
    });
  };

  const streamerDid = params.streamer ? await resolveActor(params.streamer) : null;
  if (params.streamer && !streamerDid) console.warn(`[overlay] couldn't find the streamer "${params.streamer}"`);
  if (streamerDid) {
    const wait = new Promise<undefined>((r) => window.setTimeout(r, CONFIG_WAIT_MS));
    const id = sceneParams.id;
    const [own, ownScene] = await Promise.all([Promise.race([readPublicConfig(streamerDid, fetch, params.layout), wait]), id ? Promise.race([readPublicScene(streamerDid, id, fetch, sceneHint), wait]) : undefined]);
    if (own) saved = withOverrides(own.config, params.overrides);
    if (id && ownScene) scene = withSceneOverrides(ownScene.scene, sceneParams.overrides);
  }
  apply(saved);

  // ---------- whose records ----------
  const whoDid = streamerDid ?? (params.who ? await resolveActor(params.who) : null);
  const whoName = params.streamer && !params.streamer.startsWith('did:') ? params.streamer : params.who && !params.who.startsWith('did:') ? params.who : null;
  records.setWho(whoDid, whoName, params.demo);
  if (whoDid && !whoName) void createNames()(whoDid).then((w) => w.handle && records.setWho(whoDid, w.handle.slice(1), params.demo));
  // the preview has no stream to listen to, so its chat is examples
  if (params.demo && !streamerDid) onscreen?.demo(true);

  // ---------- the weather ----------
  let latest: Reading | null = null;
  let watch: Watch | null = null;
  const check = async () => {
    const reading = await fetchReading();
    if (reading) {
      latest = reading;
      widgets.render(reading);
      sceneWeather.render(reading);
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
  onscreen?.watchBlocks(streamer);
  const onEvent = async (e: StreamEvent) => {
    if (e.kind === 'record') return records.changed(e.collection);
    if (e.kind === 'unchat' || e.kind === 'hide') return onscreen?.remove(e.did, e.rkey, e.kind === 'hide');
    if (e.kind === 'chat' && onscreen && config.widgets.some((w) => w.kind === 'chat') && !skip.has(e.did)) {
      const m = e;
      void names(e.did).then((who) => onscreen.add(m, who));
    }
    if (e.kind === 'config') return e.rkey !== params.layout ? undefined : apply(withOverrides(fromRecord(e.value), params.overrides));
    if (e.kind === 'scene') {
      if (!sceneParams.id || e.rkey !== sceneParams.id) return;
      scene = withSceneOverrides(fromSceneRecord(sceneHint, e.value), sceneParams.overrides);
      return apply(saved);
    }
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
