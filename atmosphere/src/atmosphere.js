// atmosphere.js
// The counting rules, copied from website/server/atmosphere.ts in this repo (as of
// commit 18257cd). That file is the reference: the
// website's 5-second sampler and this station must give the same numbers for the same
// messages, so a change to a rule here goes there too, and the other way round.
//
// Two additions, neither of which changes a rule:
//   eventOfMessage  eventOf's body, for a message that is already parsed (the station
//                   needs the message's time_us as well, and parses it once).
//   mergeTally      adds one tally into another, with addEvent's MAX_COLLECTIONS cap.

export const COLLECTIONS = {
  posts: 'app.bsky.feed.post',
  likes: 'app.bsky.feed.like',
  reposts: 'app.bsky.feed.repost',
  follows: 'app.bsky.graph.follow',
};

/** Collections under these count as Bluesky; everything else is "elsewhere". */
export const BLUESKY_PREFIXES = ['app.bsky.', 'chat.bsky.'];

/** Posts a second at which each condition starts; anything below "light" is calm. */
export const CONDITIONS = [
  ['stormy', 45],
  ['gusty', 30],
  ['breezy', 20],
  ['light', 12],
];

/** Diversity index (percent of new records outside Bluesky) at which each level starts. */
export const DIVERSITY_LEVELS = [
  ['extreme', 11],
  ['very high', 8],
  ['high', 6],
  ['moderate', 3],
];

/** How many apps and Bluesky collections a reading names. */
export const TOP_APPS = 10;
export const TOP_BLUESKY = 8;
/** Collections tracked per tally; past this, new names are counted in `unnamed`. */
export const MAX_COLLECTIONS = 2000;

export function conditionFor(postsPerSecond) {
  for (const [name, from] of CONDITIONS) if (postsPerSecond >= from) return name;
  return 'calm';
}

export function diversityLevel(index) {
  for (const [name, from] of DIVERSITY_LEVELS) if (index >= from) return name;
  return 'low';
}

/** A collection name worth repeating to visitors (the relay validates these, but they are still someone else's text). */
const NSID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;

export function isNsid(value) {
  return value.length <= 253 && NSID_RE.test(value);
}

export function isBluesky(nsid) {
  return BLUESKY_PREFIXES.some((p) => nsid.startsWith(p));
}

/** An NSID's app, as a domain: its first two segments, reversed ("fyi.unravel.frontpage.post" -> "unravel.fyi"). */
export function appDomain(nsid) {
  const [tld, name] = nsid.toLowerCase().split('.');
  return `${name}.${tld}`;
}

/** What a parsed Jetstream message is: { kind: 'create', collection } | { kind: 'update' | 'delete' | 'identity' | 'account' } | null. */
export function eventOfMessage(m) {
  if (m?.kind === 'identity' || m?.kind === 'account') return { kind: m.kind };
  if (m?.kind !== 'commit') return null;
  const op = m.commit?.operation;
  if (op === 'update' || op === 'delete') return { kind: op };
  if (op !== 'create' || typeof m.commit?.collection !== 'string' || !isNsid(m.commit.collection)) return null;
  return { kind: 'create', collection: m.commit.collection };
}

/** What a Jetstream message is, or null for anything unreadable. */
export function eventOf(data) {
  if (typeof data !== 'string') return null;
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  return eventOfMessage(m);
}

export function emptyTally() {
  return { creates: new Map(), unnamed: 0, updates: 0, deletes: 0, identity: 0, account: 0 };
}

export function addEvent(tally, event) {
  if (event.kind !== 'create') {
    tally[event.kind === 'update' ? 'updates' : event.kind === 'delete' ? 'deletes' : event.kind] += 1;
    return;
  }
  const n = tally.creates.get(event.collection);
  if (n !== undefined) tally.creates.set(event.collection, n + 1);
  else if (tally.creates.size < MAX_COLLECTIONS) tally.creates.set(event.collection, 1);
  else tally.unnamed += 1;
}

/** Adds `from` into `into`, as if each of its events had gone through addEvent. */
export function mergeTally(into, from) {
  for (const [nsid, count] of from.creates) {
    const n = into.creates.get(nsid);
    if (n !== undefined) into.creates.set(nsid, n + count);
    else if (into.creates.size < MAX_COLLECTIONS) into.creates.set(nsid, count);
    else into.unnamed += count;
  }
  into.unnamed += from.unnamed;
  into.updates += from.updates;
  into.deletes += from.deletes;
  into.identity += from.identity;
  into.account += from.account;
  return into;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** A tally over `seconds`, as a Reading (the shape of `Reading` in the reference). */
export function summarize(tally, seconds, measuredAt) {
  const rate = (count) => round1(count / seconds);
  let bluesky = 0;
  let elsewhere = tally.unnamed;
  const apps = new Map();
  const bsky = [];
  for (const [nsid, count] of tally.creates) {
    if (isBluesky(nsid)) {
      bluesky += count;
      bsky.push([nsid, count]);
      continue;
    }
    elsewhere += count;
    const domain = appDomain(nsid);
    const app = apps.get(domain) ?? { count: 0, collections: [] };
    app.count += count;
    app.collections.push([nsid, count]);
    apps.set(domain, app);
  }
  const total = bluesky + elsewhere;
  const index = total ? Math.round((elsewhere / total) * 10_000) / 100 : 0;
  const busiest = (a, b) => b.count - a.count;
  const perSecond = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [metric, rate(tally.creates.get(nsid) ?? 0)]));
  return {
    measuredAt,
    seconds: round1(seconds),
    perSecond,
    condition: conditionFor(perSecond.posts),
    records: { perSecond: rate(total), bluesky: rate(bluesky), elsewhere: rate(elsewhere) },
    diversity: { index, level: diversityLevel(index), apps: apps.size, collections: tally.creates.size },
    apps: [...apps]
      .map(([domain, a]) => ({
        domain,
        count: a.count,
        perSecond: rate(a.count),
        collections: a.collections
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([nsid]) => nsid),
      }))
      .sort(busiest)
      .slice(0, TOP_APPS),
    bluesky: bsky
      .map(([nsid, count]) => ({ nsid, count, perSecond: rate(count) }))
      .sort(busiest)
      .slice(0, TOP_BLUESKY),
    events: {
      creates: rate(total),
      updates: rate(tally.updates),
      deletes: rate(tally.deletes),
      identity: rate(tally.identity),
      account: rate(tally.account),
    },
  };
}

/** The split of a tally's new records: everything, Bluesky, elsewhere (which includes `unnamed`). */
export function splitOf(tally) {
  let bluesky = 0;
  let elsewhere = tally.unnamed;
  for (const [nsid, count] of tally.creates) {
    if (isBluesky(nsid)) bluesky += count;
    else elsewhere += count;
  }
  return { creates: bluesky + elsewhere, bluesky, elsewhere };
}
