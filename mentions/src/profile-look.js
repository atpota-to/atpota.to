// profile-look.js
// Poe's avatar and banner, changing with the sky over New York. The day is cut in
// four at sunrise and sunset, worked out here: dawn from half an hour before
// sunrise, day from an hour and a half after it, golden hour from an hour and a
// half before sunset, and night from half an hour after it. Each of those slots
// gets a look once, the first time the watcher sees it:
//
//   the avatar  Poe on the hill for the time of day and the season, with a face
//               that is usually the time of day's own and sometimes another
//               (sleepy most nights). Halloween and New Year's Eve nights have
//               their own. While Poe naps, the face is sleepy.
//   the banner  the same time of day and season, with the weather station's
//               weather, or dispatch day (an announcement posted in the last day),
//               a special night, or now and then an away day (the moon, the beach,
//               a cloud), as the home page's hill rolls them.
//
// The pictures are the website's library (website/scripts/poe-profile.ts), named
// in its manifest.json; nothing is drawn here. Every pick is a seeded roll on the
// slot, so a restart picks the same look, and the look is kept in profile_look_slot.
//
// Writing changes only the avatar and banner of the profile record, swapped
// against the record as read, so an edit made in between is never written over.
// When the avatar or banner isn't the one this last set, someone changed it by
// hand, and the profile is left alone for the rest of that day (New York's).
// The kill switch stops every write. PROFILE_LOOK=dry-run (the default) works out
// each change and logs it without writing anything.

import { createHash } from 'node:crypto';
import { config, killSwitchEngaged } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import { isNapping } from './nap.js';
import * as atproto from './atproto.js';
import { parseReading } from './weather-posts.js';

db.exec(`
  -- The look each slot of the day was given, picked once.
  CREATE TABLE IF NOT EXISTS profile_look_slot (
    slot_id     TEXT PRIMARY KEY,          -- the New York date and the time of day: 2026-10-22:golden
    starts_at   TEXT NOT NULL,
    time        TEXT NOT NULL,             -- dawn | day | golden | night
    season      TEXT NOT NULL,
    event       TEXT NOT NULL,             -- none | halloween | newyear | dispatch
    place       TEXT NOT NULL,             -- hill | moon | beach | cloud
    weather     TEXT NOT NULL,             -- calm | gusty | wet
    face        TEXT NOT NULL,
    avatar_file TEXT NOT NULL,             -- a path in the library's manifest
    banner_file TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- One row per change worked out: written, dry run, held or failed.
  CREATE TABLE IF NOT EXISTS profile_look_change (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id     TEXT NOT NULL,
    avatar_file TEXT NOT NULL,
    banner_file TEXT NOT NULL,
    napping     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,             -- set | dry_run | held | failed
    detail      TEXT,
    avatar_cid  TEXT,                      -- the blobs written, to tell a hand edit from our own
    banner_cid  TEXT,
    record_cid  TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS profile_look_change_status_idx ON profile_look_change(status, id);
`);

/** New York, where the potato's sky is. */
export const ZONE = 'America/New_York';
export const LATITUDE = 40.7128;
export const LONGITUDE = -74.006;
const MIN = 60_000;
const DAY = 86_400_000;
/** Where each time of day starts, from sunrise (dawn, day) or sunset (golden, night). */
export const SLOT_STARTS = { dawn: -30 * MIN, day: 90 * MIN, golden: -90 * MIN, night: 30 * MIN };
const MAX_IMAGE_BYTES = 1_000_000;   // app.bsky.actor.profile avatar and banner maxSize
const FETCH_MS = 15_000;
/** After a failed write, how long before the same look is tried again. */
const RETRY_MS = 30 * MIN;
const MANIFEST_TTL_MS = 6 * 60 * MIN;
/** The home page's hill: an away day about one visit in forty, the beach half of those on a summer day. */
export const AWAY_ODDS = 1 / 40;
export const BEACH_ODDS = 1 / 2;
export const DISPATCH_DAY_MS = DAY;

/**
 * How often each face comes up. The first is the time of day's own; the rest are
 * the sometimes. Sleepy is most nights. Never scawy on its own, only at Halloween.
 */
export const FACE_WEIGHTS = {
  dawn: { happy: 4, kawaii: 2, wink: 2, normal: 1, wow: 1 },
  day: { normal: 3, kawaii: 3, happy: 2, wink: 1, wow: 1 },
  golden: { wink: 3, happy: 3, kawaii: 2, normal: 1, wow: 1 },
  night: { sleepy: 7, wow: 1, kawaii: 1, happy: 1 },
  dispatch: { happy: 3, wink: 3, wow: 2, kawaii: 2 },
  halloween: { scawy: 3, sleepy: 3, wow: 2, kawaii: 2 },
  newyear: { wow: 3, happy: 3, wink: 2, sleepy: 2 },
};
const MONTH_SEASONS = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

// --- the sky ------------------------------------------------------------------

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Sunrise and sunset (ms since the epoch) on a calendar date, at a place, by the
 * sunrise equation. Good to a minute or two, which is all a sky needs. Null for a
 * day the sun doesn't rise or set (not New York's).
 */
export function sunTimes(year, month, day, lat = LATITUDE, lon = LONGITUDE) {
  const jd = Date.UTC(year, month - 1, day, 12) / DAY + 2440587.5;
  const n = Math.round(jd - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(rad(m)) + 0.02 * Math.sin(rad(2 * m)) + 0.0003 * Math.sin(rad(3 * m));
  const lambda = (m + c + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(rad(m)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDec) / (Math.cos(rad(lat)) * cosDec);
  if (cosW < -1 || cosW > 1) return null;
  const w = deg(Math.acos(cosW));
  const toMs = (j) => Math.round((j - 2440587.5) * DAY);
  return { sunrise: toMs(transit - w / 360), sunset: toMs(transit + w / 360) };
}

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The New York calendar date of an instant, as YYYY-MM-DD. */
export function zoneDate(ms) {
  return dateFormat.format(new Date(ms));
}

const parseDate = (s) => s.split('-').map(Number);

/** The four slots of a New York date: [{ id, time, date, startsAt }], in order. */
export function slotsOn(date) {
  const [y, m, d] = parseDate(date);
  const sun = sunTimes(y, m, d);
  if (!sun) return [];
  return [
    ['dawn', sun.sunrise], ['day', sun.sunrise], ['golden', sun.sunset], ['night', sun.sunset],
  ].map(([time, base]) => ({ id: `${date}:${time}`, time, date, startsAt: base + SLOT_STARTS[time] }));
}

/** The slot an instant falls in. Night runs on past midnight to the next dawn, under the evening's date. */
export function slotAt(ms) {
  const today = zoneDate(ms);
  const dates = [zoneDate(ms - DAY), today, zoneDate(ms + DAY)];
  const all = dates.flatMap(slotsOn).filter((s) => s.startsAt <= ms);
  return all[all.length - 1];
}

export function seasonOf(date) {
  return MONTH_SEASONS[parseDate(date)[1] - 1];
}

/** Halloween week's nights and New Year's Eve, as the home page has them. */
export function eventFor(slot, dispatchDay = false) {
  const [, month, day] = parseDate(slot.date);
  if (slot.time === 'night' && month === 10 && day >= 24) return 'halloween';
  if (slot.time === 'night' && month === 12 && day === 31) return 'newyear';
  return dispatchDay ? 'dispatch' : 'none';
}

/** The station's condition as the hill shows it: gusty, stormy is wet (rain, or snow in winter), the rest calm. */
export function weatherFor(condition) {
  if (condition === 'gusty') return 'gusty';
  if (condition === 'stormy') return 'wet';
  return 'calm';
}

// --- the picks ------------------------------------------------------------------

/** A roll in [0, 1) that is the same every time for this slot and purpose. */
export function roll(slotId, salt) {
  return createHash('sha256').update(`${slotId}:${salt}`).digest().readUInt32BE(0) / 2 ** 32;
}

export function pickWeighted(weights, r) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let at = r * total;
  for (const [key, w] of entries) {
    if ((at -= w) < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * The look for a slot: { time, season, event, place, weather, face, avatarFile, bannerFile }.
 * `has(file)` says whether the library has a picture; anything it lacks falls back
 * to the plain hill for the time of day and season.
 */
export function planLook(slot, { condition = null, dispatchDay = false, has = () => true } = {}) {
  const season = seasonOf(slot.date);
  const event = eventFor(slot, dispatchDay);
  const weather = weatherFor(condition);
  const { time, id } = slot;

  let place = 'hill';
  if (event === 'none' && roll(id, 'away') < AWAY_ODDS) {
    if (time === 'night') place = 'moon';
    else if (time === 'day' && season === 'summer' && roll(id, 'beach') < BEACH_ODDS) place = 'beach';
    else place = 'cloud';
  }

  const faces = event === 'halloween' || event === 'newyear' ? FACE_WEIGHTS[event]
    : event === 'dispatch' && time !== 'night' ? FACE_WEIGHTS.dispatch
      : FACE_WEIGHTS[time];
  const face = pickWeighted(faces, roll(id, 'face'));

  const take = (a, b) => (roll(id, 'take') < 0.5 ? a : b);
  let bannerFile =
    event === 'halloween' ? `banners/halloween-${take('a', 'c')}.jpg`
      : event === 'newyear' ? `banners/newyear-${take('a', 'b')}.jpg`
        : event === 'dispatch' ? `banners/${time}-${season}-dispatch.jpg`
          : place === 'moon' ? 'banners/moon.jpg'
            : place === 'beach' ? `banners/beach-${take('a', 'b')}.jpg`
              : place === 'cloud' ? `banners/cloud-${time}.jpg`
                : `banners/${time}-${season}-${weather}.jpg`;
  if (!has(bannerFile)) {
    bannerFile = `banners/${time}-${season}-calm.jpg`;
    place = 'hill';
  }

  let avatarFile = avatarFor({ time, season, event }, face);
  if (!has(avatarFile)) avatarFile = avatarFor({ time, season, event: 'none' }, time === 'night' ? 'sleepy' : 'normal');
  return { time, season, event, place, weather, face, avatarFile, bannerFile };
}

export function avatarFor({ time, season, event }, face) {
  return event === 'halloween' || event === 'newyear' ? `avatars/${event}-${face}.jpg` : `avatars/${time}-${season}-${face}.jpg`;
}

/** The avatar to show now: the slot's, or its sleepy face while Poe naps. */
export function effectiveAvatar(plan, napping, has = () => true) {
  if (!napping) return plan.avatar_file;
  const sleepy = avatarFor(plan, 'sleepy');
  return has(sleepy) ? sleepy : plan.avatar_file;
}

// --- reading what it needs ----------------------------------------------------------

let manifestCache = null;   // { at, files: Set }

/** The library's files, from its manifest, cached for a few hours. */
async function libraryFiles(fetcher, nowMs) {
  if (manifestCache && nowMs - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.files;
  const res = await fetcher(`${config.profileLook.base}/manifest.json`, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => undefined);
    throw new Error(`the manifest answered ${res.status}`);
  }
  const body = JSON.parse(await res.text());
  const files = new Set([...(body?.avatars ?? []), ...(body?.banners ?? [])]
    .map((e) => e?.file).filter((f) => typeof f === 'string' && /^(avatars|banners)\/[a-z0-9-]+\.jpg$/.test(f)));
  if (!files.size) throw new Error('the manifest lists no pictures');
  manifestCache = { at: nowMs, files };
  return files;
}

/** The weather station's condition right now, or null. */
async function readCondition(fetcher) {
  try {
    const res = await fetcher(`${config.weather.apiBase}/atmosphere`, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => undefined);
      return null;
    }
    return parseReading(JSON.parse(await res.text()))?.condition ?? null;
  } catch {
    return null;
  }
}

/** Whether a dispatch announcement went out from Poe's account in the last day. */
function isDispatchDay(nowMs) {
  try {
    const row = db.prepare('SELECT MAX(posted_at) AS at FROM dispatch_document WHERE posted_at IS NOT NULL').get();
    const at = Date.parse(row?.at ?? '');
    return Number.isFinite(at) && nowMs >= at && nowMs - at < DISPATCH_DAY_MS;
  } catch {
    return false;   // no dispatch table on this database
  }
}

/** A picture from the library, checked: a JPEG under Bluesky's limit, and no redirects. */
async function fetchPicture(file, fetcher) {
  const res = await fetcher(`${config.profileLook.base}/${file}`, { redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (res.status !== 200 || type !== 'image/jpeg') {
    await res.body?.cancel?.().catch(() => undefined);
    throw new Error(`${file} answered ${res.status} ${type || 'untyped'}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`${file} is ${bytes.length} bytes`);
  return { bytes, mimeType: 'image/jpeg' };
}

export const defaultDeps = {
  fetcher: (...args) => fetch(...args),
  fetchPicture,
  getProfile: () => atproto.getOwnProfile(),
  putProfile: (record, swap) => atproto.putOwnProfile(record, swap),
  uploadBlob: (bytes, mimeType) => atproto.uploadBlob(bytes, mimeType),
  isNapping,
  killSwitchEngaged,
};

// --- state ----------------------------------------------------------------------

const lastChange = (statuses) => db.prepare(
  `SELECT * FROM profile_look_change WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`,
).get(...statuses);

function record(nowMs, slotId, avatarFile, bannerFile, napping, status, extra = {}) {
  db.prepare(`INSERT INTO profile_look_change (slot_id, avatar_file, banner_file, napping, status, detail, avatar_cid, banner_cid, record_cid, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slotId, avatarFile, bannerFile, napping ? 1 : 0, status, extra.detail ?? null,
      extra.avatarCid ?? null, extra.bannerCid ?? null, extra.recordCid ?? null, new Date(nowMs).toISOString());
}

const blobCid = (blob) => (typeof blob?.ref?.$link === 'string' ? blob.ref.$link : null);

/** The slot's look, picked and kept the first time it is asked for. */
async function slotPlan(slot, nowMs, deps) {
  const kept = db.prepare('SELECT * FROM profile_look_slot WHERE slot_id = ?').get(slot.id);
  if (kept) return kept;
  const files = await libraryFiles(deps.fetcher, nowMs);
  const look = planLook(slot, {
    condition: await readCondition(deps.fetcher),
    dispatchDay: isDispatchDay(nowMs),
    has: (f) => files.has(f),
  });
  db.prepare(`INSERT OR IGNORE INTO profile_look_slot
    (slot_id, starts_at, time, season, event, place, weather, face, avatar_file, banner_file, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slot.id, new Date(slot.startsAt).toISOString(), look.time, look.season, look.event, look.place,
      look.weather, look.face, look.avatarFile, look.bannerFile, nowIso());
  logger.info('profile look picked', { slot: slot.id, ...look });
  return db.prepare('SELECT * FROM profile_look_slot WHERE slot_id = ?').get(slot.id);
}

/**
 * One look at the sky: pick the slot's look if it has none, and change the profile
 * when what it should show isn't what it last showed. Returns what it did.
 */
export async function profileLookTick(nowMs = Date.now(), deps = defaultDeps) {
  const mode = config.profileLook.mode;
  if (mode === 'off') return { did: 'off' };
  const dryRun = mode !== 'on' || config.stage < 4;
  if (!dryRun && deps.killSwitchEngaged()) return { did: 'kill_switch' };

  const slot = slotAt(nowMs);
  if (!slot) return { did: 'no_slot' };
  const plan = await slotPlan(slot, nowMs, deps);
  const files = manifestCache?.files;
  const napping = deps.isNapping();
  const avatarFile = effectiveAvatar(plan, napping, files ? (f) => files.has(f) : undefined);
  const bannerFile = plan.banner_file;

  if (dryRun) {
    const last = lastChange(['dry_run']);
    if (last?.avatar_file === avatarFile && last?.banner_file === bannerFile) return { did: 'unchanged' };
    record(nowMs, slot.id, avatarFile, bannerFile, napping, 'dry_run');
    logger.info('profile look (dry run: nothing written)', {
      slot: slot.id, avatar: `${config.profileLook.base}/${avatarFile}`, banner: `${config.profileLook.base}/${bannerFile}`, napping,
    });
    return { did: 'dry_run', avatarFile, bannerFile };
  }

  const set = lastChange(['set']);
  if (set?.avatar_file === avatarFile && set?.banner_file === bannerFile) return { did: 'unchanged' };

  // Hands off for the rest of the day after a hand edit, said once. The day after,
  // the hand edit is written over like any other look.
  const held = lastChange(['held']);
  const heldSinceSet = held && (!set || held.id > set.id);
  if (heldSinceSet && zoneDate(Date.parse(held.created_at)) === zoneDate(nowMs)) return { did: 'hands_off' };
  const failed = lastChange(['failed']);
  if (failed && failed.avatar_file === avatarFile && failed.banner_file === bannerFile &&
      (!set || failed.id > set.id) && nowMs - Date.parse(failed.created_at) < RETRY_MS) return { did: 'waiting_to_retry' };

  try {
    const profile = await deps.getProfile();
    if (!profile?.cid || !profile.value) {
      record(nowMs, slot.id, avatarFile, bannerFile, napping, 'held', { detail: 'Poe has no profile record' });
      return { did: 'held' };
    }
    if (set && !heldSinceSet && (blobCid(profile.value.avatar) !== set.avatar_cid || blobCid(profile.value.banner) !== set.banner_cid)) {
      record(nowMs, slot.id, avatarFile, bannerFile, napping, 'held', { detail: 'the avatar or banner was changed by hand; leaving it until tomorrow' });
      logger.warn('profile look: the avatar or banner was changed by hand; leaving the profile alone until tomorrow', { slot: slot.id });
      return { did: 'held' };
    }
    const [avatar, banner] = await Promise.all([deps.fetchPicture(avatarFile, deps.fetcher), deps.fetchPicture(bannerFile, deps.fetcher)]);
    const avatarBlob = await deps.uploadBlob(avatar.bytes, avatar.mimeType);
    const bannerBlob = await deps.uploadBlob(banner.bytes, banner.mimeType);
    // Everything else in the record (name, bio, pinned post, labels) stays as read.
    const next = { ...profile.value, $type: atproto.PROFILE_COLLECTION, avatar: avatarBlob, banner: bannerBlob };
    const res = await deps.putProfile(next, profile.cid);
    record(nowMs, slot.id, avatarFile, bannerFile, napping, 'set', {
      avatarCid: blobCid(avatarBlob), bannerCid: blobCid(bannerBlob), recordCid: res?.cid ?? null,
    });
    logger.info('profile look set', { slot: slot.id, avatar: avatarFile, banner: bannerFile, napping });
    return { did: 'set', avatarFile, bannerFile };
  } catch (err) {
    record(nowMs, slot.id, avatarFile, bannerFile, napping, 'failed', { detail: err.message });
    logger.error('profile look failed', { slot: slot.id, error: err.message });
    return { did: 'failed', error: err.message };
  }
}

export function startProfileLook() {
  const p = config.profileLook;
  if (p.mode === 'off') return null;
  if (p.mode === 'on' && config.stage < 4) logger.warn('PROFILE_LOOK=on below stage 4: every change is a dry run');
  logger.info('profile look starting', { mode: p.mode, pollMs: p.pollMs, base: p.base });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await profileLookTick();
      logger.debug('profile look tick', result);
    } catch (err) {
      logger.error('profile look tick failed', { error: err.message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 45_000);
  first.unref?.();
  const timer = setInterval(tick, p.pollMs);
  timer.unref?.();
  return timer;
}

/** For tests: forget the cached manifest. */
export function resetProfileLookCache() {
  manifestCache = null;
}
