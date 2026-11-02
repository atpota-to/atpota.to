// The guidance store, the backup log of Poe's private memory, the weekly
// digest, and the admin API the website's admin page reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ADMIN = 'did:plc:adminadminadminadminadmi';
const OTHER = 'did:plc:otherotherotherotherothe';
process.env.ADMIN_DIDS = ADMIN;
process.env.ADMIN_SHARED_SECRET = 'admin-secret';
process.env.OPERATOR_DM_ENABLED = 'true';

const db = await import('../src/db.js');
const guidance = await import('../src/guidance.js');
const log = await import('../src/memory-log.js');
const digest = await import('../src/memory-digest.js');
const callback = await import('../src/callback.js');
const { config } = await import('../src/config.js');

const doc = (lastIndex, ...notes) =>
  `<!-- eve-memory-file-v1 lastAllocatedIndex=${lastIndex} -->\n${notes.map((n, i) => `${i}: ${n}\n`).join('')}`;

async function withServer(fn) {
  const server = callback.startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('lessons and style notes are copied into guidance once, lessons keeping their ids', () => {
  db.db.prepare(`INSERT INTO lessons (id, text, author_did, source_uri, added_at, rkey) VALUES (900, 'no faces in long replies', ?, 'at://x/app.bsky.feed.post/1', '2026-10-01T00:00:00Z', 'rk900')`).run(ADMIN);
  db.db.exec(`CREATE TABLE IF NOT EXISTS style_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
    author_did TEXT NOT NULL, source_uri TEXT NOT NULL UNIQUE, added_at TEXT NOT NULL, removed_at TEXT)`);
  db.db.prepare(`INSERT INTO style_feedback (text, author_did, source_uri, added_at) VALUES ('warmer, fewer exclamation marks', ?, 'dm:old', '2026-10-02T00:00:00Z')`).run(ADMIN);
  db.migrateGuidance();
  db.migrateGuidance();
  const lesson = db.getLesson(900);
  assert.equal(lesson.text, 'no faces in long replies');
  assert.equal(lesson.rkey, 'rk900', 'its published record stays linked');
  assert.equal(lesson.arenas, 'bluesky,website,weather,dispatch');
  const style = db.db.prepare(`SELECT * FROM guidance WHERE legacy LIKE 'style:%'`).all();
  assert.equal(style.length, 1);
  assert.equal(style[0].kind, 'style');
  assert.ok(style[0].id > 900, 'new ids come after the copied lessons');
  assert.deepEqual(db.activeLessons().map((l) => l.id), [900]);
});

test('DM prefixes name the kind and arenas; everything else is not guidance', () => {
  assert.deepEqual(guidance.parseGuidanceDm('style: keep it short'), { kind: 'style', arenas: ['bluesky', 'website', 'weather', 'dispatch'], text: 'keep it short' });
  assert.deepEqual(guidance.parseGuidanceDm('Dispatch:  lead with the weather link'), { kind: 'rule', arenas: ['dispatch'], text: 'lead with the weather link' });
  assert.deepEqual(guidance.parseGuidanceDm('replies: answer the question first').arenas, ['bluesky']);
  assert.equal(guidance.parseGuidanceDm('what is the dispatch: about?'), null);
  assert.equal(guidance.parseGuidanceDm('remember: this'), null);
  assert.equal(guidance.isGuidanceDm('remember: this'), true);
  assert.equal(guidance.isGuidanceDm('weather: no hour names'), true);
  assert.equal(guidance.isGuidanceDm('hi poe'), false);
});

test('guidance is validated, deduplicated, edited, retired and restored', () => {
  const { id, added } = guidance.addGuidance({ kind: 'rule', text: '  check   the code first ', arenas: ['dispatch'] });
  assert.equal(added, true);
  assert.equal(guidance.getGuidance(id).text, 'check the code first');
  assert.equal(guidance.addGuidance({ kind: 'rule', text: 'check the code first', arenas: ['dispatch'] }).added, false);
  assert.throws(() => guidance.addGuidance({ kind: 'rule', text: 'x', arenas: ['email'] }), guidance.GuidanceError);
  assert.throws(() => guidance.addGuidance({ kind: 'secret', text: 'x', arenas: ['dispatch'] }), guidance.GuidanceError);
  assert.throws(() => guidance.addGuidance({ kind: 'rule', text: '', arenas: ['dispatch'] }), guidance.GuidanceError);

  guidance.editGuidance(id, { arenas: ['dispatch', 'website'] });
  assert.deepEqual(guidance.getGuidance(id).arenas, ['website', 'dispatch'], 'arenas keep a fixed order');
  assert.equal(guidance.retireGuidance(id), true);
  assert.equal(guidance.retireGuidance(id), false);
  assert.ok(guidance.getGuidance(id).removedAt);
  assert.equal(guidance.restoreGuidance(id), true);
  assert.equal(guidance.getGuidance(id).removedAt, null);
});

test('editing a published lesson retires it and adds the new text, so the repo follows', () => {
  const id = db.addLesson('old lesson text', ADMIN, null);
  db.setLessonRkey(id, 'rkold');
  const { id: next } = guidance.editGuidance(id, { text: 'new lesson text' }, ADMIN);
  assert.notEqual(next, id);
  assert.ok(db.getLesson(id).removed_at);
  assert.equal(db.getLesson(next).text, 'new lesson text');
  const { unpublished, lingering } = db.lessonsOutOfStep();
  assert.ok(unpublished.some((l) => l.id === next));
  assert.ok(lingering.some((l) => l.id === id));
});

test('the agent gets each arena\'s newest items, oldest first, only for the arenas still in reach', () => {
  for (let i = 0; i < guidance.MAX_PER_ARENA + 2; i++) {
    guidance.addGuidance({ kind: 'rule', text: `weather rule ${i}`, arenas: ['weather'] });
  }
  const both = guidance.addGuidance({ kind: 'rule', text: 'both arenas', arenas: ['weather', 'website'] }).id;
  const items = guidance.guidanceForAgent();
  const weather = items.filter((g) => g.arenas.includes('weather'));
  assert.equal(weather.length, guidance.MAX_PER_ARENA);
  assert.ok(!weather.some((g) => g.text === 'weather rule 0'), 'the oldest fall out of the cap');
  assert.deepEqual(items.find((g) => g.id === both).arenas, ['website', 'weather']);
  const ids = items.map((g) => g.id);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'oldest first');
});

test('the backup log keeps distinct versions and diffs a week, a journal and its archive as one', () => {
  const at = (d) => `2026-10-${d}T12:00:00Z`;
  log.logMemoryVersion({ slot: 'life', scope: 'poe-life', content: doc(1, '[2026-10-01] a', '[2026-10-02] b'), source: 'poe' }, at('20'));
  assert.equal(log.logMemoryVersion({ slot: 'life', scope: 'poe-life', content: doc(1, '[2026-10-01] a', '[2026-10-02] b'), source: 'poe' }, at('21')), false, 'the same content twice is one version');
  // This week: "a" moved to the archive, "c" was written, "b" removed.
  log.logMemoryVersion({ slot: 'life:archive', scope: 'poe-life', content: JSON.stringify({ v: 1, months: { '2026-10': { notes: ['[2026-10-01] a'] } } }), source: 'poe' }, at('28'));
  log.logMemoryVersion({ slot: 'life', scope: 'poe-life', content: doc(3, '[2026-10-28] c'), source: 'poe' }, at('28'));
  const changes = log.memoryChangesSince(at('25'));
  assert.deepEqual(changes, [{ slot: 'life', scope: 'poe-life', added: ['[2026-10-28] c'], removed: ['[2026-10-02] b'] }]);
  assert.equal(log.memoryHistory('life', 'poe-life').length, 2);
});

test('pruning keeps each document\'s newest version, and forgetting drops every version that names someone', () => {
  log.logMemoryVersion({ slot: 'self', scope: 'poe-self', content: doc(0, 'old'), source: 'poe' }, '2025-01-01T00:00:00Z');
  log.logMemoryVersion({ slot: 'self', scope: 'poe-self', content: doc(1, 'old', 'newer'), source: 'poe' }, '2025-01-02T00:00:00Z');
  log.pruneMemoryVersions(Date.parse('2026-11-02T00:00:00Z'));
  assert.deepEqual(log.memoryHistory('self', 'poe-self').map((v) => v.content), [doc(1, 'old', 'newer')]);

  log.logMemoryVersion({ slot: 'person', scope: OTHER, content: doc(0, 'builds feeds'), source: 'poe' });
  log.logMemoryVersion({ slot: 'operator-dm-life', scope: 'poe-operator-dm-life', content: doc(0, 'chatted about bob.example.com'), source: 'poe' });
  log.forgetInLog(OTHER, 'bob.example.com');
  assert.equal(log.memoryHistory('person', OTHER).length, 0);
  assert.equal(log.memoryHistory('operator-dm-life', 'poe-operator-dm-life').length, 0);
});

test('/memory takes log versions and guidance calls beside person notes', async () => {
  db.db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at)
    VALUES ('dm-live', 'c1', ?, ?, 'dispatched', ?)`).run(ADMIN, db.nowIso(), db.nowIso());
  db.db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at)
    VALUES ('dm-done', 'c1', ?, ?, 'sent', ?)`).run(ADMIN, db.nowIso(), db.nowIso());
  await withServer(async (base) => {
    const post = (body, secret = 'test-secret') => fetch(`${base}/memory`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-atpotato-secret': secret }, body: JSON.stringify(body) });
    assert.equal((await post({ log: { slot: 'self', scope: 'poe-self', content: doc(0, 'x'), source: 'poe' } }, 'wrong')).status, 401);
    assert.equal((await post({ log: { slot: 'self', scope: 'poe-self', content: doc(0, 'x'), source: 'poe' } })).status, 202);
    assert.equal((await post({ log: { slot: 'Self!', scope: 'poe-self', content: 'x', source: 'poe' } })).status, 400);
    assert.equal((await post({ log: { slot: 'self', scope: 'poe-self', content: 'x', source: 'someone' } })).status, 400);

    const list = await (await post({ guidance: 'list' })).json();
    assert.ok(list.items.length > 0 && list.items.every((g) => g.id && g.text && g.arenas.length));

    const added = await post({ guidance: 'add', text: 'headliner gets its own heading', arenas: ['dispatch'], dmId: 'dm-live', operatorDid: ADMIN });
    assert.equal(added.status, 200);
    const { id, item } = await added.json();
    assert.equal(item.kind, 'rule');
    assert.equal(item.authorDid, ADMIN);
    // A second lesson from the same DM is its own rule.
    assert.equal((await (await post({ guidance: 'add', text: 'one more', arenas: ['dispatch'], dmId: 'dm-live', operatorDid: ADMIN })).json()).added, true);
    assert.equal((await post({ guidance: 'add', text: 'x', arenas: ['dispatch'], dmId: 'dm-done', operatorDid: ADMIN })).status, 409, 'only a DM being answered now');
    assert.equal((await post({ guidance: 'add', text: 'x', arenas: ['dispatch'], dmId: 'dm-live', operatorDid: OTHER })).status, 409);
    assert.equal((await post({ guidance: 'add', text: 'x', arenas: ['nowhere'], dmId: 'dm-live', operatorDid: ADMIN })).status, 400);
    assert.equal((await post({ guidance: 'remove', id: 900, dmId: 'dm-live', operatorDid: ADMIN })).status, 403, 'lessons are an admin\'s');
    assert.equal((await post({ guidance: 'remove', id, dmId: 'dm-live', operatorDid: ADMIN })).status, 200);
    assert.ok(guidance.getGuidance(id).removedAt);
  });
});

test('/admin/ needs the admin secret and an admin\'s DID, and never the droplet secret', async () => {
  await withServer(async (base) => {
    const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
    const as = (did = ADMIN, secret = 'admin-secret') => ({ 'x-atpotato-admin-secret': secret, 'x-atpotato-admin-did': did });
    assert.equal((await get('/admin/state')).status, 401);
    assert.equal((await get('/admin/state', as(ADMIN, 'test-secret'))).status, 401, 'the droplet secret is not the admin secret');
    assert.equal((await get('/admin/state', as(OTHER))).status, 403);
    const state = await (await get('/admin/state', as())).json();
    assert.equal(state.stage, 4);
    assert.ok('nap' in state && 'activity' in state && 'recent' in state);
    assert.equal((await get('/admin/state', as(config.botDid))).status, 200, 'Poe itself may look');
    assert.equal((await get('/admin/nope', as())).status, 404);

    const res = await fetch(`${base}/admin/guidance`, { method: 'POST', headers: { ...as(), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', kind: 'style', text: 'fewer em dashes', arenas: ['bluesky', 'website'] }) });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    assert.equal(guidance.getGuidance(id).authorDid, ADMIN);
    const bad = await fetch(`${base}/admin/guidance`, { method: 'POST', headers: { ...as(), 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'edit', id, arenas: ['moon'] }) });
    assert.equal(bad.status, 400);
    const all = await (await get('/admin/guidance', as())).json();
    assert.ok(all.active.some((g) => g.id === id));

    log.logMemoryVersion({ slot: 'operator-notes', scope: ADMIN, content: doc(0, 'likes short answers'), source: 'poe' });
    const history = await (await get(`/admin/memory/history?slot=operator-notes&scope=${encodeURIComponent(ADMIN)}`, as())).json();
    assert.equal(history.versions[0].content, doc(0, 'likes short answers'));
    const version = await (await get(`/admin/memory/version?id=${history.versions[0].id}`, as())).json();
    assert.equal(version.scope, ADMIN);

    const nap = await fetch(`${base}/admin/nap`, { method: 'POST', headers: { ...as(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'nap: 2h' }) });
    assert.equal(nap.status, 200);
    assert.equal((await nap.json()).nap.active, true);
    const wake = await fetch(`${base}/admin/nap`, { method: 'POST', headers: { ...as(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'wake' }) });
    assert.equal((await wake.json()).nap.active, false);
  });
});

test('the digest says what changed, is claimed once per week, and is sent once', async () => {
  const now = Date.parse('2026-11-01T18:30:00Z'); // a Sunday, just after the slot
  const scope = 'did:plc:digestdigestdigestdigestd';
  config.adminDids.push(scope);
  log.logMemoryVersion({ slot: 'operator-notes', scope, content: doc(0, 'likes short answers'), source: 'poe' }, '2026-10-20T10:00:00Z');
  log.logMemoryVersion({ slot: 'operator-notes', scope, content: doc(1, 'likes short answers', '[2026-10-30] prefers lowercase'), source: 'poe' }, '2026-10-30T10:00:00Z');
  // After the week ends: next week's news, not this one's.
  log.logMemoryVersion({ slot: 'operator-notes', scope, content: doc(2, 'likes short answers', '[2026-10-30] prefers lowercase', '[2026-11-02] later'), source: 'poe' }, '2026-11-02T10:00:00Z');
  db.db.prepare(`INSERT INTO guidance (kind, text, arenas, added_at, updated_at) VALUES ('rule', 'a rule from the week', 'dispatch', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')`).run();
  const text = digest.composeDigest(Date.parse('2026-11-01T18:00:00Z'), scope);
  assert.match(text, /notes about you: 1 new/);
  assert.match(text, /- prefers lowercase/);
  assert.doesNotMatch(text, /later/);
  assert.match(text, /guidance: 1 added, 0 retired\n- dispatch: a rule from the week/);
  assert.match(text, /atpota\.to\/admin/);

  assert.equal(digest.queueDigest(now), 'pending');
  assert.equal(digest.queueDigest(now), null, 'one per week');
  const sent = [];
  const deps = {
    getDmConvoForMembers: async () => ({ convo: { id: 'convo-1' } }),
    sendDmMessage: async (convoId, _id, part) => { sent.push([convoId, part]); },
  };
  await digest.sendDigests(deps);
  await digest.sendDigests(deps);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every(([convo]) => convo === 'convo-1'));
  assert.equal(digest.lastDigest().status, 'sent');
  config.adminDids.splice(config.adminDids.indexOf(scope), 1);
});

test('daily chores prune once a day and ask for the rollup only early in the month', async () => {
  let rollups = 0;
  const deps = { rollUp: async () => (rollups++, { ok: true }) };
  await digest.dailyChores(Date.parse('2026-11-02T05:00:00Z'), deps);
  await digest.dailyChores(Date.parse('2026-11-02T06:00:00Z'), deps);
  await digest.dailyChores(Date.parse('2026-11-15T05:00:00Z'), deps);
  assert.equal(rollups, 1);
});

test('the log is seeded once from the agent\'s snapshot and the droplet\'s person notes', async () => {
  let asked = 0;
  const deps = {
    snapshot: async (operators) => {
      asked++;
      assert.deepEqual(operators, [ADMIN]);
      return { ok: true, body: { docs: [{ slot: 'operator-dm-life', scope: 'poe-operator-dm-life', content: doc(0, 'seeded note') }] } };
    },
  };
  assert.equal(await digest.seedMemoryLog(deps), true);
  assert.equal(await digest.seedMemoryLog(deps), false);
  assert.equal(asked, 1);
  assert.equal(log.memoryHistory('operator-dm-life', 'poe-operator-dm-life')[0].source, 'snapshot');
});
