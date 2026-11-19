import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import {
  FACE_WEIGHTS, effectiveAvatar, eventFor, pickWeighted, planLook, profileLookTick, resetProfileLookCache,
  roll, seasonOf, slotAt, slotsOn, sunTimes, weatherFor, zoneDate,
} from '../src/profile-look.js';

const H = 3_600_000;
const near = (actual, expected, toleranceMin, label) =>
  assert.ok(Math.abs(actual - expected) <= toleranceMin * 60_000,
    `${label}: ${new Date(actual).toISOString()} is not within ${toleranceMin} min of ${new Date(expected).toISOString()}`);

// --- the sky ------------------------------------------------------------------

test('sunrise and sunset in New York land within a few minutes of the almanac', () => {
  // 2026-10-22: sunrise 7:14am, sunset 6:04pm EDT. 2026-06-21: 5:25am and 8:31pm EDT.
  // 2026-12-21: 7:17am and 4:32pm EST.
  const oct = sunTimes(2026, 10, 22);
  near(oct.sunrise, Date.parse('2026-10-22T11:14:00Z'), 4, 'october sunrise');
  near(oct.sunset, Date.parse('2026-10-22T22:04:00Z'), 4, 'october sunset');
  const jun = sunTimes(2026, 6, 21);
  near(jun.sunrise, Date.parse('2026-06-21T09:25:00Z'), 4, 'june sunrise');
  near(jun.sunset, Date.parse('2026-06-22T00:31:00Z'), 4, 'june sunset');
  const dec = sunTimes(2026, 12, 21);
  near(dec.sunrise, Date.parse('2026-12-21T12:17:00Z'), 4, 'december sunrise');
  near(dec.sunset, Date.parse('2026-12-21T21:32:00Z'), 4, 'december sunset');
  assert.equal(sunTimes(2026, 6, 21, 80, 0), null, 'the midnight sun never sets');
});

test('a day has four slots in order, and night runs past midnight under the evening\'s date', () => {
  const slots = slotsOn('2026-10-22');
  assert.deepEqual(slots.map((s) => s.time), ['dawn', 'day', 'golden', 'night']);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i].startsAt > slots[i - 1].startsAt);
  assert.equal(slotAt(Date.parse('2026-10-22T10:55:00Z')).id, '2026-10-22:dawn');       // 6:55am
  assert.equal(slotAt(Date.parse('2026-10-22T16:00:00Z')).id, '2026-10-22:day');        // noon
  assert.equal(slotAt(Date.parse('2026-10-22T21:00:00Z')).id, '2026-10-22:golden');     // 5pm
  assert.equal(slotAt(Date.parse('2026-10-23T03:00:00Z')).id, '2026-10-22:night');      // 11pm
  assert.equal(slotAt(Date.parse('2026-10-23T08:00:00Z')).id, '2026-10-22:night');      // 4am the next day
  assert.equal(zoneDate(Date.parse('2026-10-23T03:00:00Z')), '2026-10-22');
});

test('seasons, special nights and weather follow the home page\'s hill', () => {
  assert.equal(seasonOf('2026-10-22'), 'autumn');
  assert.equal(seasonOf('2026-12-01'), 'winter');
  assert.equal(seasonOf('2026-03-01'), 'spring');
  const at = (date, time) => ({ id: `${date}:${time}`, date, time });
  assert.equal(eventFor(at('2026-10-24', 'night')), 'halloween');
  assert.equal(eventFor(at('2026-10-31', 'night')), 'halloween');
  assert.equal(eventFor(at('2026-10-23', 'night')), 'none');
  assert.equal(eventFor(at('2026-10-31', 'day')), 'none');
  assert.equal(eventFor(at('2026-12-31', 'night')), 'newyear');
  assert.equal(eventFor(at('2026-12-31', 'golden')), 'none');
  assert.equal(eventFor(at('2026-10-22', 'day'), true), 'dispatch');
  assert.equal(eventFor(at('2026-10-25', 'night'), true), 'halloween', 'a special night beats dispatch day');
  assert.equal(weatherFor('gusty'), 'gusty');
  assert.equal(weatherFor('stormy'), 'wet');
  assert.equal(weatherFor('breezy'), 'calm');
  assert.equal(weatherFor(null), 'calm');
});

// --- the picks ------------------------------------------------------------------

const slot = (date, time) => ({ id: `${date}:${time}`, date, time, startsAt: 0 });

test('a slot always gets the same look, and the files are the library\'s names', () => {
  const s = slot('2026-10-22', 'golden');
  assert.deepEqual(planLook(s, { condition: 'gusty' }), planLook(s, { condition: 'gusty' }));
  const look = planLook(slot('2026-05-02', 'day'), { condition: 'calm' });
  assert.match(look.avatarFile, /^avatars\/day-spring-[a-z]+\.jpg$/);
  assert.ok(['banners/day-spring-calm.jpg', 'banners/cloud-day.jpg'].includes(look.bannerFile), look.bannerFile);
  assert.equal(roll('x', 'face'), roll('x', 'face'));
  assert.notEqual(roll('x', 'face'), roll('y', 'face'));
});

test('sleepy is most nights, never scawy outside Halloween, and the day has its own faces', () => {
  const faces = { night: {}, day: {}, halloween: {} };
  for (let i = 0; i < 2000; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    for (const time of ['night', 'day']) {
      const look = planLook(slot(date, time));
      const key = look.event === 'halloween' ? 'halloween' : time;
      faces[key][look.face] = (faces[key][look.face] ?? 0) + 1;
    }
  }
  const share = (bucket, face) => (faces[bucket][face] ?? 0) / Object.values(faces[bucket]).reduce((a, b) => a + b, 0);
  assert.ok(share('night', 'sleepy') > 0.6 && share('night', 'sleepy') < 0.8, `sleepy on ${share('night', 'sleepy')} of nights`);
  assert.ok(share('night', 'wow') > 0, 'sometimes a night with another face');
  assert.equal(faces.day.sleepy, undefined);
  assert.equal(faces.day.scawy ?? faces.night.scawy, undefined);
  assert.ok(faces.halloween.scawy > 0);
  assert.equal(pickWeighted({ a: 1, b: 1 }, 0), 'a');
  assert.equal(pickWeighted({ a: 1, b: 1 }, 0.99), 'b');
  assert.deepEqual(Object.keys(FACE_WEIGHTS.night)[0], 'sleepy');
});

test('special nights, dispatch day and away days pick their own banners', () => {
  const halloween = planLook(slot('2026-10-27', 'night'));
  assert.match(halloween.bannerFile, /^banners\/halloween-[ac]\.jpg$/);
  assert.match(halloween.avatarFile, /^avatars\/halloween-(scawy|sleepy|wow|kawaii)\.jpg$/);
  const ny = planLook(slot('2026-12-31', 'night'));
  assert.match(ny.bannerFile, /^banners\/newyear-[ab]\.jpg$/);
  assert.match(ny.avatarFile, /^avatars\/newyear-/);
  const dispatch = planLook(slot('2026-10-22', 'day'), { dispatchDay: true });
  assert.equal(dispatch.bannerFile, 'banners/day-autumn-dispatch.jpg');
  assert.match(dispatch.avatarFile, /^avatars\/day-autumn-(happy|wink|wow|kawaii)\.jpg$/);
  const stormy = planLook(slot('2026-01-10', 'day'), { condition: 'stormy' });
  assert.equal(stormy.bannerFile, stormy.place === 'hill' ? 'banners/day-winter-wet.jpg' : 'banners/cloud-day.jpg');

  // About one in forty is an away day: the moon at night, a cloud or the summer beach by day.
  const places = {};
  for (let i = 0; i < 4000; i++) {
    const date = new Date(Date.UTC(2026, 5, 1) + (i % 90) * 86_400_000).toISOString().slice(0, 10);
    const look = planLook({ id: `${date}:${i}`, date, time: i % 2 ? 'night' : 'day', startsAt: 0 });
    places[look.place] = (places[look.place] ?? 0) + 1;
  }
  assert.ok(places.moon > 20 && places.moon < 90, `moon ${places.moon}`);
  assert.ok(places.beach > 5 && places.cloud > 5, JSON.stringify(places));
});

test('a picture the library lacks falls back to the plain hill', () => {
  const has = (f) => !f.includes('gusty') && !/-wow\.jpg$/.test(f);
  for (let i = 0; i < 200; i++) {
    const look = planLook({ ...slot('2026-04-0' + (1 + (i % 9)), 'day'), id: `fallback:${i}` }, { condition: 'gusty', has });
    assert.ok(has(look.avatarFile), look.avatarFile);
    assert.ok(has(look.bannerFile), look.bannerFile);
  }
});

test('a nap gives the slot\'s avatar the sleepy face', () => {
  const plan = { time: 'day', season: 'autumn', event: 'none', avatar_file: 'avatars/day-autumn-wink.jpg' };
  assert.equal(effectiveAvatar(plan, false), 'avatars/day-autumn-wink.jpg');
  assert.equal(effectiveAvatar(plan, true), 'avatars/day-autumn-sleepy.jpg');
  assert.equal(effectiveAvatar({ ...plan, event: 'halloween' }, true), 'avatars/halloween-sleepy.jpg');
  assert.equal(effectiveAvatar(plan, true, () => false), 'avatars/day-autumn-wink.jpg');
});

// --- the watcher ------------------------------------------------------------------

const NOW = Date.parse('2026-10-22T16:00:00Z');   // noon in New York, a day slot
const MANIFEST = {
  version: 1,
  avatars: ['day', 'golden', 'night', 'dawn'].flatMap((t) => ['normal', 'kawaii', 'happy', 'wink', 'wow', 'sleepy']
    .map((f) => ({ file: `avatars/${t}-autumn-${f}.jpg` }))),
  banners: ['day', 'golden', 'night', 'dawn'].flatMap((t) => ['calm', 'gusty', 'wet', 'dispatch']
    .map((w) => ({ file: `banners/${t}-autumn-${w}.jpg` }))).concat([{ file: 'banners/cloud-day.jpg' }, { file: 'banners/moon.jpg' }]),
};

function harness({ condition = 'gusty', profile } = {}) {
  const calls = { put: [], uploads: 0, fetched: [] };
  const state = {
    napping: false,
    kill: false,
    putFails: false,
    profile: profile ?? {
      cid: 'bafyprofile1',
      value: { $type: 'app.bsky.actor.profile', displayName: 'poe', description: 'a potato', pinnedPost: { uri: 'at://x', cid: 'y' } },
    },
  };
  let blobs = 0;
  const deps = {
    fetcher: async (url) => {
      calls.fetched.push(url);
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
      if (url.endsWith('/atmosphere')) {
        return new Response(JSON.stringify({ measuredAt: '2026-10-22T15:59:00Z', condition, records: { perSecond: 300 } }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    },
    fetchPicture: async (file) => ({ bytes: Buffer.from(file), mimeType: 'image/jpeg' }),
    getProfile: async () => structuredClone(state.profile),
    uploadBlob: async () => {
      calls.uploads++;
      return { $type: 'blob', ref: { $link: `bafyblob${++blobs}` }, mimeType: 'image/jpeg', size: 10 };
    },
    putProfile: async (record, swap) => {
      if (state.putFails) throw new Error('putRecord (profile) failed: 500');
      assert.equal(swap, state.profile.cid, 'the write is swapped against the record read');
      calls.put.push(record);
      state.profile = { cid: `bafyprofile${calls.put.length + 1}`, value: record };
      return { cid: state.profile.cid };
    },
    isNapping: () => state.napping,
    killSwitchEngaged: () => state.kill,
  };
  return { deps, calls, state };
}

function fresh(mode) {
  db.exec('DELETE FROM profile_look_change; DELETE FROM profile_look_slot;');
  resetProfileLookCache();
  config.profileLook.mode = mode;
}

test('a dry run works out the look and logs it once, writing nothing', async () => {
  fresh('dry-run');
  const { deps, calls } = harness();
  const first = await profileLookTick(NOW, deps);
  assert.equal(first.did, 'dry_run');
  assert.match(first.avatarFile, /^avatars\/day-autumn-/);
  assert.ok(['banners/day-autumn-gusty.jpg', 'banners/cloud-day.jpg'].includes(first.bannerFile), first.bannerFile);
  assert.equal((await profileLookTick(NOW + 5 * 60_000, deps)).did, 'unchanged');
  assert.equal(calls.put.length, 0);
  assert.equal(calls.uploads, 0);
  const plan = db.prepare('SELECT * FROM profile_look_slot').get();
  assert.equal(plan.slot_id, '2026-10-22:day');
  assert.equal(plan.weather, 'gusty');
});

test('on, it changes only the avatar and banner, once per look', async () => {
  fresh('on');
  const { deps, calls, state } = harness();
  const res = await profileLookTick(NOW, deps);
  assert.equal(res.did, 'set');
  assert.equal(calls.put.length, 1);
  const written = calls.put[0];
  assert.equal(written.displayName, 'poe');
  assert.equal(written.description, 'a potato');
  assert.deepEqual(written.pinnedPost, { uri: 'at://x', cid: 'y' });
  assert.equal(written.avatar.ref.$link, 'bafyblob1');
  assert.equal(written.banner.ref.$link, 'bafyblob2');
  assert.equal((await profileLookTick(NOW + 5 * 60_000, deps)).did, 'unchanged');

  // A nap gives the sleepy face right away; waking gives the slot's face back.
  state.napping = true;
  const napped = await profileLookTick(NOW + 10 * 60_000, deps);
  assert.equal(napped.avatarFile, 'avatars/day-autumn-sleepy.jpg');
  state.napping = false;
  const woke = await profileLookTick(NOW + 15 * 60_000, deps);
  assert.equal(woke.avatarFile, res.avatarFile);

  // Golden hour is a new slot and a new look.
  const golden = await profileLookTick(Date.parse('2026-10-22T21:00:00Z'), deps);
  assert.equal(golden.did, 'set');
  assert.match(golden.avatarFile, /^avatars\/golden-autumn-/);
});

test('a hand edit leaves the profile alone for the rest of the day, then the sky takes over again', async () => {
  fresh('on');
  const { deps, calls, state } = harness();
  await profileLookTick(NOW, deps);
  state.profile.value.avatar = { $type: 'blob', ref: { $link: 'bafyHANDMADE' }, mimeType: 'image/png', size: 5 };
  state.profile.cid = 'bafyhand';

  const golden = Date.parse('2026-10-22T21:00:00Z');
  assert.equal((await profileLookTick(golden, deps)).did, 'held');
  assert.equal((await profileLookTick(golden + H, deps)).did, 'hands_off');
  assert.equal(calls.put.length, 1);

  const tomorrow = Date.parse('2026-10-23T16:00:00Z');
  assert.equal((await profileLookTick(tomorrow, deps)).did, 'set');
  assert.equal(calls.put.length, 2);
});

test('the kill switch stops a write; a failed write waits before trying again', async () => {
  fresh('on');
  const { deps, calls, state } = harness();
  state.kill = true;
  assert.equal((await profileLookTick(NOW, deps)).did, 'kill_switch');
  state.kill = false;
  state.putFails = true;
  assert.equal((await profileLookTick(NOW, deps)).did, 'failed');
  assert.equal((await profileLookTick(NOW + 10 * 60_000, deps)).did, 'waiting_to_retry');
  state.putFails = false;
  assert.equal((await profileLookTick(NOW + 31 * 60_000, deps)).did, 'set');
  assert.equal(calls.put.length, 1);
});

test('PROFILE_LOOK=off does nothing at all', async () => {
  fresh('off');
  const { deps, calls } = harness();
  assert.equal((await profileLookTick(NOW, deps)).did, 'off');
  assert.equal(calls.fetched.length, 0);
});
