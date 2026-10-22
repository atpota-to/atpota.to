/**
 * /api/atmosphere: the "atmospheric conditions" on the home page and the full weather
 * report at /weather. It listens to the whole firehose through Jetstream for a few
 * seconds and answers with rates per second: Bluesky's posts, likes, reposts and follows,
 * how many new records came from outside Bluesky and which apps wrote them, how much of
 * the atmosphere isn't Bluesky by who's writing (the diversity index, diversityOf), and
 * how many edits, deletions, identity and account events went by.
 *
 * The reading comes from the weather station (atmosphere/SPEC.md), an always-on consumer on
 * the droplet that keeps a rolling 60 seconds: GET STATION_URL with the shared secret in
 * ATMOSPHERE_STATION_SECRET. Its answer is checked field by field (fromStation), cached at
 * the CDN for 5 seconds, so the station sees about a dozen requests a minute however many
 * people are watching.
 *
 * Without a secret, or while the station is down, this function samples Jetstream itself
 * for a few seconds instead: the whole firehose is over 250 KB a second, which no visitor
 * should have to download for a weather report. One sample serves everyone for a minute
 * (CDN cache), and a function instance reuses its last sample for SAMPLE_TTL_MS.
 *
 *   GET /api/atmosphere  ->  Reading (below), with source "station" or "sample"
 *
 * The station's reading also says how many different accounts (DIDs) wrote anything in
 * its 60 seconds (`accounts`, counted with HyperLogLog sketches; see atmosphere/src/
 * accounts.js). The sample doesn't: a few seconds of accounts don't add up to a minute's.
 * It does count them exactly, while it listens, for its diversity index (nothing is
 * kept), which therefore reads a little low: a few seconds hear fewer apps than a minute.
 *
 * The station's reading also carries its last census of PDS hosts (`hosts`, from the
 * relay's list of them; see atmosphere/src/hosts.js): how many are active, Bluesky's and
 * independent, how many wrote lately, the accounts each side holds, and the hosting
 * diversity (share × √spread, like the diversity index, but by accounts hosted). The
 * sample has none.
 *
 * If neither can be read, the answer is 503 and the tile says so.
 */

import { TtlCache } from './blog/atproto.js';

/** Bluesky's us-east hosts share one address, so the fallback is in us-west: the same firehose, somewhere else. */
export const JETSTREAMS = ['wss://jetstream2.us-east.bsky.network/subscribe', 'wss://jetstream1.us-west.bsky.network/subscribe'] as const;

export const COLLECTIONS = {
  posts: 'app.bsky.feed.post',
  likes: 'app.bsky.feed.like',
  reposts: 'app.bsky.feed.repost',
  follows: 'app.bsky.graph.follow',
} as const;

export type Metric = keyof typeof COLLECTIONS;

/** Collections under these count as Bluesky; everything else is "elsewhere". */
export const BLUESKY_PREFIXES = ['app.bsky.', 'chat.bsky.'] as const;

/** How long to count for, once connected. */
export const SAMPLE_MS = 5000;
export const CONNECT_TIMEOUT_MS = 4000;
export const SAMPLE_TTL_MS = 30_000;
export const CACHE_OK = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';

export const STATION_URL = 'https://hook.atpota.to/weather/v1/now';
export const STATION_TIMEOUT_MS = 2500;
/** A function instance reuses a station reading this long. */
export const STATION_TTL_MS = 3000;
/** After the station fails, sample instead for this long before trying it again. */
export const STATION_BACKOFF_MS = 30_000;
export const CACHE_LIVE = 'public, max-age=0, s-maxage=5, stale-while-revalidate=30';
/** At most this many seconds in a station reading's series. */
export const MAX_SERIES = 120;

/**
 * New records a second (every app, not just Bluesky) at which each condition starts;
 * anything below "light" is calm. A usual afternoon is about 450, so "breezy".
 * The weather station (atmosphere/src/atmosphere.js) uses the same rule, and so does
 * Poe's read_weather (bot/agent/lib/weather.ts), for the words it puts on whole weeks.
 */
export const CONDITIONS = [
  ['stormy', 600],
  ['gusty', 500],
  ['breezy', 400],
  ['light', 300],
] as const;

export type Condition = 'calm' | (typeof CONDITIONS)[number][0];

/**
 * The diversity index (diversityOf) at which each level starts, like the UV index. A
 * usual minute in October 2026 was about 2: half a percent of active accounts wrote
 * outside Bluesky, spread across about 15 apps' worth.
 */
export const DIVERSITY_LEVELS = [
  ['extreme', 11],
  ['very high', 8],
  ['high', 6],
  ['moderate', 3],
] as const;

export type DiversityLevel = 'low' | (typeof DIVERSITY_LEVELS)[number][0];

/**
 * The hosting diversity (the same sum, by where accounts live rather than who's writing)
 * at which each level starts, on its own scale: it grows with both the share of accounts
 * living off Bluesky's hosts and how many hosts they're spread across, so it can run to
 * the hundreds (10% of accounts across 100 hosts' worth would be 100). It was about 7.5
 * in October 2026. Below the first, 'early days'.
 */
export const HOSTING_LEVELS = [
  ['flourishing', 200],
  ['well spread', 75],
  ['spreading', 25],
  ['taking root', 10],
] as const;

export type HostingLevel = 'early days' | (typeof HOSTING_LEVELS)[number][0];

export function hostingLevel(index: number): HostingLevel {
  for (const [name, from] of HOSTING_LEVELS) if (index >= from) return name;
  return 'early days';
}

/** How many apps and Bluesky collections the reading names. */
export const TOP_APPS = 10;
export const TOP_BLUESKY = 8;
/** Collections tracked per sample; past this, new names are not counted on their own. */
export const MAX_COLLECTIONS = 2000;

export interface Rate {
  /** Records a second, one decimal. */
  perSecond: number;
  /** Records counted in the sample. */
  count: number;
}

export interface App extends Rate {
  /** The app's namespace as a domain: "sh.tangled.*" is "tangled.sh". */
  domain: string;
  /** Its busiest collections, busiest first (at most three). */
  collections: string[];
}

export interface AccountApp {
  domain: string;
  /** Different accounts that wrote to it. */
  accounts: number;
  collections: string[];
}

export interface Accounts {
  /** Different accounts that wrote anything. */
  active: number;
  bluesky: number;
  elsewhere: number;
  /** The share of active accounts that wrote outside Bluesky, percent, two decimals. */
  index: number;
  /** The apps outside Bluesky with the most accounts. */
  apps: AccountApp[];
}

export interface Hosts {
  /** When the station last counted them (it does every 10 minutes). */
  measuredAt: string;
  /** Hosts the relay lists, in any state. */
  listed: number;
  /** Hosts the relay calls active: Bluesky's own (*.host.bsky.network) and everyone else's. */
  active: number;
  bluesky: number;
  independent: number;
  /** Active hosts that relayed anything in the last `minutes`, or null until the station has counted twice. */
  writing: { bluesky: number; independent: number; minutes: number } | null;
  /** Accounts on active hosts. */
  accounts: { bluesky: number; independent: number };
  /** share: percent of accounts on independent hosts; spread: how many hosts they're spread across, as an effective number; index: share × √spread. */
  diversity: { index: number; share: number; spread: number };
  /** The independent hosts with the most accounts. */
  top: Array<{ hostname: string; accounts: number }>;
  /** Every listed host by the relay's state for it, when the station sends it. */
  statuses?: Record<HostStatus, number>;
  /** Independent hosts by accounts: 0, 1, up to 10, 100, 1,000, 10,000, and more (HOST_SIZE_BOUNDS). */
  sizes?: number[];
  /** The accounts on the hosts in each of those sizes. */
  sizeAccounts?: number[];
  /** The top-level domains with the most independent hosts. */
  tlds?: Array<{ tld: string; hosts: number; accounts: number }>;
}

export const HOST_STATUSES = ['active', 'idle', 'offline', 'throttled', 'banned', 'other'] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];
/** The station's size buckets (atmosphere/src/hosts.js SIZE_BOUNDS): each holds hosts with at most this many accounts, then one for more. */
export const HOST_SIZE_BOUNDS = [0, 1, 10, 100, 1000, 10000] as const;
const TLD_RE = /^[a-z0-9-]{2,63}$/;

/** How many hosts the reading names. */
export const TOP_HOSTS = 10;

/**
 * Who wrote in a stretch of the firehose, which is what the diversity index is worked out
 * from. NOBODY is a stretch with no accounts in it.
 */
export interface Crowd {
  /** Different accounts active. */
  active: number;
  /** How many of them wrote outside Bluesky. */
  elsewhere: number;
  /** Each app's accounts, in any order. */
  apps: readonly number[];
}

export const NOBODY: Crowd = Object.freeze({ active: 0, elsewhere: 0, apps: Object.freeze([]) });

export interface Reading {
  measuredAt: string;
  /** Seconds actually counted. */
  seconds: number;
  /** New Bluesky records a second, one decimal. */
  perSecond: Record<Metric, number>;
  condition: Condition;
  /** New records a second, in any collection. */
  records: { perSecond: number; bluesky: number; elsewhere: number };
  diversity: {
    /** How much of the atmosphere isn't Bluesky, by who's writing (diversityOf), two decimals. */
    index: number;
    level: DiversityLevel;
    /** Percent of active accounts that wrote outside Bluesky, two decimals. */
    share: number;
    /** How many apps they're spread across, as an effective number (spreadOf), two decimals. */
    spread: number;
    /** Apps (namespaces) outside Bluesky that wrote anything. */
    apps: number;
    /** Distinct collections that got a new record. */
    collections: number;
  };
  /** The busiest apps outside Bluesky. */
  apps: App[];
  /** Bluesky's busiest collections. */
  bluesky: Array<Rate & { nsid: string }>;
  /** Everything that went by, a second. */
  events: { creates: number; updates: number; deletes: number; identity: number; account: number };
  /** "station": a rolling 60 seconds from the weather station; "sample": a few seconds sampled here. */
  source: 'station' | 'sample';
  /** Who wrote, from the station only. */
  accounts?: Accounts;
  /** The PDS hosts on the network, from the station only. */
  hosts?: Hosts;
  /** The station's window. */
  window?: { from: string; to: string };
  /** The station's window second by second, oldest first; null for a second it missed. */
  series?: Array<SeriesPoint | null>;
}

export interface SeriesPoint {
  /** Unix seconds. */
  t: number;
  creates: number;
  bluesky: number;
  elsewhere: number;
  posts: number;
}

/** The parts of a WebSocket the sampler uses (the global WebSocket in Node 22 and browsers). */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close(): void;
}

export type OpenSocket = (url: string) => SocketLike;

export function conditionFor(recordsPerSecond: number): Condition {
  for (const [name, from] of CONDITIONS) if (recordsPerSecond >= from) return name;
  return 'calm';
}

export function diversityLevel(index: number): DiversityLevel {
  for (const [name, from] of DIVERSITY_LEVELS) if (index >= from) return name;
  return 'low';
}

/**
 * How many apps a crowd is spread across, as an effective number: e to the Shannon
 * entropy of their accounts over apps. Ten apps with as many accounts each is 10; one
 * app with nearly everyone is close to 1, however many others have an account or two.
 * 0 for nobody.
 */
export function spreadOf(accounts: Iterable<number>): number {
  let total = 0;
  for (const n of accounts) if (n > 0) total += n;
  if (total <= 0) return 0;
  let entropy = 0;
  for (const n of accounts) if (n > 0) entropy -= (n / total) * Math.log(n / total);
  return Math.exp(entropy);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The diversity index from its parts: the share of active accounts that wrote elsewhere (percent) times the square root of their spread. */
export function diversityIndex(share: number, spread: number): number {
  return round2(share * Math.sqrt(spread));
}

/**
 * The diversity index of a crowd: how much of the atmosphere isn't Bluesky, by who's
 * writing rather than how much gets written. One account writing a thousand records
 * counts once, and forty accounts across ten apps count for more than forty in one.
 * Each part two decimals.
 */
export function diversityOf(crowd: Crowd): { index: number; share: number; spread: number } {
  const share = crowd.active > 0 ? round2(Math.min(100, (100 * crowd.elsewhere) / crowd.active)) : 0;
  const spread = share > 0 ? round2(spreadOf(crowd.apps)) : 0;
  return { index: diversityIndex(share, spread), share, spread };
}

/** The whole firehose: no wantedCollections. */
export function jetstreamUrl(base: string): string {
  return base;
}

const METRIC_FOR: Record<string, Metric> = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [nsid, metric as Metric]));

/** A collection name worth repeating to visitors (the relay validates these, but they are still someone else's text). */
const NSID_RE = /^[a-z][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62}){1,}\.[a-z][a-z0-9]{0,62}$/i;

export function isNsid(value: string): boolean {
  return value.length <= 253 && NSID_RE.test(value);
}

export function isBluesky(nsid: string): boolean {
  return BLUESKY_PREFIXES.some((p) => nsid.startsWith(p));
}

/** An NSID's app, as a domain: its first two segments, reversed ("fyi.unravel.frontpage.post" -> "unravel.fyi"). */
export function appDomain(nsid: string): string {
  const [tld, name] = nsid.toLowerCase().split('.');
  return `${name}.${tld}`;
}

export type Event =
  | { kind: 'create'; collection: string }
  | { kind: 'update' | 'delete' | 'identity' | 'account' };

type Message = { kind?: unknown; did?: unknown; commit?: { operation?: unknown; collection?: unknown } } | null;

function parse(data: unknown): Message {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** What a Jetstream message is, or null for anything unreadable. */
export function eventOf(data: unknown): Event | null {
  return eventOfMessage(parse(data));
}

function eventOfMessage(m: Message): Event | null {
  if (m?.kind === 'identity' || m?.kind === 'account') return { kind: m.kind };
  if (m?.kind !== 'commit') return null;
  const op = m.commit?.operation;
  if (op === 'update' || op === 'delete') return { kind: op };
  if (op !== 'create' || typeof m.commit?.collection !== 'string' || !isNsid(m.commit.collection)) return null;
  return { kind: 'create', collection: m.commit.collection };
}

/** A DID as Jetstream gives it (did:plc:…, did:web:…). */
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/;

export interface Account {
  did: string;
  /** Its app, or null for Bluesky's collections. */
  app: string | null;
}

/** Whose a Jetstream message is: any commit to an NSID, by the station's rules (atmosphere/src/accounts.js accountOf); null for anything else. */
export function accountOf(data: unknown): Account | null {
  return accountOfMessage(parse(data));
}

function accountOfMessage(m: Message): Account | null {
  if (m?.kind !== 'commit' || typeof m.did !== 'string' || !DID_RE.test(m.did)) return null;
  const op = m.commit?.operation;
  const collection = m.commit?.collection;
  if ((op !== 'create' && op !== 'update' && op !== 'delete') || typeof collection !== 'string' || !isNsid(collection)) return null;
  return { did: m.did, app: isBluesky(collection) ? null : appDomain(collection) };
}

/** Who wrote while a sample listens: different DIDs, exactly, kept only while it listens. */
export interface CrowdTally {
  all: Set<string>;
  elsewhere: Set<string>;
  /** Each app's DIDs; past MAX_COLLECTIONS apps, a DID still counts for elsewhere. */
  apps: Map<string, Set<string>>;
}

export function emptyCrowd(): CrowdTally {
  return { all: new Set(), elsewhere: new Set(), apps: new Map() };
}

export function addAccount(crowd: CrowdTally, account: Account): void {
  crowd.all.add(account.did);
  if (account.app === null) return;
  crowd.elsewhere.add(account.did);
  const dids = crowd.apps.get(account.app);
  if (dids) dids.add(account.did);
  else if (crowd.apps.size < MAX_COLLECTIONS) crowd.apps.set(account.app, new Set([account.did]));
}

export function crowdOf(crowd: CrowdTally): Crowd {
  return { active: crowd.all.size, elsewhere: crowd.elsewhere.size, apps: [...crowd.apps.values()].map((dids) => dids.size) };
}

/** The metric a Jetstream message counts toward: a new record in one of COLLECTIONS. */
export function metricOf(data: unknown): Metric | null {
  const e = eventOf(data);
  return e?.kind === 'create' ? (METRIC_FOR[e.collection] ?? null) : null;
}

export interface Tally {
  creates: Map<string, number>;
  /** New records in collections past MAX_COLLECTIONS (counted, but not by name). */
  unnamed: number;
  updates: number;
  deletes: number;
  identity: number;
  account: number;
}

export function emptyTally(): Tally {
  return { creates: new Map(), unnamed: 0, updates: 0, deletes: 0, identity: 0, account: 0 };
}

export function addEvent(tally: Tally, event: Event): void {
  if (event.kind !== 'create') {
    tally[event.kind === 'update' ? 'updates' : event.kind === 'delete' ? 'deletes' : event.kind] += 1;
    return;
  }
  const n = tally.creates.get(event.collection);
  if (n !== undefined) tally.creates.set(event.collection, n + 1);
  else if (tally.creates.size < MAX_COLLECTIONS) tally.creates.set(event.collection, 1);
  else tally.unnamed += 1;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A tally over `seconds`, and who wrote it (NOBODY when that isn't known), as a Reading. */
export function summarize(tally: Tally, seconds: number, measuredAt: string, crowd: Crowd = NOBODY): Reading {
  const rate = (count: number) => round1(count / seconds);
  let bluesky = 0;
  let elsewhere = tally.unnamed;
  const apps = new Map<string, { count: number; collections: Array<[string, number]> }>();
  const bsky: Array<[string, number]> = [];
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
  const { index, share, spread } = diversityOf(crowd);
  const busiest = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  const perSecond = Object.fromEntries(Object.entries(COLLECTIONS).map(([metric, nsid]) => [metric, rate(tally.creates.get(nsid) ?? 0)])) as Record<Metric, number>;
  return {
    measuredAt,
    seconds: round1(seconds),
    perSecond,
    condition: conditionFor(rate(total)),
    records: { perSecond: rate(total), bluesky: rate(bluesky), elsewhere: rate(elsewhere) },
    diversity: { index, level: diversityLevel(index), share, spread, apps: apps.size, collections: tally.creates.size },
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
    source: 'sample',
  };
}

const DOMAIN_RE = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}$/;

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
function counts<K extends string>(x: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(x) || !keys.every((k) => isCount(x[k]))) return null;
  return Object.fromEntries(keys.map((k) => [k, x[k] as number])) as Record<K, number>;
}
const isoOrNull = (x: unknown) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null);

/** A station reading's `accounts`, checked, or undefined. */
function accountsOf(x: unknown): Accounts | undefined {
  const a = counts(x, ['active', 'bluesky', 'elsewhere', 'index'] as const);
  if (!a || !isRecord(x) || !Array.isArray(x.apps)) return undefined;
  return {
    ...a,
    index: Math.min(a.index, 100),
    apps: x.apps
      .filter((y): y is Record<string, unknown> => isRecord(y) && typeof y.domain === 'string' && DOMAIN_RE.test(y.domain) && isCount(y.accounts))
      .slice(0, TOP_APPS)
      .map((y) => ({
        domain: y.domain as string,
        accounts: y.accounts as number,
        collections: (Array.isArray(y.collections) ? y.collections : []).filter((c): c is string => typeof c === 'string' && isNsid(c)).slice(0, 3),
      })),
  };
}

export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A station reading's `hosts`, checked, or undefined. The index is worked out here from its parts. */
export function hostsOf(x: unknown): Hosts | undefined {
  const n = counts(x, ['listed', 'active', 'bluesky', 'independent'] as const);
  const measuredAt = isRecord(x) ? isoOrNull(x.measuredAt) : null;
  const accounts = isRecord(x) ? counts(x.accounts, ['bluesky', 'independent'] as const) : null;
  const parts = isRecord(x) ? counts(x.diversity, ['share', 'spread'] as const) : null;
  if (!n || !measuredAt || !accounts || !parts || !isRecord(x) || !Array.isArray(x.top)) return undefined;
  const writing = counts(x.writing, ['bluesky', 'independent', 'minutes'] as const);
  const share = Math.min(parts.share, 100);
  return {
    measuredAt,
    ...n,
    writing: writing && writing.minutes > 0 ? writing : null,
    accounts,
    diversity: { index: diversityIndex(share, parts.spread), share, spread: parts.spread },
    top: x.top
      .filter((h): h is Record<string, unknown> => isRecord(h) && typeof h.hostname === 'string' && HOSTNAME_RE.test(h.hostname) && isCount(h.accounts))
      .slice(0, TOP_HOSTS)
      .map((h) => ({ hostname: h.hostname as string, accounts: h.accounts as number })),
    ...hostExtras(x),
  };
}

/** A census's statuses, sizes and top-level domains, each left out if it doesn't check out. */
function hostExtras(x: Record<string, unknown>): Pick<Hosts, 'statuses' | 'sizes' | 'sizeAccounts' | 'tlds'> {
  const out: Pick<Hosts, 'statuses' | 'sizes' | 'sizeAccounts' | 'tlds'> = {};
  const statuses = counts(x.statuses, HOST_STATUSES);
  if (statuses) out.statuses = statuses;
  if (Array.isArray(x.sizes) && x.sizes.length === HOST_SIZE_BOUNDS.length + 1 && x.sizes.every(isCount)) out.sizes = x.sizes as number[];
  if (Array.isArray(x.sizeAccounts) && x.sizeAccounts.length === HOST_SIZE_BOUNDS.length + 1 && x.sizeAccounts.every(isCount)) out.sizeAccounts = x.sizeAccounts as number[];
  if (Array.isArray(x.tlds)) {
    out.tlds = x.tlds
      .filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.tld === 'string' && TLD_RE.test(t.tld) && isCount(t.hosts) && isCount(t.accounts))
      .slice(0, 8)
      .map((t) => ({ tld: t.tld as string, hosts: t.hosts as number, accounts: t.accounts as number }));
  }
  return out;
}

/**
 * A station answer as a Reading, or null if any required part is off. Rebuilt from known
 * fields only, names re-checked (they are someone else's text), condition, diversity
 * index and level worked out here from the numbers, so the two sources always agree on
 * the words.
 */
export function fromStation(body: unknown): Reading | null {
  if (!isRecord(body)) return null;
  const measuredAt = isoOrNull(body.measuredAt);
  const perSecond = counts(body.perSecond, ['posts', 'likes', 'reposts', 'follows'] as const);
  const records = counts(body.records, ['perSecond', 'bluesky', 'elsewhere'] as const);
  const diversity = counts(body.diversity, ['apps', 'collections'] as const);
  const events = counts(body.events, ['creates', 'updates', 'deletes', 'identity', 'account'] as const);
  const accounts = accountsOf(body.accounts);
  // A station from before the index went by accounts sends no share or spread: its
  // accounts stand in (only its top apps, so the spread reads a little low).
  const parts = counts(body.diversity, ['share', 'spread'] as const) ?? (accounts ? { share: accounts.index, spread: round2(spreadOf(accounts.apps.map((x) => x.accounts))) } : null);
  if (!measuredAt || !isCount(body.seconds) || body.seconds === 0 || !perSecond || !records || !diversity || !parts || !events) return null;
  if (!Array.isArray(body.apps) || !Array.isArray(body.bluesky)) return null;
  const apps: App[] = body.apps
    .filter((a): a is Record<string, unknown> => isRecord(a) && typeof a.domain === 'string' && DOMAIN_RE.test(a.domain) && isCount(a.perSecond) && isCount(a.count))
    .slice(0, TOP_APPS)
    .map((a) => ({
      domain: a.domain as string,
      perSecond: a.perSecond as number,
      count: a.count as number,
      collections: (Array.isArray(a.collections) ? a.collections : []).filter((c): c is string => typeof c === 'string' && isNsid(c)).slice(0, 3),
    }));
  const bluesky = body.bluesky
    .filter((b): b is Record<string, unknown> => isRecord(b) && typeof b.nsid === 'string' && isNsid(b.nsid) && isBluesky(b.nsid) && isCount(b.perSecond) && isCount(b.count))
    .slice(0, TOP_BLUESKY)
    .map((b) => ({ nsid: b.nsid as string, perSecond: b.perSecond as number, count: b.count as number }));
  const share = Math.min(parts.share, 100);
  const index = diversityIndex(share, parts.spread);
  const reading: Reading = {
    measuredAt,
    seconds: body.seconds,
    perSecond,
    condition: conditionFor(records.perSecond),
    records,
    diversity: { index, level: diversityLevel(index), share, spread: parts.spread, ...diversity },
    apps,
    bluesky,
    events,
    source: 'station',
  };
  if (accounts) reading.accounts = accounts;
  const hosts = hostsOf(body.hosts);
  if (hosts) reading.hosts = hosts;
  const w = isRecord(body.window) ? { from: isoOrNull(body.window.from), to: isoOrNull(body.window.to) } : null;
  if (w?.from && w.to) reading.window = { from: w.from, to: w.to };
  if (Array.isArray(body.series)) {
    reading.series = body.series.slice(-MAX_SERIES).map((p) => {
      const c = counts(p, ['t', 'creates', 'bluesky', 'elsewhere', 'posts'] as const);
      return c ? { t: c.t, creates: c.creates, bluesky: c.bluesky, elsewhere: c.elsewhere, posts: c.posts } : null;
    });
  }
  return reading;
}

/**
 * Connects, counts for `sampleMs`, disconnects. Rejects if the socket fails or doesn't
 * open in time, or if nothing at all arrived (a stalled stream is not a calm day).
 */
export function sample(open: OpenSocket, url: string, now: () => number, sampleMs = SAMPLE_MS, connectMs = CONNECT_TIMEOUT_MS): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const tally = emptyTally();
    const crowd = emptyCrowd();
    let started = 0;
    let opened = false;
    let seen = 0;
    let done = false;
    let socket: SocketLike;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (error) return reject(error);
      if (seen === 0) return reject(new Error('jetstream was silent'));
      const seconds = Math.max(0.5, (now() - started) / 1000);
      resolve(summarize(tally, seconds, new Date(now()).toISOString(), crowdOf(crowd)));
    };
    try {
      socket = open(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('could not open socket'));
      return;
    }
    const connecting = setTimeout(() => finish(new Error('jetstream did not connect')), connectMs);
    timers.push(connecting);
    socket.onopen = () => {
      // connected: the sample may well run longer than the connect timeout
      clearTimeout(connecting);
      opened = true;
      started = now();
      timers.push(setTimeout(() => finish(null), sampleMs));
    };
    socket.onmessage = (event) => {
      if (done || !opened) return;
      seen += 1;
      const m = parse(event.data);
      const e = eventOfMessage(m);
      if (e) addEvent(tally, e);
      const a = accountOfMessage(m);
      if (a) addAccount(crowd, a);
    };
    socket.onerror = () => finish(new Error('jetstream error'));
    socket.onclose = () => finish(opened ? null : new Error('jetstream closed'));
  });
}

export interface AtmosphereDeps {
  open?: OpenSocket;
  now?: () => number;
  sampleMs?: number;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
  /** For the station; default the global fetch. */
  fetch?: typeof fetch;
  /** Read on every request; default process.env. */
  env?: () => Record<string, string | undefined>;
}

export interface AtmosphereHandlers {
  GET(request: Request): Promise<Response>;
  HEAD(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

export function createAtmosphereHandlers(deps: AtmosphereDeps = {}): AtmosphereHandlers {
  const open: OpenSocket = deps.open ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((fields) => {
      const line = JSON.stringify({ src: 'atmosphere', ...fields });
      if (fields.event.endsWith('_error')) console.warn(line);
      else console.info(line);
    });
  const cache = new TtlCache<Promise<Reading>>(SAMPLE_TTL_MS, now);
  const stationCache = new TtlCache<Promise<Reading>>(STATION_TTL_MS, now);
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const env = deps.env ?? (() => process.env);
  let stationDownUntil = 0;

  function station(secret: string, url: string): Promise<Reading> {
    const cached = stationCache.get('reading');
    if (cached) return cached;
    const pending = (async () => {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'x-atpotato-weather-secret': secret },
        signal: AbortSignal.timeout(STATION_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`station answered ${res.status}`);
      const reading = fromStation(await res.json());
      if (!reading) throw new Error('station reading did not check out');
      return reading;
    })();
    stationCache.set('reading', pending);
    pending.catch(() => stationCache.delete('reading'));
    return pending;
  }

  /** The station's reading when it can be had, else a sample of our own. */
  async function read(): Promise<Reading> {
    const vars = env();
    const secret = vars.ATMOSPHERE_STATION_SECRET?.trim();
    if (secret && now() >= stationDownUntil) {
      try {
        return await station(secret, vars.ATMOSPHERE_STATION_URL?.trim() || STATION_URL);
      } catch (error) {
        stationDownUntil = now() + STATION_BACKOFF_MS;
        log({ event: 'station_error', error: (error as Error)?.message ?? 'Error' });
      }
    }
    return load();
  }

  function load(): Promise<Reading> {
    const cached = cache.get('reading');
    if (cached) return cached;
    const pending = (async () => {
      let lastError: unknown = null;
      // The second Jetstream is a fallback for when the first is down or silent.
      for (const base of JETSTREAMS) {
        try {
          return await sample(open, jetstreamUrl(base), now, deps.sampleMs ?? SAMPLE_MS);
        } catch (error) {
          lastError = error;
          log({ event: 'sample_error', jetstream: base, error: (error as Error)?.message ?? 'Error' });
        }
      }
      throw lastError instanceof Error ? lastError : new Error('no reading');
    })();
    cache.set('reading', pending);
    pending.catch(() => cache.delete('reading'));
    return pending;
  }

  async function GET(request: Request): Promise<Response> {
    let reading: Reading;
    try {
      reading = await read();
    } catch {
      return new Response(request.method === 'HEAD' ? null : '{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...BASE_HEADERS },
      });
    }
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(reading), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': reading.source === 'station' ? CACHE_LIVE : CACHE_OK, ...BASE_HEADERS },
    });
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', ...BASE_HEADERS },
      });
    },
  };
}
