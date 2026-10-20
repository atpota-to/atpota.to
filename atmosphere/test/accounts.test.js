// Active accounts: who counts, for Bluesky or elsewhere, and what a reading says about them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOf, addAccount, emptyAccounts, MAX_ACCOUNT_APPS, sketchAccounts, summarizeAccounts } from '../src/accounts.js';
import { addEvent, emptyTally } from '../src/atmosphere.js';
import { registerOf } from '../src/hll.js';

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const commit = (operation, collection, did = DID) => ({ did, time_us: 1, kind: 'commit', commit: { operation, collection, rkey: 'x' } });

test('every commit with a lexicon counts its account, for Bluesky or for its app', () => {
  assert.deepEqual(accountOf(commit('create', 'app.bsky.feed.like')), { register: registerOf(DID), app: null });
  assert.deepEqual(accountOf(commit('create', 'chat.bsky.actor.declaration')), { register: registerOf(DID), app: null });
  assert.deepEqual(accountOf(commit('update', 'sh.tangled.repo')), { register: registerOf(DID), app: 'tangled.sh' });
  assert.deepEqual(accountOf(commit('delete', 'fyi.unravel.frontpage.post')), { register: registerOf(DID), app: 'unravel.fyi' });
  assert.equal(accountOf(commit('create', 'App.Bsky.Feed.Post')).app, 'bsky.app', 'not Bluesky by case, like records');
});

test('identity and account events, odd collections and odd DIDs count nobody', () => {
  assert.equal(accountOf({ did: DID, kind: 'identity', identity: {} }), null);
  assert.equal(accountOf({ did: DID, kind: 'account', account: {} }), null);
  assert.equal(accountOf(commit('create', 'not a collection')), null);
  assert.equal(accountOf(commit('create', 42)), null);
  assert.equal(accountOf(commit('frobnicate', 'app.bsky.feed.post')), null);
  assert.equal(accountOf(commit('create', 'app.bsky.feed.post', 'alice')), null);
  assert.equal(accountOf(commit('create', 'app.bsky.feed.post', 7)), null);
  assert.equal(accountOf(null), null);
  assert.ok(accountOf(commit('create', 'app.bsky.feed.post', 'did:web:example.com')));
});

test('someone active on Bluesky and elsewhere is one active account, counted on both sides', () => {
  // (names picked so no two of the 35 share a register, which would make them count as one)
  const a = emptyAccounts();
  for (let i = 0; i < 30; i++) addAccount(a, { register: registerOf(`did:plc:b${i}`), app: null });
  for (let i = 0; i < 10; i++) addAccount(a, { register: registerOf(`did:plc:b${i}`), app: 'tangled.sh' }); // the same ten
  for (let i = 0; i < 5; i++) addAccount(a, { register: registerOf(`did:plc:o${i}`), app: 'whtwnd.com' });
  addAccount(a, { register: registerOf('did:plc:o0'), app: 'whtwnd.com' }); // again
  const tally = emptyTally();
  for (const c of ['sh.tangled.repo', 'sh.tangled.feed.star', 'sh.tangled.feed.star', 'com.whtwnd.blog.entry']) addEvent(tally, { kind: 'create', collection: c });
  const r = summarizeAccounts(sketchAccounts([a]), tally);
  assert.deepEqual(r, {
    active: 35,
    bluesky: 30,
    elsewhere: 15,
    index: 42.86,
    apps: [
      { domain: 'tangled.sh', accounts: 10, collections: ['sh.tangled.feed.star', 'sh.tangled.repo'] },
      { domain: 'whtwnd.com', accounts: 5, collections: ['com.whtwnd.blog.entry'] },
    ],
  });
});

test('seconds add up as a union, not a sum', () => {
  const seconds = [0, 1, 2].map(() => {
    const a = emptyAccounts();
    for (let i = 0; i < 20; i++) addAccount(a, { register: registerOf(`did:plc:same${i}`), app: null });
    return a;
  });
  assert.equal(sketchAccounts(seconds).all.estimate(), 20);
});

test('past MAX_ACCOUNT_APPS, new apps still count for elsewhere', () => {
  const a = emptyAccounts();
  for (let i = 0; i < MAX_ACCOUNT_APPS + 5; i++) addAccount(a, { register: registerOf(`did:plc:app${i}`), app: `app${i}.com` });
  assert.equal(a.apps.size, MAX_ACCOUNT_APPS);
  assert.equal(a.unnamed.length, 5);
  const s = sketchAccounts([a]);
  assert.equal(s.apps.size, MAX_ACCOUNT_APPS);
  assert.ok(Math.abs(s.elsewhere.estimate() - (MAX_ACCOUNT_APPS + 5)) < 60);
});
