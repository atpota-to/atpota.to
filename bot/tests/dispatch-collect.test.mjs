import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectFeed, collectSearch, dedupePosts, inWindow, lastDays, looksLikeNsid, previousWeek, privacyFilter, trimPost,
} from '../agent/lib/dispatch/collect.ts';

const did = 'did:plc:ifow34t4mgatlvmu5bnkdq27';
const view = (rkey, extra = {}) => ({
  uri: `at://${did}/app.bsky.feed.post/${rkey}`,
  author: { did, handle: 'jevbot.bsky.social', displayName: 'Jev', labels: [] },
  record: { text: `post ${rkey}`, createdAt: '2026-10-14T12:00:00.000Z' },
  likeCount: 3, repostCount: 1, replyCount: 0, quoteCount: 0,
  ...extra,
});

test('previousWeek is Monday to Monday UTC before the current week', () => {
  assert.deepEqual(previousWeek(new Date('2026-10-18T21:00:00Z')),
    { since: '2026-10-05T00:00:00.000Z', until: '2026-10-12T00:00:00.000Z' });
  assert.deepEqual(previousWeek(new Date('2026-10-19T09:00:00Z')),
    { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' });
});

test('inWindow includes since and excludes until', () => {
  const window = { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' };
  assert.equal(inWindow('2026-10-12T00:00:00.000Z', window), true);
  assert.equal(inWindow('2026-10-19T00:00:00.000Z', window), false);
  assert.equal(inWindow(undefined, window), false);
  assert.equal(inWindow('not a date', window), false);
  assert.equal(lastDays(new Date('2026-10-18T00:00:00Z'), 7).since, '2026-10-11T00:00:00.000Z');
});

test('trimPost keeps links, quotes, alt text and a bsky.app url', () => {
  const quoted = `at://${did}/app.bsky.feed.post/quoted`;
  const post = trimPost(view('abc', {
    record: {
      text: 'shipped it', createdAt: '2026-10-14T12:00:00.000Z',
      reply: { parent: { uri: `at://${did}/app.bsky.feed.post/parent` } },
      facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a' }] },
        { features: [{ $type: 'app.bsky.richtext.facet#mention', did }] }],
    },
    embed: {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: { record: { uri: quoted } },
      media: { $type: 'app.bsky.embed.images#view', images: [{ alt: 'a potato' }, { alt: '' }] },
    },
  }), 'search:atproto');
  assert.equal(post.url, 'https://bsky.app/profile/jevbot.bsky.social/post/abc');
  assert.deepEqual(post.links, ['https://example.com/a']);
  assert.equal(post.quoted, quoted);
  assert.deepEqual(post.imageAlts, ['a potato']);
  assert.equal(post.replyTo, `at://${did}/app.bsky.feed.post/parent`);
  assert.deepEqual(post.via, ['search:atproto']);

  const external = trimPost(view('ext', {
    embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://example.com/b' } },
  }), 'feed:x');
  assert.deepEqual(external.links, ['https://example.com/b']);
});

test('dedupePosts merges the sources that found a post', () => {
  const merged = dedupePosts([trimPost(view('a'), 'feed:x'), trimPost(view('a'), 'search:y'), trimPost(view('b'), 'feed:x')]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].via, ['feed:x', 'search:y']);
});

test('privacyFilter drops opt-outs and labeled posts, and keeps !no-unauthenticated authors marked', () => {
  const other = { did: 'did:plc:other', handle: 'other.example', labels: [] };
  const hidden = view('hidden', { author: { ...other, labels: [{ val: '!no-unauthenticated' }] } });
  const result = privacyFilter([
    view('kept'),
    view('optout', { author: { ...other, handle: 'Quiet.Example' } }),
    hidden,
    view('labeled', { labels: [{ val: 'porn' }] }),
  ], ['quiet.example']);
  assert.deepEqual(result.kept.map((v) => v.uri.split('/').pop()), ['kept', 'hidden']);
  assert.deepEqual(result.removed, { optOut: 1, labeled: 1 });
  assert.equal(trimPost(hidden, 'feed:x').noUnauthenticated, true);
  assert.equal('noUnauthenticated' in trimPost(view('kept'), 'feed:x'), false);
});

test('looksLikeNsid flags fuzzing-style collection names', () => {
  assert.equal(looksLikeNsid('app.bsky.actor.link'), true);
  assert.equal(looksLikeNsid('C.d.e.f'), true);
  assert.equal(looksLikeNsid('a--------0.0.A'), false);
  assert.equal(looksLikeNsid('two.parts'), false);
  assert.equal(looksLikeNsid('store.lexicon.app.2ndscreen.log'), true);
  assert.equal(looksLikeNsid('app.example.2ndthing'), false);
});

test('collectFeed stops paging a list once it passes the window start', async () => {
  const window = { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' };
  const pages = [
    { feed: [{ post: view('new', { record: { createdAt: '2026-10-15T00:00:00Z' } }) }], cursor: 'c1' },
    { feed: [{ post: view('old', { record: { createdAt: '2026-10-01T00:00:00Z' } }) }], cursor: 'c2' },
    { feed: [{ post: view('never') }], cursor: 'c3' },
  ];
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  };
  const posts = await collectFeed(fakeFetch, 'list', 'at://x/app.bsky.graph.list/y', window);
  assert.deepEqual(posts.map((p) => p.uri.split('/').pop()), ['new']);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /getListFeed\?list=at%3A%2F%2Fx/);
});

test('collectSearch reads top and latest and keeps only the window', async () => {
  const window = { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' };
  const calls = [];
  const search = async (query, sort, _window, cursor) => {
    calls.push([query, sort, cursor]);
    return { posts: [view(`${sort}`), view('stale', { record: { createdAt: '2026-09-01T00:00:00Z' } })] };
  };
  const posts = await collectSearch(search, 'atproto', window);
  assert.deepEqual(calls, [['atproto', 'top', undefined], ['atproto', 'latest', undefined]]);
  assert.deepEqual(posts.map((p) => p.uri.split('/').pop()), ['top', 'latest']);
});

test('collectSearch keeps earlier pages when a later page fails', async () => {
  const window = { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' };
  const search = async (_query, sort, _window, cursor) => {
    if (cursor) throw new Error('connection reset');
    return { posts: [view(sort)], cursor: 'next' };
  };
  const posts = await collectSearch(search, 'atproto', window);
  assert.deepEqual(posts.map((p) => p.uri.split('/').pop()), ['top', 'latest']);
  await assert.rejects(collectSearch(async () => { throw new Error('403'); }, 'atproto', window), /403/);
});

test('groupNewLexicons counts new NSIDs per domain in code', async () => {
  const { groupNewLexicons } = await import('../agent/lib/dispatch/collect.ts');
  const lex = (nsid, accounts, flags = []) => ({ nsid, accounts, creates: accounts * 2, updates: 0, deletes: 0, explore: '', flags });
  const groups = groupNewLexicons([
    lex('app.sonasky.apollo.page', 20), lex('app.sonasky.apollo', 20), lex('app.sonasky.apollo.ring', 4),
    lex('dev.solo.thing', 1, ['single-account']), lex('a--0.0.A', 9, ['invalid-looking']), lex('bot.did.registration', 240),
  ]);
  assert.deepEqual(groups.map((g) => [g.root, g.count, g.flagged, g.maxAccounts]),
    [['bot.did', 1, 0, 240], ['app.sonasky', 3, 0, 20], ['a--0.0', 1, 1, 9]]);
  assert.equal(groups[1].creates, 88);
});

test('talkTargets picks movers and busy new projects, one per domain, never Bluesky\'s own', async () => {
  const { talkTargets, domainFor } = await import('../agent/lib/dispatch/collect.ts');
  assert.equal(domainFor('so.sprk.feed.post'), 'sprk.so');
  assert.equal(domainFor('app.sonasky'), 'sonasky.app');
  const mover = (nsid, before, after) => ({ nsid, accountsBefore: before, accountsAfter: after, change: after - before, explore: '' });
  const report = {
    movers: { up: [mover('so.sprk.feed.post', 39, 4685), mover('so.sprk.actor.profile', 144, 1793), mover('app.bsky.feed.post', 1, 2)],
      down: [mover('tech.tokimeki.poll.vote', 147, 27)] },
    newByProject: [{ root: 'app.sonasky', count: 10, flagged: 0, maxAccounts: 20, creates: 221, nsids: [] },
      { root: 'dev.quiet', count: 2, flagged: 0, maxAccounts: 1, creates: 2, nsids: [] }],
  };
  assert.deepEqual(talkTargets(report).map((t) => t.root), ['so.sprk', 'tech.tokimeki', 'app.sonasky']);
});

test('collectLexiconTalk reads the app account and searches its domain', async () => {
  const { collectLexiconTalk } = await import('../agent/lib/dispatch/collect.ts');
  const window = { since: '2026-10-12T00:00:00.000Z', until: '2026-10-19T00:00:00.000Z' };
  const report = { movers: { up: [], down: [] }, newByProject: [{ root: 'app.sonasky', count: 10, flagged: 0, maxAccounts: 20, creates: 0, nsids: [] }] };
  const fakeFetch = async (url) => {
    assert.match(url, /getAuthorFeed\?actor=sonasky\.app/);
    return new Response(JSON.stringify({ feed: [{ post: view('announce', { likeCount: 36 }) }, { post: view('repost'), reason: {} }] }), { status: 200 });
  };
  const queries = [];
  const search = async (query, sort) => { queries.push([query, sort]); return { posts: [view('mention')] }; };
  const { talk, found } = await collectLexiconTalk(fakeFetch, search, report, window);
  assert.deepEqual(queries, [['sonasky.app', 'top'], ['sonasky.app', 'latest']]);
  assert.deepEqual(found.map((f) => [f.view.uri.split('/').pop(), f.via]), [['announce', 'lexicon:app.sonasky'], ['mention', 'lexicon:app.sonasky']]);
  assert.equal(talk[0].domain, 'sonasky.app');
});
