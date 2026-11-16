// accounts.js
// Who's writing, not just how much: active accounts are the different DIDs that
// committed anything (a new record, an edit, a deletion) in a stretch of time, counted
// with HyperLogLog sketches (hll.js), so no DID is ever kept. One bot writing a thousand
// records a minute is a thousand records but one account.
//
// A commit counts for Bluesky when its collection is Bluesky's (app.bsky.*, chat.bsky.*),
// and otherwise for elsewhere and for its app, by the same rules as records
// (atmosphere.js). Someone who likes a post and stars a repo in the same minute is one
// active account, active on Bluesky and elsewhere both, so bluesky + elsewhere can come
// to more than active.
//
// Tangled's git repositories write as themselves. Each repository on a knot (a Tangled
// git server, knots.js) has an identity of its own, which holds the repository's refs and
// manifest, and the issues, pull requests and comments people make on it, each naming the
// person in `x-tngl-editor`. A repository isn't someone, so a Tangled record that names
// its editor counts for the editor, and a repository's own records (REPO_COLLECTIONS)
// count for nobody. Checked against Jetstream on 2026-11-16: in the day before 16:04 UTC,
// 1,433 identities wrote to tangled.org and 907 of them were repositories; by these rules
// 538 count, 9 of them still repositories (adding a collaborator, deleting something:
// records that name no editor). No account on a PDS wrote either of REPO_COLLECTIONS or
// named an editor. The rule reads only the message, so replay.js counts as the station
// does. archive.js hands over records as raw bytes, so there a repository's issues and
// comments still count for the repository (its refs and manifest count for nobody).
//
// The website's fallback sampler counts its few seconds by the same rules
// (website/server/atmosphere.ts accountOf): change both together.
//
// Per second, a bucket keeps the packed register updates (registerOf) of each commit,
// in lists: Bluesky's, each app's, and `unnamed` for apps past MAX_ACCOUNT_APPS. Sketches
// are only built when a window or a minute is summed.

import { appDomain, isBluesky, isNsid, TOP_APPS } from './atmosphere.js';
import { registerOf, Sketch } from './hll.js';

/** Apps tracked per second and per sketch set; past this, an app's accounts still count for elsewhere. */
export const MAX_ACCOUNT_APPS = 2000;

/** A DID as Jetstream gives it (did:plc:…, did:web:…). */
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/;

/** Tangled's collections: org.tangled.*, and sh.tangled.* from before it moved. */
const TANGLED_RE = /^(org|sh)\.tangled\./;

/** A Tangled repository's own records, which only the repository's identity writes. */
export const REPO_COLLECTIONS = new Set(['org.tangled.git.refs', 'org.tangled.repo.manifest']);

/** Who a Tangled commit counts for: the editor its record names, nobody for a repository's own records, else whoever wrote it. */
function tangledWriter(did, collection, record) {
  const editor = record?.['x-tngl-editor'];
  if (typeof editor === 'string' && DID_RE.test(editor)) return editor;
  return REPO_COLLECTIONS.has(collection) ? null : did;
}

/** Whose a parsed Jetstream message is: { register, app } for a commit, app null for Bluesky's collections; null for anything else. */
export function accountOf(m) {
  if (m?.kind !== 'commit' || typeof m.did !== 'string' || !DID_RE.test(m.did)) return null;
  const op = m.commit?.operation;
  const collection = m.commit?.collection;
  if ((op !== 'create' && op !== 'update' && op !== 'delete') || typeof collection !== 'string' || !isNsid(collection)) return null;
  const did = TANGLED_RE.test(collection) ? tangledWriter(m.did, collection, m.commit.record) : m.did;
  if (did === null) return null;
  return { register: registerOf(did), app: isBluesky(collection) ? null : appDomain(collection) };
}

export function emptyAccounts() {
  return { bluesky: [], apps: new Map(), unnamed: [] };
}

export function addAccount(accounts, account) {
  if (account.app === null) {
    accounts.bluesky.push(account.register);
    return;
  }
  const list = accounts.apps.get(account.app);
  if (list) list.push(account.register);
  else if (accounts.apps.size < MAX_ACCOUNT_APPS) accounts.apps.set(account.app, [account.register]);
  else accounts.unnamed.push(account.register);
}

/** Seconds' accounts as sketches: { all, bluesky, elsewhere, apps: Map<domain, Sketch> }. */
export function sketchAccounts(seconds) {
  const bluesky = new Sketch();
  const elsewhere = new Sketch();
  const apps = new Map();
  for (const a of seconds) {
    bluesky.addAll(a.bluesky);
    elsewhere.addAll(a.unnamed);
    for (const [domain, registers] of a.apps) {
      elsewhere.addAll(registers);
      let s = apps.get(domain);
      if (!s) {
        if (apps.size >= MAX_ACCOUNT_APPS) continue;
        s = new Sketch();
        apps.set(domain, s);
      }
      s.addAll(registers);
    }
  }
  return { all: new Sketch().merge(bluesky).merge(elsewhere), bluesky, elsewhere, apps };
}

/** Sketches as the crowd a reading's diversity index is worked out from (atmosphere.js diversityOf). */
export function crowdOf(sketches) {
  return { active: sketches.all.estimate(), elsewhere: sketches.elsewhere.estimate(), apps: [...sketches.apps.values()].map((s) => s.estimate()) };
}

/** Each app's busiest collections in a tally, busiest first (at most three). */
function collectionsByApp(tally) {
  const byApp = new Map();
  for (const [nsid, count] of tally.creates) {
    if (isBluesky(nsid)) continue;
    const domain = appDomain(nsid);
    byApp.set(domain, [...(byApp.get(domain) ?? []), [nsid, count]]);
  }
  return (domain) =>
    (byApp.get(domain) ?? [])
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([nsid]) => nsid);
}

/**
 * Sketches as a reading's `accounts`: how many were active, on Bluesky and elsewhere,
 * the share of them that wrote elsewhere (percent, two decimals: the reading's
 * diversity.share too), and the apps with the most accounts, with their busiest
 * collections from the window's tally.
 */
export function summarizeAccounts(sketches, tally) {
  const active = sketches.all.estimate();
  const elsewhere = sketches.elsewhere.estimate();
  const collections = collectionsByApp(tally);
  return {
    active,
    bluesky: sketches.bluesky.estimate(),
    elsewhere,
    index: active ? Math.min(100, Math.round((elsewhere / active) * 10_000) / 100) : 0,
    apps: [...sketches.apps]
      .map(([domain, s]) => ({ domain, accounts: s.estimate() }))
      .sort((a, b) => b.accounts - a.accounts || (a.domain < b.domain ? -1 : 1))
      .slice(0, TOP_APPS)
      .map((a) => ({ ...a, collections: collections(a.domain) })),
  };
}
