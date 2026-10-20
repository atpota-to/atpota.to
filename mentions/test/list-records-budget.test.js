import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { startCallbackServer } from '../src/callback.js';

const authorDid = 'did:plc:listrecordsbudgettest';
const uri = (rkey) => `at://${authorDid}/app.bsky.feed.post/${rkey}`;
const payload = (rkey, limit = 100, attempt = 1) => ({
  sessionId: 'thread-session', postUri: uri(rkey), attempt, limit,
});

function seed(rkey, status = 'sent_to_agent', attempt = 1) {
  const postUri = uri(rkey);
  db.prepare(`INSERT INTO queue (did, rkey, uri, cid, author_did, text, reason, thread_root,
    root_uri, root_cid, parent_uri, parent_cid, status, source, matched_at, attempts)
    VALUES (?, ?, ?, 'cid', ?, 'question', 'mention', ?, ?, 'cid', ?, 'cid', ?, 'jetstream', ?, ?)`)
    .run(authorDid, rkey, postUri, authorDid, postUri, postUri, postUri, status, new Date().toISOString(), attempt);
}

async function claim(url, body, secret = config.sharedSecret) {
  const response = await fetch(url, { method: 'POST',
    headers: { 'x-atpotato-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function serve() {
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/internal/list-records-budget/claim` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('list_records claim authenticates and validates before spending budget', async () => {
  seed('auth');
  const { server, url } = await serve();
  try {
    assert.equal((await claim(url, payload('auth'), 'bad-secret')).status, 401);
    const noSecret = await fetch(url, { method: 'POST', body: JSON.stringify(payload('auth')) });
    assert.equal(noSecret.status, 401);
    for (const invalid of [null, [], {}, { ...payload('auth'), sessionId: ' ' },
      { ...payload('auth'), postUri: 'not a post' }, { ...payload('auth'), attempt: 0 },
      { ...payload('auth'), attempt: 1.5 }, { ...payload('auth'), limit: 0 },
      { ...payload('auth'), limit: 101 }, { ...payload('auth'), limit: 1.5 },
      { ...payload('auth'), limit: '100' }, { ...payload('auth'), limit: null }]) {
      assert.equal((await claim(url, invalid)).status, 400);
    }
    assert.equal((await claim(url, payload('auth', 1))).status, 200);
    assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_budget_claims WHERE post_uri = ?')
      .get(uri('auth')) }, { pages_claimed: 1, records_claimed: 1 });
  } finally {
    await close(server);
  }
});

test('session-only claims authenticate, validate, and do not accept partial post references', async () => {
  const { server, url } = await serve();
  const body = { sessionId: 'website-session', limit: 1 };
  try {
    assert.equal((await claim(url, body, 'bad-secret')).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status, 401);
    for (const invalid of [null, [], {}, { ...body, sessionId: '' },
      { ...body, sessionId: ' '.repeat(3) }, { ...body, sessionId: 'x'.repeat(501) },
      { ...body, limit: 0 }, { ...body, limit: 101 }, { ...body, limit: '1' },
      { ...body, limit: 1.5 }, { ...body, postUri: null },
      { ...body, postUri: uri('missing') }, { ...body, attempt: 1 },
      { ...body, attempt: null }]) {
      assert.equal((await claim(url, invalid)).status, 400);
    }
    assert.deepEqual(await claim(url, body),
      { status: 200, body: { ok: true, remainingPages: 9, remainingRecords: 999 } });
    assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_session_budget_claims WHERE session_id = ?')
      .get(body.sessionId) }, { pages_claimed: 1, records_claimed: 1 });
  } finally {
    await close(server);
  }
});

test('non-Bluesky session caps are atomic across workers, turns, and server restarts', async () => {
  const sessionId = 'operator-dm-session';
  const { server, url } = await serve();
  try {
    const results = await Promise.all(Array.from({ length: 11 }, () =>
      claim(url, { sessionId, limit: 100 })));
    assert.equal(results.filter((r) => r.status === 200).length, 10);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    assert.deepEqual(results.filter((r) => r.status === 200).map((r) => r.body),
      Array.from({ length: 10 }, (_, i) =>
        ({ ok: true, remainingPages: 9 - i, remainingRecords: 900 - 100 * i })));
    assert.equal((await claim(url, { sessionId, limit: 1 })).status, 409);
    assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_session_budget_claims WHERE session_id = ?')
      .get(sessionId) }, { pages_claimed: 10, records_claimed: 1000 });
    assert.deepEqual((await claim(url, { sessionId: 'another-session', limit: 100 })).body,
      { ok: true, remainingPages: 9, remainingRecords: 900 });
  } finally {
    await close(server);
  }
  const restarted = await serve();
  try {
    assert.equal((await claim(restarted.url, { sessionId, limit: 1 })).status, 409);
  } finally {
    await close(restarted.server);
  }
});

test('session-only and post-bound claims stay independent even for the same sessionId', async () => {
  seed('mixed');
  const { server, url } = await serve();
  try {
    assert.deepEqual((await claim(url, payload('mixed', 100))).body,
      { ok: true, remainingPages: 9, remainingRecords: 900 });
    assert.deepEqual((await claim(url, { sessionId: 'thread-session', limit: 100 })).body,
      { ok: true, remainingPages: 9, remainingRecords: 900 });
    assert.equal((await claim(url, { sessionId: 'thread-session', postUri: uri('missing'), attempt: 1, limit: 1 })).status, 409);
    assert.deepEqual((await claim(url, payload('mixed', 100))).body,
      { ok: true, remainingPages: 8, remainingRecords: 800 });
    assert.deepEqual((await claim(url, { sessionId: 'thread-session', limit: 100 })).body,
      { ok: true, remainingPages: 8, remainingRecords: 800 });
  } finally {
    await close(server);
  }
});

test('parallel workers share ten page reservations, and a repeat spends another page', async () => {
  seed('parallel');
  const { server, url } = await serve();
  try {
    const results = await Promise.all(Array.from({ length: 11 }, (_, i) =>
      claim(url, { ...payload('parallel'), sessionId: `worker-${i}` })));
    assert.equal(results.filter((r) => r.status === 200).length, 10);
    assert.equal(results.filter((r) => r.status === 409).length, 1);
    assert.deepEqual(results.filter((r) => r.status === 200).map((r) => r.body),
      Array.from({ length: 10 }, (_, i) =>
        ({ ok: true, remainingPages: 9 - i, remainingRecords: 900 - 100 * i })));
    assert.equal((await claim(url, payload('parallel'))).status, 409);
    assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_budget_claims WHERE post_uri = ?')
      .get(uri('parallel')) }, { pages_claimed: 10, records_claimed: 1000 });
  } finally {
    await close(server);
  }
});

test('records cap rejects oversized reservations without spending a page; repeats are not free', async () => {
  seed('recordcap');
  seed('repeat');
  const { server, url } = await serve();
  try {
    assert.deepEqual(await claim(url, payload('recordcap', 100)),
      { status: 200, body: { ok: true, remainingPages: 9, remainingRecords: 900 } });
    assert.deepEqual(await claim(url, payload('recordcap', 99)),
      { status: 200, body: { ok: true, remainingPages: 8, remainingRecords: 801 } });
    assert.equal((await claim(url, payload('recordcap', 102))).status, 400);
    assert.deepEqual(await claim(url, payload('recordcap', 100)),
      { status: 200, body: { ok: true, remainingPages: 7, remainingRecords: 701 } });

    // A pre-existing row near the records cap must still respect that cap.
    assert.equal((await claim(url, payload('repeat', 1))).status, 200);
    db.prepare('UPDATE list_records_budget_claims SET records_claimed = 999 WHERE post_uri = ?')
      .run(uri('repeat'));
    assert.equal((await claim(url, payload('repeat', 2))).status, 409);
    assert.deepEqual(await claim(url, payload('repeat', 1)),
      { status: 200, body: { ok: true, remainingPages: 8, remainingRecords: 0 } });
    assert.equal((await claim(url, payload('repeat', 1))).status, 409);
    assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_budget_claims WHERE post_uri = ?')
      .get(uri('repeat')) }, { pages_claimed: 2, records_claimed: 1000 });
  } finally {
    await close(server);
  }
});

test('legacy budget tables migrate without resetting spent pages or records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'list-records-budget-'));
  const file = join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec(db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'queue'").get().sql);
    legacy.exec(`
      CREATE TABLE list_records_budget_claims (
        post_uri TEXT NOT NULL, attempt INTEGER NOT NULL,
        queue_id INTEGER NOT NULL REFERENCES queue(id), session_id TEXT NOT NULL,
        pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 3),
        records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 300),
        claimed_at TEXT NOT NULL, PRIMARY KEY (post_uri, attempt)
      );
      CREATE TABLE list_records_session_budget_claims (
        session_id TEXT PRIMARY KEY,
        pages_claimed INTEGER NOT NULL DEFAULT 0 CHECK (pages_claimed BETWEEN 0 AND 3),
        records_claimed INTEGER NOT NULL DEFAULT 0 CHECK (records_claimed BETWEEN 0 AND 300),
        claimed_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`INSERT INTO queue (did, rkey, uri, cid, author_did, text, reason,
      thread_root, root_uri, root_cid, parent_uri, parent_cid, status, source, matched_at, attempts)
      VALUES (?, 'migrated', ?, 'cid', ?, 'question', 'mention', ?, ?, 'cid', ?, 'cid',
        'sent_to_agent', 'jetstream', '2026-01-01', 1)`)
      .run(authorDid, uri('migrated'), authorDid, uri('migrated'), uri('migrated'), uri('migrated'));
    const queueId = legacy.prepare('SELECT id FROM queue WHERE uri = ?').get(uri('migrated')).id;
    legacy.prepare(`INSERT INTO list_records_budget_claims
      (post_uri, attempt, queue_id, session_id, pages_claimed, records_claimed, claimed_at)
      VALUES (?, 1, ?, 'old-worker', 2, 200, '2026-01-01')`).run(uri('migrated'), queueId);
    legacy.prepare(`INSERT INTO list_records_session_budget_claims
      (session_id, pages_claimed, records_claimed, claimed_at)
      VALUES ('old-session', 3, 250, '2026-01-01')`).run();
    legacy.close();

    const script = `
      import assert from 'node:assert/strict';
      import { db, claimListRecordsBudget, claimListRecordsSessionBudget, closeDb } from './src/db.js';
      const post = ${JSON.stringify(uri('migrated'))};
      assert.deepEqual({ ...db.prepare('SELECT pages_claimed, records_claimed FROM list_records_budget_claims WHERE post_uri = ?').get(post) },
        { pages_claimed: 2, records_claimed: 200 });
      assert.deepEqual({ ...db.prepare("SELECT pages_claimed, records_claimed FROM list_records_session_budget_claims WHERE session_id = 'old-session'").get() },
        { pages_claimed: 3, records_claimed: 250 });
      for (let i = 0; i < 8; i++) {
        assert.deepEqual(claimListRecordsBudget('new-worker', post, 1, 100),
          { remainingPages: 7 - i, remainingRecords: 700 - 100 * i });
      }
      assert.equal(claimListRecordsBudget('new-worker', post, 1, 1), null);
      for (let i = 0; i < 7; i++) {
        assert.deepEqual(claimListRecordsSessionBudget('old-session', 100),
          { remainingPages: 6 - i, remainingRecords: 650 - 100 * i });
      }
      assert.equal(claimListRecordsSessionBudget('old-session', 1), null);
      assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
      closeDb();
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd: new URL('..', import.meta.url), env: { ...process.env, DB_FILE: file } });
  } finally {
    try { legacy.close(); } catch { /* closed above */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the exact pending queue generation can claim; retries and scan claims are independent', async () => {
  seed('pending', 'matched');
  seed('separate');
  const { server, url } = await serve();
  try {
    assert.equal((await claim(url, payload('missing'))).status, 409);
    assert.equal((await claim(url, payload('pending'))).status, 409);
    assert.equal((await claim(url, payload('pending', 1, 2))).status, 409);
    db.prepare("UPDATE queue SET status = 'sent_to_agent' WHERE uri = ?").run(uri('pending'));
    assert.equal((await claim(url, payload('pending', 1, 2))).status, 409);
    assert.deepEqual((await claim(url, payload('pending', 1))).body,
      { ok: true, remainingPages: 9, remainingRecords: 999 });
    db.prepare("UPDATE queue SET status = 'drafted' WHERE uri = ?").run(uri('pending'));
    assert.equal((await claim(url, payload('pending', 1))).status, 409);
    db.prepare("UPDATE queue SET attempts = 2, status = 'sent_to_agent' WHERE uri = ?").run(uri('pending'));
    assert.deepEqual((await claim(url, payload('pending', 100, 2))).body,
      { ok: true, remainingPages: 9, remainingRecords: 900 });
    assert.equal((await claim(url, payload('pending', 1))).status, 409);

    assert.deepEqual((await claim(url, payload('separate', 100))).body,
      { ok: true, remainingPages: 9, remainingRecords: 900 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_budget_claims WHERE post_uri = ?').get(uri('separate')).n, 0);
    // The scan claim remains available during the same dispatch.
    const scanUrl = url.replace('list-records-budget', 'scan-budget');
    assert.equal((await claim(scanUrl, { sessionId: 'thread-session', postUri: uri('separate'), attempt: 1 })).status, 200);
    assert.deepEqual((await claim(url, payload('separate', 100))).body,
      { ok: true, remainingPages: 8, remainingRecords: 800 });
  } finally {
    await close(server);
  }

  const restarted = await serve();
  try {
    assert.deepEqual((await claim(restarted.url, payload('pending', 100, 2))).body,
      { ok: true, remainingPages: 8, remainingRecords: 800 });
  } finally {
    await close(restarted.server);
  }
});
