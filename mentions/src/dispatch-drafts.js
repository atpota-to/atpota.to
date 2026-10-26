// dispatch-drafts.js
// Poe writing the weekly dispatch on its own, the droplet's half.
//
//   1. Once a week (DISPATCH_DRAFT_DAY at DISPATCH_DRAFT_HOUR_UTC), or when an
//      operator DMs "draft dispatch", the droplet asks the agent for a draft:
//      POST <AGENT_URL>/dispatch/draft. Poe researches the week and saves the
//      issue in markdown with its save_dispatch_draft tool.
//   2. Each save comes here on the callback URL ({ dispatchDraft: { action:
//      'save', ... } }). It is turned into the exact site.standard.document
//      that would be published (dispatch-markdown.js), kept as a new version,
//      and shown on a private preview page: atpota.to/blog/preview/<token>,
//      which reads it from GET /dispatch/preview/<token> here.
//   3. When the drafting turn ends, Poe DMs the operator the preview link.
//      Their replies go to Poe like any operator DM, with the draft named in
//      the hand-off, so Poe can read it and save edits from that DM.
//   4. "Make it live" is a proposal, like an announcement: Poe calls
//      propose_dispatch_publish, the exact steps go under its reply, and only
//      the operator's yes to that message publishes the draft, at exactly the
//      version they saw. Publishing creates the document in atpota.to's repo
//      (Leaflet emails it to subscribers once it sees it), then announce()
//      posts and links it.
//   5. A typo found once it's live is a proposal too: Poe reads the issue as
//      published, proposes small edits (propose_dispatch_correction), and the
//      operator's yes puts the corrected record over the live one. A put, never
//      a create, so Leaflet doesn't email anyone again.
//
// The agent never writes the record. It sends markdown; the record is built
// here, every link checked, and nothing reaches atpota.to's repo without the
// operator's yes to the version they read. A prompt injection during research
// can at worst put words in a draft the operator reviews before anything is
// public.

import { randomBytes } from 'node:crypto';
import { config, isAdmin, killSwitchEngaged, DISPATCH_PAGE_BASES } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import { isNapping } from './nap.js';
import * as atproto from './atproto.js';
import { graphemeLength } from './richtext.js';
import {
  markdownToBlocks, enrichBlocks, draftRecord, metaProblems, recordSize, MAX_MARKDOWN_CHARS,
} from './dispatch-markdown.js';
import {
  announce, answersProposal, defaultDeps as dispatchDeps, fitPostText, latestDocument, nextTid, ogContent, pageUrls,
  parseIssueLink,
} from './dispatch.js';
import { postTextProblem } from './operator-posts.js';
import { splitDmText } from './operator-dm.js';

db.exec(`
  -- One row per issue Poe was asked to write.
  CREATE TABLE IF NOT EXISTS dispatch_draft (
    id             TEXT PRIMARY KEY,      -- dd-<the slot's date>, or dd-<timestamp>-<n> when an operator asked
    kind           TEXT NOT NULL,         -- weekly | asked
    window_start   TEXT NOT NULL,         -- the stretch of time the issue covers
    window_end     TEXT NOT NULL,
    guidance       TEXT,                  -- the operator's words, when they asked for it
    operator_did   TEXT NOT NULL,         -- who it is shown to
    status         TEXT NOT NULL,         -- asking|drafting|ready|publishing|published|failed|superseded|skipped
    preview_token  TEXT NOT NULL UNIQUE,
    version        INTEGER NOT NULL DEFAULT 0,
    title          TEXT,
    description    TEXT,
    tags           TEXT,                  -- JSON array
    markdown       TEXT,
    record         TEXT,                  -- JSON: the document as it would be published, less publishedAt and path
    notes          TEXT,                  -- JSON: what the last save noticed, for Poe to fix
    note           TEXT,                  -- Poe's word to the operator when the drafting turn ended
    done_key       TEXT UNIQUE,           -- that turn's callback key
    attempts       INTEGER NOT NULL DEFAULT 0,
    detail         TEXT,
    asked_at       TEXT,
    drafted_at     TEXT,
    document_rkey  TEXT UNIQUE,           -- claimed before the document is created
    published_at   TEXT,                  -- its publishedAt, fixed once chosen
    document_uri   TEXT,
    document_cid   TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dispatch_draft_status_idx ON dispatch_draft (status, created_at);

  -- Every save, so an edit can be looked back on and a yes pins one version.
  CREATE TABLE IF NOT EXISTS dispatch_draft_version (
    draft_id    TEXT NOT NULL,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    tags        TEXT,
    markdown    TEXT NOT NULL,
    record      TEXT NOT NULL,
    saved_by    TEXT NOT NULL,            -- drafting | dm:<the operator DM Poe was answering>
    created_at  TEXT NOT NULL,
    PRIMARY KEY (draft_id, version)
  );

  -- "Make it live", proposed by Poe in an operator DM. One is live at a time,
  -- and it publishes only on the operator's yes to the DM that showed it.
  CREATE TABLE IF NOT EXISTS dispatch_publish (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id            TEXT NOT NULL,
    version             INTEGER NOT NULL,
    dm_message_id       TEXT NOT NULL,
    operator_did        TEXT NOT NULL,
    announcement        TEXT,             -- the post, or null to publish without one
    status              TEXT NOT NULL,    -- proposed|attached|superseded|declined|confirmed|done|failed
    decision_message_id TEXT,
    reply               TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS dispatch_publish_dm_idx ON dispatch_publish (dm_message_id, status);

  -- A fix to an issue that is already live, proposed by Poe in an operator DM
  -- and made only on the operator's yes to the DM that showed it.
  CREATE TABLE IF NOT EXISTS dispatch_correction (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id            TEXT NOT NULL,
    base_version        INTEGER NOT NULL,  -- the published version it changes
    dm_message_id       TEXT NOT NULL,
    operator_did        TEXT NOT NULL,
    changes             TEXT NOT NULL,     -- JSON: { edits, title, description }, as shown to the operator
    title               TEXT NOT NULL,
    description         TEXT,
    markdown            TEXT NOT NULL,
    record              TEXT NOT NULL,     -- JSON: the corrected document, less publishedAt and path
    status              TEXT NOT NULL,     -- proposed|attached|superseded|declined|confirmed|done|failed
    decision_message_id TEXT,
    reply               TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS dispatch_correction_dm_idx ON dispatch_correction (dm_message_id, status);

  -- DMs Poe starts rather than answers ("your draft is ready"). One per draft and kind.
  CREATE TABLE IF NOT EXISTS dispatch_outbox (
    draft_id     TEXT NOT NULL,
    kind         TEXT NOT NULL,           -- ready | failed
    operator_did TEXT NOT NULL,
    text         TEXT NOT NULL,
    status       TEXT NOT NULL,           -- pending | sending | sent | failed
    convo_id     TEXT,
    parts_sent   INTEGER NOT NULL DEFAULT 0,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (draft_id, kind)
  );
`);

const DAY_MS = 24 * 3600 * 1000;
const ASK_ATTEMPTS = 3;
const OUTBOX_ATTEMPTS = 5;
const SAVES_PER_DRAFTING = 40;
const CALLS_PER_DM = 15;
const MAX_RECORD_BYTES = 400 * 1024;
const NOTE_GRAPHEMES = 900;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const DRAFT_ID = /^dd-[A-Za-z0-9-]{8,48}$/;
const LIVE = ['asking', 'drafting', 'ready', 'publishing'];
// A correction is for a typo or a wrong name, small enough to show whole in the DM it is approved from.
const CORRECTION_EDITS = 10;
const CORRECTION_CHARS = 1500;

function draftEvent(draftId, kind, detail = null) {
  db.prepare(`INSERT INTO dispatch_event (issue, document_uri, kind, detail, created_at) VALUES (?, NULL, ?, ?, ?)`)
    .run(draftId, kind, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), nowIso());
}

export const getDraft = (id) => db.prepare('SELECT * FROM dispatch_draft WHERE id = ?').get(id);

/** The draft in front of the operator now: the newest one still being written, read or published. */
export function currentDraft() {
  return db.prepare(`SELECT * FROM dispatch_draft WHERE status IN (${LIVE.map(() => '?').join(', ')})
    ORDER BY created_at DESC LIMIT 1`).get(...LIVE) ?? null;
}

export const previewUrl = (draft) => `${config.dispatch.drafts.previewUrlBase}/${draft.preview_token}`;

const enabled = () => config.dispatch.drafts.mode !== 'off' && config.dispatch.enabled;

// --- when a draft is due --------------------------------------------------------

/** The newest weekly slot at or before `nowMs`: DISPATCH_DRAFT_DAY at DISPATCH_DRAFT_HOUR_UTC. */
export function weeklySlot(nowMs, { day, hour } = config.dispatch.drafts) {
  const d = new Date(nowMs);
  let slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
  while (new Date(slot).getUTCDay() !== day || slot > nowMs) slot -= DAY_MS;
  return slot;
}

/**
 * What an issue ending at `endMs` covers: from the last issue, when that was a
 * day to two weeks ago, else the seven days before.
 */
export function draftWindow(endMs, latest) {
  const last = Date.parse(latest?.publishedAt ?? '');
  const start = Number.isFinite(last) && last < endMs - DAY_MS && last > endMs - 14 * DAY_MS ? last : endMs - 7 * DAY_MS;
  return { start: new Date(start).toISOString(), end: new Date(endMs).toISOString() };
}

// --- asking for a draft ----------------------------------------------------------

/**
 * Start a draft. Returns { started, draft, reason }. One is written at a time;
 * a new one replaces a draft still waiting for review (it is kept, as superseded).
 */
export async function startDraft({ kind, operatorDid, guidance = null, id = null, nowMs }, deps = defaultDeps) {
  const busy = db.prepare(`SELECT * FROM dispatch_draft WHERE status IN ('asking', 'drafting', 'publishing')
    ORDER BY created_at DESC LIMIT 1`).get();
  if (busy) return { started: false, draft: busy, reason: busy.status === 'publishing' ? 'publishing' : 'drafting' };
  let latest = null;
  try { latest = await deps.latestIssue(); }
  catch (err) { logger.warn('dispatch draft: latest issue unreadable', { error: err.message }); }
  const window = draftWindow(nowMs, latest);
  const draftId = id ?? `dd-${new Date(nowMs).toISOString().slice(0, 16).replace(/[-:]/g, '')}-${randomBytes(2).toString('hex')}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE dispatch_draft SET status = 'superseded', updated_at = ? WHERE status = 'ready'`).run(nowIso());
    db.prepare(`UPDATE dispatch_publish SET status = 'superseded', decided_at = ? WHERE status IN ('proposed', 'attached')`).run(nowIso());
    db.prepare(`INSERT INTO dispatch_draft (id, kind, window_start, window_end, guidance, operator_did, status, preview_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'asking', ?, ?, ?)`)
      .run(draftId, kind, window.start, window.end, guidance, operatorDid, randomBytes(18).toString('base64url'), nowIso(), nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  draftEvent(draftId, 'draft_started', { kind, window });
  const draft = getDraft(draftId);
  await askAgent(draft, latest, deps);
  return { started: true, draft: getDraft(draftId) };
}

/** Hand the draft to the agent. A failure is retried on the next tick, then given up on. */
async function askAgent(draft, latest, deps) {
  const body = {
    draftId: draft.id,
    windowStart: draft.window_start,
    windowEnd: draft.window_end,
    ...(latest?.rkey ? { lastIssue: { title: latest.title, url: pageUrls(latest.rkey)[0], publishedAt: latest.publishedAt ?? null } } : {}),
    ...(draft.guidance ? { guidance: draft.guidance } : {}),
  };
  db.prepare('UPDATE dispatch_draft SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(nowIso(), draft.id);
  try {
    const status = await deps.askAgent(body);
    if (status < 200 || status >= 300) throw new Error(`the agent answered ${status}`);
    db.prepare(`UPDATE dispatch_draft SET status = 'drafting', asked_at = ?, detail = NULL, updated_at = ?
      WHERE id = ? AND status = 'asking'`).run(nowIso(), nowIso(), draft.id);
    draftEvent(draft.id, 'asked');
    logger.info('dispatch draft asked for', { draftId: draft.id });
  } catch (err) {
    const row = getDraft(draft.id);
    logger.warn('dispatch draft: asking the agent failed', { draftId: draft.id, attempt: row.attempts, error: err.message });
    db.prepare('UPDATE dispatch_draft SET detail = ?, updated_at = ? WHERE id = ?').run(err.message, nowIso(), draft.id);
    if (row.attempts >= ASK_ATTEMPTS) {
      failDraft(row, `i couldn't reach my writing desk (${err.message})`);
    }
  }
}

function failDraft(draft, why) {
  db.prepare(`UPDATE dispatch_draft SET status = 'failed', detail = ?, updated_at = ? WHERE id = ?`).run(why, nowIso(), draft.id);
  draftEvent(draft.id, 'failed', why);
  queueDm(draft, 'failed', [
    `i couldn't write ${draft.kind === 'weekly' ? "this week's" : 'the'} dispatch (╥﹏╥) ${why}.`,
    '',
    'send "draft dispatch" and i\'ll try again.',
  ].join('\n'));
}

// --- saves from the agent -----------------------------------------------------------

// Card lookups are slow and the same links come back on every save, so each is
// remembered for a few hours.
const cardCache = new Map();
const CARD_TTL_MS = 6 * 3600 * 1000;

function cachedDeps(deps) {
  const memo = (kind, fn) => async (...args) => {
    const key = `${kind}:${args.join('|')}`;
    const hit = cardCache.get(key);
    if (hit && Date.now() - hit.at < CARD_TTL_MS) return hit.value;
    const value = await fn(...args);
    cardCache.set(key, { at: Date.now(), value });
    if (cardCache.size > 500) cardCache.delete(cardCache.keys().next().value);
    return value;
  };
  return { resolvePost: memo('post', deps.resolvePost), fetchPageMeta: memo('page', deps.fetchPageMeta) };
}

/** Apply find/replace edits to markdown. Each find must be in it exactly once. */
export function applyEdits(markdown, edits) {
  let out = markdown;
  for (const [i, edit] of edits.entries()) {
    const at = out.indexOf(edit.find);
    if (at < 0) return { problem: `edit ${i + 1}: "${clip(edit.find)}" isn't in the draft; read it again and copy the text exactly` };
    if (out.indexOf(edit.find, at + 1) >= 0) {
      return { problem: `edit ${i + 1}: "${clip(edit.find)}" is in the draft more than once; include more of the text around it` };
    }
    out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length);
  }
  return { markdown: out };
}

const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

function validEdits(edits) {
  return Array.isArray(edits) && edits.length >= 1 && edits.length <= 30 && edits.every((e) =>
    e && typeof e === 'object' && typeof e.find === 'string' && e.find.length >= 1 && e.find.length <= 10000 &&
    typeof e.replace === 'string' && e.replace.length <= 30000);
}

/** Who is calling, from the fields the agent's tool took from its channel's auth. */
function callerOf(body) {
  if (typeof body.draftingId === 'string') {
    if (!DRAFT_ID.test(body.draftingId)) return null;
    return { kind: 'drafting', draftId: body.draftingId };
  }
  if (typeof body.dmId === 'string' && body.dmId && body.dmId.length <= 300 &&
      typeof body.operatorDid === 'string' && /^did:(plc|web):[^\s]{1,290}$/.test(body.operatorDid)) {
    return { kind: 'dm', dmId: body.dmId, operatorDid: body.operatorDid };
  }
  return null;
}

const callCounts = new Map();
function overBudget(key, limit) {
  const n = (callCounts.get(key) ?? 0) + 1;
  callCounts.set(key, n);
  if (callCounts.size > 500) callCounts.delete(callCounts.keys().next().value);
  return n > limit;
}

/** The draft as Poe reads it. */
function readable(draft) {
  return {
    id: draft.id,
    status: draft.status,
    version: draft.version,
    windowStart: draft.window_start,
    windowEnd: draft.window_end,
    ...(draft.guidance ? { guidance: draft.guidance } : {}),
    title: draft.title ?? '',
    description: draft.description ?? '',
    tags: draft.tags ? JSON.parse(draft.tags) : [],
    markdown: draft.markdown ?? '',
    notes: draft.notes ? JSON.parse(draft.notes) : [],
    preview: previewUrl(draft),
    ...(draft.document_rkey && draft.status === 'published' ? { published: pageUrls(draft.document_rkey)[0] } : {}),
  };
}

// One save at a time per draft: a save looks cards up between reading the
// draft and writing the next version.
const saving = new Map();
function serial(key, fn) {
  const next = (saving.get(key) ?? Promise.resolve()).then(fn, fn);
  saving.set(key, next);
  const clear = () => { if (saving.get(key) === next) saving.delete(key); };
  next.then(clear, clear);
  return next;
}

async function save(draft, input, savedBy, deps) {
  return serial(draft.id, async () => {
    const fresh = getDraft(draft.id);
    if (fresh.status !== draft.status) return { accepted: false, reason: `the draft is ${fresh.status} now` };
    let markdown;
    if (typeof input.markdown === 'string') markdown = input.markdown;
    else if (input.edits != null) {
      if (!fresh.markdown) return { accepted: false, reason: 'there is nothing to edit yet; save the whole issue as markdown first' };
      const edited = applyEdits(fresh.markdown, input.edits);
      if (edited.problem) return { accepted: false, reason: edited.problem };
      markdown = edited.markdown;
    } else markdown = fresh.markdown ?? '';
    if (markdown.length > MAX_MARKDOWN_CHARS) {
      return { accepted: false, reason: `the issue is ${markdown.length} characters; ${MAX_MARKDOWN_CHARS} is the most` };
    }
    const meta = {
      title: input.title ?? fresh.title,
      description: input.description !== undefined ? input.description : fresh.description,
      tags: input.tags !== undefined ? input.tags : (fresh.tags ? JSON.parse(fresh.tags) : []),
    };
    const problems = metaProblems(meta);
    const converted = markdownToBlocks(markdown);
    problems.push(...converted.problems);
    if (problems.length) return { accepted: false, reason: problems.join('; ') };

    const { blocks, notes: cardNotes } = await enrichBlocks(converted.blocks, cachedDeps(deps));
    const record = draftRecord({ ...meta, blocks }, { publicationUri: config.dispatch.publicationUri, authorDid: config.botDid });
    if (recordSize(record) > MAX_RECORD_BYTES) {
      return { accepted: false, reason: `the issue is too big to publish (${Math.round(recordSize(record) / 1024)} KB as a record); make it shorter` };
    }
    const notes = [...converted.notes, ...cardNotes];
    const version = fresh.version + 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO dispatch_draft_version (draft_id, version, title, description, tags, markdown, record, saved_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fresh.id, version, record.title, record.description ?? null,
        JSON.stringify(record.tags ?? []), markdown, JSON.stringify(record), savedBy, nowIso());
      db.prepare(`UPDATE dispatch_draft SET version = ?, title = ?, description = ?, tags = ?, markdown = ?, record = ?,
        notes = ?, updated_at = ? WHERE id = ? AND version = ?`).run(version, record.title, record.description ?? null,
        JSON.stringify(record.tags ?? []), markdown, JSON.stringify(record), JSON.stringify(notes), nowIso(), fresh.id, fresh.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    draftEvent(fresh.id, 'saved', { version, by: savedBy, notes: notes.length });
    const words = record.textContent.split(/\s+/).filter(Boolean).length;
    return {
      accepted: true,
      version,
      preview: previewUrl(fresh),
      words,
      blocks: blocks.length,
      ...(notes.length ? { notes } : {}),
      note: savedBy === 'drafting'
        ? 'saved. the operator sees it once you finish this turn.'
        : 'saved. the preview link goes under your reply.',
    };
  });
}

/**
 * Everything the agent's draft tools ask: { dispatchDraft: { action, ... } } plus
 * the caller (draftingId for the drafting turn; dmId and operatorDid in an
 * operator DM). Answers { status, body }; a check that failed is a 200 with
 * accepted: false and the reason, so Poe can fix it in the same turn.
 */
export async function handleDraftCall(body, deps = defaultDeps) {
  if (!enabled()) return { status: 503, body: { error: 'DispatchDraftsDisabled' } };
  const call = body?.dispatchDraft;
  const caller = body && typeof body === 'object' && !Array.isArray(body) ? callerOf(body) : null;
  if (!caller || !call || typeof call !== 'object' || Array.isArray(call) ||
      !['read', 'save', 'propose_publish', 'start', 'propose_correction'].includes(call.action) ||
      (call.issue != null && (typeof call.issue !== 'string' || call.issue.length > 300)) ||
      (call.title != null && typeof call.title !== 'string') ||
      (call.description != null && typeof call.description !== 'string') ||
      (call.markdown != null && typeof call.markdown !== 'string') ||
      (call.edits != null && !validEdits(call.edits)) ||
      (call.markdown != null && call.edits != null) ||
      (call.announcement != null && (typeof call.announcement !== 'string' || call.announcement.length > 6000)) ||
      (call.guidance != null && (typeof call.guidance !== 'string' || call.guidance.length > 2000))) {
    return { status: 400, body: { error: 'BadRequest' } };
  }

  let draft;
  if (caller.kind === 'drafting') {
    draft = getDraft(caller.draftId);
    if (!draft || !['asking', 'drafting'].includes(draft.status)) return { status: 409, body: { error: 'NotDrafting' } };
    if ((call.action !== 'read' && call.action !== 'save') || call.issue != null) return { status: 403, body: { error: 'OperatorOnly' } };
    if (call.action === 'save' && overBudget(`drafting:${draft.id}`, SAVES_PER_DRAFTING)) {
      return { status: 429, body: { error: 'TooManySaves' } };
    }
  } else {
    // Only while Poe is answering that operator's DM.
    const dm = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(caller.dmId);
    if (!dm || dm.operator_did !== caller.operatorDid || !isAdmin(dm.operator_did) || dm.status !== 'dispatched') {
      return { status: 409, body: { error: 'NotAnsweringThatDm' } };
    }
    if (overBudget(`dm:${caller.dmId}`, CALLS_PER_DM)) return { status: 429, body: { error: 'TooManyCalls' } };
    if (call.action === 'start') return startFromDm(caller, call.guidance ?? null, deps);
    if (call.issue != null || call.action === 'propose_correction') {
      // An issue that is already live: read as published, or corrected.
      if (call.action !== 'read' && call.action !== 'propose_correction') {
        return { status: 200, body: { accepted: false, reason: 'a published issue is never saved over; propose a correction to it instead' } };
      }
      const found = publishedDraft(call.issue ?? 'latest');
      if (!found.draft) return { status: 200, body: { found: false, accepted: false, reason: found.reason } };
      if (call.action === 'read') return { status: 200, body: { found: true, draft: readable(found.draft) } };
      return proposeCorrection(found.draft, call, caller, deps);
    }
    draft = currentDraft();
    if (!draft) {
      const last = db.prepare('SELECT * FROM dispatch_draft ORDER BY created_at DESC LIMIT 1').get();
      return { status: 200, body: {
        found: false, accepted: false,
        reason: last ? `there is no draft in review; the last one (${last.title ?? 'untitled'}) is ${last.status}` +
          (last.status === 'published' ? '. to fix a mistake in it, read it with issue "latest"' : '') : 'there is no draft yet',
        ...(last?.status === 'published' && last.document_rkey ? { published: pageUrls(last.document_rkey)[0] } : {}),
      } };
    }
  }

  if (call.action === 'read') return { status: 200, body: { found: true, draft: readable(draft) } };

  if (call.action === 'save') {
    if (caller.kind === 'dm' && draft.status !== 'ready') {
      return { status: 200, body: { accepted: false, reason: draft.status === 'publishing'
        ? "it's being published right now, so it can't change"
        : "i'm still writing it in my drafting session; edits can wait until it's ready" } };
    }
    if (!draft.version && (typeof call.markdown !== 'string' || !call.title)) {
      return { status: 200, body: { accepted: false, reason: 'the first save needs the whole issue: title and markdown' } };
    }
    const result = await save(draft, call, caller.kind === 'drafting' ? 'drafting' : `dm:${caller.dmId}`, deps);
    return { status: 200, body: result };
  }

  // propose_publish
  if (draft.status !== 'ready') {
    return { status: 200, body: { accepted: false, reason: draft.status === 'publishing' ? 'it is being published already' : "it isn't finished yet" } };
  }
  if (!Number.isInteger(call.version) || call.version !== draft.version) {
    return { status: 200, body: { accepted: false, reason: `the draft is at version ${draft.version}; read it again so you propose what the operator will see` } };
  }
  if (!deps.publisherConfigured()) {
    return { status: 200, body: { accepted: false,
      reason: "the droplet doesn't have atpota.to's app password (DISPATCH_PUBLISHER_APP_PASSWORD), so it can't publish; the operator has to add it first" } };
  }
  if (db.prepare(`SELECT 1 FROM dispatch_correction WHERE dm_message_id = ? AND status = 'proposed'`).get(caller.dmId)) {
    return { status: 200, body: { accepted: false, reason: 'you already proposed a correction in this reply; one proposal per reply, so a yes means one thing' } };
  }
  const announcement = call.announcement?.trim() || null;
  if (announcement) {
    const problem = postTextProblem(announcement, 'newsletter');
    if (problem) return { status: 200, body: { accepted: false, reason: `the announcement: ${problem}` } };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE dispatch_publish SET status = 'superseded', decided_at = ? WHERE status IN ('proposed', 'attached')`).run(nowIso());
    db.prepare(`INSERT INTO dispatch_publish (draft_id, version, dm_message_id, operator_did, announcement, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'proposed', ?)`).run(draft.id, draft.version, caller.dmId, caller.operatorDid, announcement, nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  draftEvent(draft.id, 'publish_proposed', { version: draft.version, dmId: caller.dmId });
  return { status: 200, body: {
    accepted: true, version: draft.version,
    note: 'proposed, not published. the operator sees exactly what happens under your reply, and it is published only if they answer yes.',
  } };
}

async function startFromDm(caller, guidance, deps) {
  const result = await startDraft({ kind: 'asked', operatorDid: caller.operatorDid, guidance, nowMs: deps.now() }, deps);
  if (!result.started) {
    return { status: 200, body: { accepted: false, reason: result.reason === 'publishing'
      ? 'an issue is being published right now; ask again once it is out'
      : `a draft is already being written (started ${minutesAgo(result.draft.created_at, deps.now())})` } };
  }
  return { status: 200, body: {
    accepted: result.draft.status === 'drafting',
    ...(result.draft.status === 'drafting'
      ? { note: 'started. a separate session of yours researches and writes it, then DMs the operator the preview.' }
      : { reason: `asking for the draft failed (${result.draft.detail}); it is retried every few minutes` }),
  } };
}

function minutesAgo(iso, nowMs) {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : `${Math.round(m / 60)} hours ago`;
}

// --- the drafting turn ends --------------------------------------------------------

/**
 * The drafting turn's last message, on the callback URL:
 * { key, dispatchDraftDone: { draftId, text } }. Answers { status, body }.
 */
export function receiveDraftDone(body) {
  const done = body?.dispatchDraftDone;
  if (!body || typeof body.key !== 'string' || !body.key || body.key.length > 500 ||
      !done || typeof done.draftId !== 'string' || !DRAFT_ID.test(done.draftId) ||
      typeof done.text !== 'string' || done.text.length > 20000) {
    return { status: 400, body: { error: 'BadRequest' } };
  }
  const draft = getDraft(done.draftId);
  if (!draft || !['asking', 'drafting'].includes(draft.status)) return { status: 200, body: { ok: true, ignored: true } };
  const claimed = db.prepare(`UPDATE dispatch_draft SET done_key = ?, note = ?, updated_at = ?
    WHERE id = ? AND done_key IS NULL AND status IN ('asking', 'drafting')`).run(body.key, done.text.trim(), nowIso(), draft.id).changes > 0;
  if (!claimed) return { status: 200, body: { ok: true, duplicate: true } };
  settleDrafting(getDraft(draft.id));
  return { status: 200, body: { ok: true } };
}

/** The drafting turn is over: show the draft, or say why there isn't one. */
function settleDrafting(draft, { timedOut = false } = {}) {
  if (draft.version >= 1) {
    db.prepare(`UPDATE dispatch_draft SET status = 'ready', drafted_at = ?, updated_at = ? WHERE id = ? AND status IN ('asking', 'drafting')`)
      .run(nowIso(), nowIso(), draft.id);
    draftEvent(draft.id, 'ready', { version: draft.version, timedOut });
    queueDm(draft, 'ready', readyText(getDraft(draft.id), { timedOut }));
  } else {
    failDraft(draft, timedOut ? 'my writing session ran out of time before i saved anything'
      : `i finished without saving a draft${draft.note ? `. what i said at the end: "${fitPostText(draft.note, 400, 4000)}"` : ''}`);
  }
}

export function readyText(draft, { timedOut = false } = {}) {
  const lines = [
    `${draft.kind === 'weekly' ? "this week's dispatch" : 'the dispatch'} is drafted ✿`,
    '',
    `"${draft.title}"`,
    ...(draft.description ? [draft.description] : []),
    '',
    `preview: ${previewUrl(draft)}`,
  ];
  if (timedOut) lines.push('', "(my writing session ran out of time, so this is the last version i saved.)");
  const note = draft.note?.trim();
  if (note) lines.push('', fitPostText(note, NOTE_GRAPHEMES, 9000));
  lines.push('', "tell me what to change and i'll edit it. when it's ready, tell me to make it live: i'll show you exactly what that does and wait for your yes.");
  return lines.join('\n');
}

// --- DMs Poe starts ------------------------------------------------------------------

function queueDm(draft, kind, text) {
  db.prepare(`INSERT OR IGNORE INTO dispatch_outbox (draft_id, kind, operator_did, text, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(draft.id, kind, draft.operator_did, text, nowIso(), nowIso());
}

/**
 * Send the DMs waiting in the outbox. A send that fails before anything went out
 * is tried again; one that might have gone out is left in `sending` for review,
 * as chat has no idempotency key (the same rule as operator-dm.js).
 */
export async function sendOutbox(deps = defaultDeps) {
  if (config.stage < 4 || killSwitchEngaged() || !config.dmEnabled) return;
  const rows = db.prepare(`SELECT * FROM dispatch_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 5`).all();
  for (const row of rows) {
    if (!isAdmin(row.operator_did)) {
      db.prepare(`UPDATE dispatch_outbox SET status = 'failed', updated_at = ? WHERE draft_id = ? AND kind = ?`).run(nowIso(), row.draft_id, row.kind);
      continue;
    }
    if (!db.prepare(`UPDATE dispatch_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?
      WHERE draft_id = ? AND kind = ? AND status = 'pending'`).run(nowIso(), row.draft_id, row.kind).changes) continue;
    const parts = splitDmText(row.text);
    let sent = row.parts_sent;
    let convoId = row.convo_id;
    try {
      if (!convoId) {
        convoId = (await deps.getDmConvoForMembers([row.operator_did]))?.convo?.id;
        if (typeof convoId !== 'string' || !convoId) throw new Error('no conversation with the operator');
        db.prepare('UPDATE dispatch_outbox SET convo_id = ? WHERE draft_id = ? AND kind = ?').run(convoId, row.draft_id, row.kind);
      }
    } catch (err) {
      // Nothing was sent: safe to try again on the next tick.
      const failed = row.attempts + 1 >= OUTBOX_ATTEMPTS;
      db.prepare(`UPDATE dispatch_outbox SET status = ?, updated_at = ? WHERE draft_id = ? AND kind = ?`)
        .run(failed ? 'failed' : 'pending', nowIso(), row.draft_id, row.kind);
      logger.warn('dispatch DM: no conversation yet', { draftId: row.draft_id, kind: row.kind, error: err.message, failed });
      continue;
    }
    try {
      for (; sent < parts.length; sent++) {
        await deps.sendDmMessage(convoId, null, parts[sent]);
        db.prepare('UPDATE dispatch_outbox SET parts_sent = ?, updated_at = ? WHERE draft_id = ? AND kind = ?')
          .run(sent + 1, nowIso(), row.draft_id, row.kind);
      }
      db.prepare(`UPDATE dispatch_outbox SET status = 'sent', updated_at = ? WHERE draft_id = ? AND kind = ?`).run(nowIso(), row.draft_id, row.kind);
      draftEvent(row.draft_id, `dm_${row.kind}`);
      logger.info('dispatch DM sent', { draftId: row.draft_id, kind: row.kind, parts: parts.length });
    } catch (err) {
      logger.error('dispatch DM send uncertain; manual review required', {
        draftId: row.draft_id, kind: row.kind, part: sent + 1, parts: parts.length, error: err.message,
      });
    }
  }
}

// --- under Poe's DM reply ---------------------------------------------------------------

export function publishBlock(proposal, draft) {
  const sites = DISPATCH_PAGE_BASES.map((u) => u.replace(/^https:\/\//, '')).join(' and ');
  return [
    `here's what making "${draft.title}" live does (version ${proposal.version}, the one at ${previewUrl(draft)}):`,
    '',
    `1. it's published as a new issue on ${sites}, and leaflet emails it to every subscriber. that can't be taken back.`,
    proposal.announcement
      ? '2. i post this from poe, with the issue\'s card:\n\n' + proposal.announcement
      : '2. no announcement post: i only publish it.',
    '',
    'reply "yes" to make it live, or "no" to keep it a draft.',
  ].join('\n');
}

/**
 * Called when Poe's reply to an operator DM arrives. Adds what that turn did to
 * the draft: the preview link when it saved a version, and the publish steps
 * when it proposed making it live. Returns { text, proposal } or null.
 */
export function attachDraftReply(dmId, reply, maxGraphemes = 999) {
  if (!enabled()) return null;
  const saved = db.prepare(`SELECT v.version AS saved_version, d.preview_token FROM dispatch_draft_version v
    JOIN dispatch_draft d ON d.id = v.draft_id WHERE v.saved_by = ? ORDER BY v.version DESC LIMIT 1`).get(`dm:${dmId}`);
  const proposal = db.prepare(`SELECT * FROM dispatch_publish WHERE dm_message_id = ? AND status = 'proposed'
    ORDER BY id DESC LIMIT 1`).get(dmId);
  const correction = db.prepare(`SELECT * FROM dispatch_correction WHERE dm_message_id = ? AND status = 'proposed'
    ORDER BY id DESC LIMIT 1`).get(dmId);
  if (!saved && !proposal && !correction) return null;
  const extra = [];
  if (saved) extra.push(`preview (version ${saved.saved_version}): ${previewUrl(saved)}`);
  if (proposal) {
    db.prepare(`UPDATE dispatch_publish SET status = 'attached' WHERE id = ? AND status = 'proposed'`).run(proposal.id);
    extra.push(publishBlock(proposal, getDraft(proposal.draft_id)));
  } else if (correction) {
    db.prepare(`UPDATE dispatch_correction SET status = 'attached' WHERE id = ? AND status = 'proposed'`).run(correction.id);
    extra.push(correctionBlock(correction, getDraft(correction.draft_id)));
  }
  const block = extra.join('\n\n');
  // The reply is cut to make room; the block never is.
  const room = maxGraphemes - graphemeLength(block) - 2;
  const head = reply.trim() && room > 20 ? fitPostText(reply.trim(), room, 9000) : '';
  return { text: head ? `${head}\n\n${block}` : block, proposal: !!(proposal || correction) };
}

/** The publish proposal an operator's message can answer, or null (see answersProposal). */
export function livePublishFor(row) {
  if (!enabled()) return null;
  const proposal = db.prepare(`SELECT * FROM dispatch_publish WHERE status = 'attached' ORDER BY id DESC LIMIT 1`).get();
  return answersProposal(proposal, row) ? proposal : null;
}

/** Settle a publish proposal with the operator's answer. False if it was no longer live. */
export function decidePublish(id, decision, messageId) {
  const changed = db.prepare(`UPDATE dispatch_publish SET status = ?, decision_message_id = ?, decided_at = ?
    WHERE id = ? AND status = 'attached'`).run(decision === 'yes' ? 'confirmed' : 'declined', messageId, nowIso(), id).changes > 0;
  if (changed) {
    const p = db.prepare('SELECT draft_id FROM dispatch_publish WHERE id = ?').get(id);
    draftEvent(p.draft_id, `publish_${decision === 'yes' ? 'confirmed' : 'declined'}`, { messageId });
  }
  return changed;
}

// --- publishing ---------------------------------------------------------------------------

/**
 * Publish the draft the operator said yes to, from their yes message's id.
 * Returns the reply for them. Safe to run again after a crash: the document's
 * key is claimed before it is created and looked up before it is created
 * again, and announce() never posts twice.
 */
export async function publishConfirmed(messageId, deps = defaultDeps) {
  const proposal = db.prepare(`SELECT * FROM dispatch_publish WHERE decision_message_id = ?`).get(messageId);
  if (!proposal) return null;
  if (proposal.status === 'done' || proposal.status === 'failed') return proposal.reply;
  let reply;
  try {
    reply = await publishDraft(proposal, deps);
  } catch (err) {
    logger.error('dispatch publish failed', { draftId: proposal.draft_id, error: err.message });
    draftEvent(proposal.draft_id, 'publish_failed', err.message);
    const draft = getDraft(proposal.draft_id);
    if (draft?.status === 'publishing' && !draft.document_uri) {
      db.prepare(`UPDATE dispatch_draft SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'publishing'`).run(nowIso(), draft.id);
    }
    reply = `publishing failed (${err.message}), so it's still a draft. ask me to make it live again to retry; it won't make two issues.`;
  }
  db.prepare(`UPDATE dispatch_publish SET status = ?, reply = ? WHERE id = ?`)
    .run(getDraft(proposal.draft_id)?.status === 'published' ? 'done' : 'failed', reply, proposal.id);
  return reply;
}

async function publishDraft(proposal, deps) {
  let draft = getDraft(proposal.draft_id);
  if (!draft) return "that draft is gone, so i didn't publish anything.";
  if (draft.status !== 'published') {
    if (config.stage < 4) return `stage is ${config.stage}, so i didn't publish anything.`;
    if (killSwitchEngaged()) return "the kill switch is on, so i didn't publish anything.";
    if (isNapping()) return "i'm napping, so i didn't publish anything. wake me and ask again.";
    if (!deps.publisherConfigured()) return "atpota.to's app password isn't set up here, so i couldn't publish it.";
    if (!['ready', 'publishing'].includes(draft.status) || draft.version !== proposal.version) {
      return `the draft changed after that (it's at version ${draft.version}, ${draft.status}), so i didn't publish. ask me again to see the new one.`;
    }
    db.prepare(`UPDATE dispatch_draft SET status = 'publishing', updated_at = ? WHERE id = ?`).run(nowIso(), draft.id);
    // The key and date are chosen once, so a retry makes the same issue.
    db.prepare(`UPDATE dispatch_draft SET document_rkey = COALESCE(document_rkey, ?), published_at = COALESCE(published_at, ?),
      updated_at = ? WHERE id = ?`).run(nextTid(deps.now()), new Date(deps.now()).toISOString(), nowIso(), draft.id);
    draft = getDraft(draft.id);
    const rkey = draft.document_rkey;
    const version = db.prepare('SELECT * FROM dispatch_draft_version WHERE draft_id = ? AND version = ?').get(draft.id, proposal.version);
    let doc = await deps.getDocument(rkey);
    if (!doc) {
      const record = { ...JSON.parse(version.record), path: `/${rkey}`, publishedAt: draft.published_at };
      try {
        await deps.createDocument(rkey, record);
      } catch (err) {
        // It may have been written even so. Look before saying it wasn't.
        doc = await deps.getDocument(rkey).catch(() => null);
        if (!doc) throw err;
      }
      doc ??= await deps.getDocument(rkey);
      if (!doc) throw new Error('the document was written but cannot be read back yet');
      draftEvent(draft.id, 'document_created', { rkey });
      logger.info('dispatch issue published', { draftId: draft.id, uri: doc.uri });
    }
    db.prepare(`UPDATE dispatch_draft SET status = 'published', document_uri = ?, document_cid = ?, updated_at = ? WHERE id = ?`)
      .run(doc.uri, doc.cid, nowIso(), draft.id);
    draft = getDraft(draft.id);
  }

  const [page, other] = pageUrls(draft.document_rkey);
  const lines = [`it's live ⸜(｡˃ ᵕ ˂ )⸝ ${page}`, `(and ${other}). leaflet emails it to subscribers within a few minutes.`];
  if (proposal.announcement) {
    const announced = await deps.announce({ rkey: draft.document_rkey, text: proposal.announcement });
    lines.push('', announced);
  }
  return lines.join('\n');
}

// --- correcting an issue that's live ------------------------------------------------------
//
// The issue's markdown stays on its draft after it's published, so a typo is
// fixed the way a draft is edited: find/replace edits, turned into the record
// here. The operator's yes puts that record over the live one, with swapRecord,
// keeping its path, publishedAt and bskyPostRef. Leaflet emails subscribers
// only when it sees a document created, so a put sends nothing; but a put inside
// its first few minutes could stop that first email, so none is made before
// DISPATCH_LEAFLET_SETTLE_MS has passed. Only issues Poe published here can be
// corrected: one published another way has no markdown to edit.

const LATEST = /^(?:the\s+)?(?:latest|last|newest)(?:\s+(?:dispatch|issue|one))?$/i;

/** A published issue Poe wrote, by "latest", its link or its record key: { draft } or { reason }. */
export function publishedDraft(issue) {
  const name = String(issue).trim();
  const latest = LATEST.test(name);
  const rkey = latest ? null : parseIssueLink(name) ?? (/^[a-z2-7]{13}$/.test(name) ? name : null);
  if (!latest && !rkey) return { reason: 'name the issue as "latest", or by its link' };
  const draft = latest
    ? db.prepare(`SELECT * FROM dispatch_draft WHERE status = 'published' ORDER BY published_at DESC LIMIT 1`).get()
    : db.prepare(`SELECT * FROM dispatch_draft WHERE status = 'published' AND document_rkey = ?`).get(rkey);
  if (draft) return { draft };
  return { reason: latest
    ? "i haven't published an issue from one of my drafts yet, so there's none i can correct"
    : "that issue wasn't published from one of my drafts, so i can't correct it: only issues i wrote and published here can be" };
}

/** Text the operator reads: what each correction shows, counted as they'll see it. */
function correctionLength({ edits = [], title, description }) {
  return edits.reduce((n, e) => n + graphemeLength(e.find) + graphemeLength(e.replace), 0) +
    graphemeLength(title ?? '') + graphemeLength(description ?? '');
}

async function proposeCorrection(draft, call, caller, deps) {
  const no = (reason) => ({ status: 200, body: { accepted: false, reason } });
  if (!Number.isInteger(call.version) || call.version !== draft.version) {
    return no(`the issue is at version ${draft.version}; read it again so you propose a change to what's live`);
  }
  if (!deps.publisherConfigured()) {
    return no("the droplet doesn't have atpota.to's app password (DISPATCH_PUBLISHER_APP_PASSWORD), so it can't change the issue");
  }
  const settled = Date.parse(draft.published_at) + config.dispatch.leafletSettleMs;
  if (deps.now() < settled) {
    return no(`it went out ${minutesAgo(draft.published_at, deps.now())} and leaflet may still be emailing it; a change now could ` +
      `stop that email, so propose it again in ${Math.ceil((settled - deps.now()) / 60000)} minutes`);
  }
  if (db.prepare(`SELECT 1 FROM dispatch_publish WHERE dm_message_id = ? AND status = 'proposed'`).get(caller.dmId)) {
    return no('you already proposed making a draft live in this reply; one proposal per reply, so a yes means one thing');
  }
  const edits = call.edits ?? [];
  if (!edits.length && call.title == null && call.description == null) return no('give the edits, or a new title or description');
  const changes = { edits, ...(call.title != null ? { title: call.title } : {}), ...(call.description != null ? { description: call.description } : {}) };
  if (edits.length > CORRECTION_EDITS || correctionLength(changes) > CORRECTION_CHARS) {
    return no(`a correction is for small fixes: at most ${CORRECTION_EDITS} edits and ${CORRECTION_CHARS} characters in all, ` +
      'so the operator can read every change in the DM. send the most important ones');
  }
  const edited = edits.length ? applyEdits(draft.markdown, edits) : { markdown: draft.markdown };
  if (edited.problem) return no(edited.problem.replace("isn't in the draft", "isn't in the issue").replace('in the draft', 'in the issue'));
  const meta = {
    title: call.title ?? draft.title,
    description: call.description != null ? call.description : draft.description,
    tags: draft.tags ? JSON.parse(draft.tags) : [],
  };
  const problems = metaProblems(meta);
  const converted = markdownToBlocks(edited.markdown);
  problems.push(...converted.problems);
  if (problems.length) return no(problems.join('; '));
  if (edited.markdown === draft.markdown && meta.title.trim() === draft.title &&
      (meta.description?.trim() || null) === (draft.description || null)) {
    return no('that changes nothing in the issue');
  }
  const { blocks, notes } = await enrichKeeping(converted.blocks, draft, deps);
  const record = draftRecord({ ...meta, blocks }, { publicationUri: config.dispatch.publicationUri, authorDid: config.botDid });
  if (recordSize(record) > MAX_RECORD_BYTES) return no(`the corrected issue is too big (${Math.round(recordSize(record) / 1024)} KB as a record)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE dispatch_correction SET status = 'superseded', decided_at = ? WHERE status IN ('proposed', 'attached')`).run(nowIso());
    db.prepare(`INSERT INTO dispatch_correction (draft_id, base_version, dm_message_id, operator_did, changes, title, description,
      markdown, record, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`)
      .run(draft.id, draft.version, caller.dmId, caller.operatorDid, JSON.stringify(changes), record.title,
        record.description ?? null, edited.markdown, JSON.stringify(record), nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  draftEvent(draft.id, 'correction_proposed', { version: draft.version, dmId: caller.dmId, edits: edits.length });
  return { status: 200, body: {
    accepted: true, version: draft.version,
    ...(notes.length ? { notes } : {}),
    note: 'proposed, not changed. the operator sees each change under your reply, and the live issue changes only if they answer yes.',
  } };
}

/**
 * Fill in link cards for a corrected issue, keeping every block the edits left
 * alone exactly as published: an untouched card isn't looked up again, so a
 * page that changed its title since doesn't change the issue.
 */
async function enrichKeeping(blocks, draft, deps) {
  const before = markdownToBlocks(draft.markdown ?? '').blocks;
  const kept = JSON.parse(draft.record ?? '{}').content?.pages?.[0]?.blocks ?? [];
  const known = new Map();
  if (before.length === kept.length) before.forEach((b, i) => known.set(JSON.stringify(b), kept[i]));
  const fresh = blocks.filter((b) => !known.has(JSON.stringify(b)));
  const filled = await enrichBlocks(fresh, cachedDeps(deps));
  let n = 0;
  return { blocks: blocks.map((b) => known.get(JSON.stringify(b)) ?? filled.blocks[n++]), notes: filled.notes };
}

export function correctionBlock(correction, draft) {
  const changes = JSON.parse(correction.changes);
  const sites = DISPATCH_PAGE_BASES.map((u) => u.replace(/^https:\/\//, '')).join(' and ');
  const lines = [`here's the fix to "${draft.title}", live at ${pageUrls(draft.document_rkey)[0]}:`, ''];
  for (const e of changes.edits ?? []) lines.push(`- "${e.find}" becomes ${e.replace ? `"${e.replace}"` : 'nothing (deleted)'}`);
  if (changes.title != null) lines.push(`- the title becomes "${correction.title}"`);
  if (changes.description != null) {
    lines.push(correction.description ? `- the description becomes "${correction.description}"` : '- the description is removed');
  }
  lines.push('', `it changes the issue on ${sites}. nobody is emailed again: subscribers keep the email they already got.`);
  if (changes.title != null || changes.description != null) lines.push("a post that already links it keeps its old card.");
  lines.push('', 'reply "yes" to fix it, or "no" to leave it as it is.');
  return lines.join('\n');
}

/** The correction an operator's message can answer, or null (see answersProposal). */
export function liveCorrectionFor(row) {
  if (!enabled()) return null;
  const correction = db.prepare(`SELECT * FROM dispatch_correction WHERE status = 'attached' ORDER BY id DESC LIMIT 1`).get();
  return answersProposal(correction, row) ? correction : null;
}

/** Settle a correction with the operator's answer. False if it was no longer live. */
export function decideCorrection(id, decision, messageId) {
  const changed = db.prepare(`UPDATE dispatch_correction SET status = ?, decision_message_id = ?, decided_at = ?
    WHERE id = ? AND status = 'attached'`).run(decision === 'yes' ? 'confirmed' : 'declined', messageId, nowIso(), id).changes > 0;
  if (changed) {
    const c = db.prepare('SELECT draft_id FROM dispatch_correction WHERE id = ?').get(id);
    draftEvent(c.draft_id, `correction_${decision === 'yes' ? 'confirmed' : 'declined'}`, { messageId });
  }
  return changed;
}

/**
 * Make the correction the operator said yes to, from their yes message's id.
 * Returns the reply for them, or null when no correction waits on that yes.
 * Safe to run again: a put that went through is recognised on the live record.
 */
export async function correctionConfirmed(messageId, deps = defaultDeps) {
  const correction = db.prepare('SELECT * FROM dispatch_correction WHERE decision_message_id = ?').get(messageId);
  if (!correction) return null;
  if (correction.status === 'done' || correction.status === 'failed') return correction.reply;
  if (correction.status !== 'confirmed') return null;
  let reply;
  let done = false;
  try {
    ({ reply, done } = await applyCorrection(correction, deps));
  } catch (err) {
    logger.error('dispatch correction failed', { draftId: correction.draft_id, error: err.message });
    draftEvent(correction.draft_id, 'correction_failed', err.message);
    reply = `the fix didn't go through (${err.message}), so the issue is as it was. ask me again to retry.`;
  }
  db.prepare('UPDATE dispatch_correction SET status = ?, reply = ? WHERE id = ?').run(done ? 'done' : 'failed', reply, correction.id);
  return reply;
}

// Leaflet's fields and ours, compared whatever order the PDS gives the keys in.
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const CONTENT_FIELDS = ['title', 'description', 'tags', 'textContent', 'content'];
const sameContent = (a, b) => CONTENT_FIELDS.every((f) => canonical(a?.[f]) === canonical(b?.[f]));

async function applyCorrection(correction, deps) {
  const draft = getDraft(correction.draft_id);
  const fail = (reply) => ({ reply, done: false });
  if (!draft || draft.status !== 'published' || !draft.document_rkey) return fail("that issue isn't published from here any more, so i changed nothing.");
  if (config.stage < 4) return fail(`stage is ${config.stage}, so i changed nothing.`);
  if (killSwitchEngaged()) return fail('the kill switch is on, so i changed nothing.');
  if (isNapping()) return fail("i'm napping, so i changed nothing. wake me and ask again.");
  if (!deps.publisherConfigured()) return fail("atpota.to's app password isn't set up here, so i couldn't change the issue.");
  const rkey = draft.document_rkey;
  const [page] = pageUrls(rkey);
  const fixed = { reply: `fixed ✿ ${page} has it now (the page can take up to five minutes to catch up). nobody was emailed again.`, done: true };
  // Made already, by a run a restart cut off before it could answer.
  if (db.prepare('SELECT 1 FROM dispatch_draft_version WHERE draft_id = ? AND saved_by = ?')
    .get(draft.id, `correction:${correction.decision_message_id}`)) return fixed;
  if (draft.version !== correction.base_version) {
    return fail(`the issue changed after that (it's at version ${draft.version} now), so i didn't apply it. ask me again to see the fix on top of the new one.`);
  }
  if (deps.now() < Date.parse(draft.published_at) + config.dispatch.leafletSettleMs) {
    return fail("leaflet may still be emailing it, and a change now could stop that email. ask me again in a few minutes.");
  }
  const published = JSON.parse(draft.record);
  const corrected = JSON.parse(correction.record);
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = await deps.getDocument(rkey);
    if (!live) return fail(`i couldn't find the issue at ${page}, so i changed nothing.`);
    let cid = live.cid;
    if (!sameContent(live.value, corrected)) {
      if (!sameContent(live.value, published)) {
        draftEvent(draft.id, 'correction_refused', 'the live issue differs from what was published');
        return fail("the live issue isn't what i published any more (it was changed somewhere else), so i didn't touch it.");
      }
      // Everything of the live record stays but what the fix changes.
      const record = { ...live.value, title: corrected.title, textContent: corrected.textContent, content: corrected.content, updatedAt: nowIso() };
      for (const f of ['description', 'tags']) {
        if (corrected[f] === undefined) delete record[f];
        else record[f] = corrected[f];
      }
      try {
        cid = (await deps.putDocument(rkey, record, live.cid))?.cid ?? null;
      } catch (err) {
        // Changed since we read it (the announcement's link, say): read it again and try once more.
        if (err.error === 'InvalidSwap' && attempt === 0) { draftEvent(draft.id, 'correction_swap_retry'); continue; }
        // It may have gone through even so. Look before saying it didn't.
        const after = await deps.getDocument(rkey).catch(() => null);
        if (!after || !sameContent(after.value, corrected)) throw err;
        cid = after.cid;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = draft.version + 1;
      db.prepare(`INSERT INTO dispatch_draft_version (draft_id, version, title, description, tags, markdown, record, saved_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(draft.id, version, corrected.title, corrected.description ?? null,
        JSON.stringify(corrected.tags ?? []), correction.markdown, correction.record, `correction:${correction.decision_message_id}`, nowIso());
      db.prepare(`UPDATE dispatch_draft SET version = ?, title = ?, description = ?, markdown = ?, record = ?, document_cid = ?,
        updated_at = ? WHERE id = ? AND version = ?`).run(version, corrected.title, corrected.description ?? null, correction.markdown,
        correction.record, cid ?? draft.document_cid, nowIso(), draft.id, draft.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    draftEvent(draft.id, 'corrected', { version: draft.version + 1, cid });
    logger.info('dispatch issue corrected', { draftId: draft.id, rkey });
    return fixed;
  }
  return fail('the issue kept changing while i tried to fix it. ask me again to retry.');
}

/** Finish what the operator's yes confirmed: making a draft live, or correcting a live issue. */
export async function runConfirmed(messageId, deps = defaultDeps) {
  return (await publishConfirmed(messageId, deps)) ?? correctionConfirmed(messageId, deps);
}

// --- the preview page ---------------------------------------------------------------------

/** GET /dispatch/preview/<token>: the draft for atpota.to/blog/preview/<token>. */
export function previewFor(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return { status: 404, body: { error: 'NotFound' } };
  const draft = db.prepare('SELECT * FROM dispatch_draft WHERE preview_token = ?').get(token);
  if (!draft) return { status: 404, body: { error: 'NotFound' } };
  const savedAt = db.prepare('SELECT created_at FROM dispatch_draft_version WHERE draft_id = ? AND version = ?')
    .get(draft.id, draft.version)?.created_at ?? null;
  return { status: 200, body: {
    draft: {
      status: draft.status,
      version: draft.version,
      savedAt,
      windowStart: draft.window_start,
      windowEnd: draft.window_end,
      ...(draft.status === 'published' && draft.document_rkey ? { published: pageUrls(draft.document_rkey)[0] } : {}),
    },
    record: draft.record ? JSON.parse(draft.record) : null,
  } };
}

// --- "draft dispatch" ------------------------------------------------------------------------

/**
 * Whether an operator DM asks for a draft: "draft dispatch", "draft the
 * dispatch", "write this week's dispatch", ..., with optional guidance on the
 * lines after. Returns { guidance } or null.
 */
export function parseDraftCommand(text) {
  if (typeof text !== 'string') return null;
  const [first, ...rest] = text.trim().split(/\r?\n/);
  if (!/^(?:please\s+)?(?:draft|write|start)\s+(?:(?:the|a|this\s+week'?s|next\s+week'?s|the\s+next)\s+)?(?:dispatch|newsletter|issue)(?:\s+(?:draft|now|please))*[.!]*$/i
    .test(first.trim())) return null;
  return { guidance: rest.join('\n').trim() || null };
}

/** The operator's "draft dispatch": start one and say so. Returns the reply. */
export async function runDraftCommand(row, command, deps = defaultDeps) {
  if (!enabled()) return null;
  const result = await startDraft({ kind: 'asked', operatorDid: row.operator_did, guidance: command.guidance, nowMs: deps.now() }, deps);
  if (!result.started) {
    return result.reason === 'publishing'
      ? "i'm publishing an issue right now. ask me again once it's out."
      : `i'm already writing one (started ${minutesAgo(result.draft.created_at, deps.now())}). i'll dm you when it's ready.`;
  }
  if (result.draft.status !== 'drafting') {
    return `i couldn't get started (${result.draft.detail}). i'll keep trying every few minutes.`;
  }
  return "on it! i'll read through the week, write it up, and dm you the preview when it's ready. it usually takes me a while (◕ᴗ◕✿)";
}

// --- the weekly tick ----------------------------------------------------------------------------

/** One tick: settle drafting turns, retry asks, send DMs, and start the weekly draft when it's due. */
export async function tick(deps = defaultDeps) {
  if (!enabled() || config.stage < 4 || !config.dmEnabled || killSwitchEngaged()) return;
  const nowMs = deps.now();

  for (const draft of db.prepare(`SELECT * FROM dispatch_draft WHERE status IN ('asking', 'drafting')`).all()) {
    if (draft.status === 'asking') {
      let latest = null;
      try { latest = await deps.latestIssue(); } catch { /* the ask goes without it */ }
      await askAgent(draft, latest, deps);
    } else if (nowMs - Date.parse(draft.asked_at ?? draft.created_at) > config.dispatch.drafts.turnTimeoutMs) {
      logger.warn('dispatch draft: drafting turn timed out', { draftId: draft.id, version: draft.version });
      settleDrafting(draft, { timedOut: true });
    }
  }

  if (config.dispatch.drafts.mode === 'on' && !isNapping()) {
    const slot = weeklySlot(nowMs);
    const id = `dd-${new Date(slot).toISOString().slice(0, 10)}`;
    if (nowMs - slot < 20 * 3600 * 1000 && !getDraft(id) && config.adminDids.length) {
      const recent = db.prepare(`SELECT * FROM dispatch_draft WHERE created_at > ? AND status NOT IN ('failed', 'superseded', 'skipped')
        ORDER BY created_at DESC LIMIT 1`).get(new Date(slot - 3 * DAY_MS).toISOString());
      let latest = null;
      try { latest = await deps.latestIssue(); } catch { /* checked again when asked */ }
      const lastAt = Date.parse(latest?.publishedAt ?? '');
      const skip = recent ? `a draft from ${recent.created_at.slice(0, 10)} is ${recent.status}`
        : Number.isFinite(lastAt) && lastAt > slot - 3 * DAY_MS ? `an issue was published on ${latest.publishedAt.slice(0, 10)}` : null;
      if (skip) {
        db.prepare(`INSERT OR IGNORE INTO dispatch_draft (id, kind, window_start, window_end, operator_did, status, preview_token, detail, created_at, updated_at)
          VALUES (?, 'weekly', ?, ?, ?, 'skipped', ?, ?, ?, ?)`).run(id, new Date(slot).toISOString(), new Date(slot).toISOString(),
          config.adminDids[0], randomBytes(18).toString('base64url'), skip, nowIso(), nowIso());
        logger.info('dispatch draft: weekly draft skipped', { id, why: skip });
      } else {
        await startDraft({ kind: 'weekly', operatorDid: config.adminDids[0], id, nowMs }, deps);
      }
    }
  }

  await sendOutbox(deps);
}

export function startDispatchDrafts() {
  const { mode, tickMs } = config.dispatch.drafts;
  if (mode === 'off') return null;
  if (!config.dispatch.enabled || !config.dmEnabled || config.stage < 4) {
    logger.warn('dispatch drafts disabled: needs DISPATCH_ENABLED, OPERATOR_DM_ENABLED and stage 4');
    return null;
  }
  if (!atproto.publisherConfigured()) {
    logger.warn('dispatch drafts: DISPATCH_PUBLISHER_APP_PASSWORD is unset, so drafts can be written but not published');
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (err) { logger.error('dispatch drafts tick failed', { error: err.message }); }
    finally { running = false; }
  };
  const first = setTimeout(run, 30000);
  first.unref?.();
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  logger.info('dispatch drafts on', { mode, day: config.dispatch.drafts.day, hourUtc: config.dispatch.drafts.hour });
  return timer;
}

// --- the network -------------------------------------------------------------------------------

const PAGE_META_BYTES = 1024 * 1024;

/** Whether a URL is a public https page: never an address on this machine or its network. */
export function publicPage(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') &&
    !/^[\d.]+$|^\[|^localhost\.?$|\.localhost\.?$|\.local\.?$|\.internal\.?$|\.lan\.?$|\.home\.arpa\.?$/i.test(u.hostname);
}

/**
 * A page's HTML, for its card. Redirects are followed by hand, at most three, and
 * each hop must be a public https page too, so a link can't bounce the droplet to
 * an address of its own.
 */
async function fetchPublicPage(url) {
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!publicPage(at)) throw new Error('not a public https page');
    const res = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'text/html' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      at = new URL(res.headers.get('location'), at).href;
      continue;
    }
    if (res.status !== 200) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      // The head is all a card needs.
      if (size > PAGE_META_BYTES) { await reader.cancel(); break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('too many redirects');
}

/** A page's title and description for a link card. */
async function fetchPageMeta(url) {
  const html = await fetchPublicPage(url);
  const title = ogContent(html, 'og:title') ?? /<title[^>]*>([^<]{1,500})<\/title>/i.exec(html)?.[1] ?? null;
  const description = ogContent(html, 'og:description') ??
    /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']{1,1000})["']/i.exec(html)?.[1] ?? null;
  const decode = (s) => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') ?? null;
  return { title: decode(title), description: decode(description) };
}

/** A Bluesky post's strong ref, from its bsky.app link's parts. */
async function resolvePost(actor, rkey) {
  const appview = 'https://public.api.bsky.app/xrpc';
  let did = actor;
  if (!/^did:(plc|web):/.test(actor)) {
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(actor)) return null;
    const res = await fetch(`${appview}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    did = (await res.json())?.did;
    if (typeof did !== 'string' || !did.startsWith('did:')) return null;
  }
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  const res = await fetch(`${appview}/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const post = (await res.json())?.posts?.[0];
  return typeof post?.cid === 'string' ? { uri: post.uri, cid: post.cid } : null;
}

export const defaultDeps = {
  now: () => Date.now(),
  async askAgent(body) {
    const res = await fetch(`${config.agentUrl}/dispatch/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return res.status;
  },
  latestIssue: () => latestDocument(dispatchDeps),
  resolvePost,
  fetchPageMeta,
  getDocument: dispatchDeps.getDocument,
  createDocument: (rkey, record) => atproto.createPublisherDocument(rkey, record),
  putDocument: dispatchDeps.putDocument,
  publisherConfigured: () => atproto.publisherConfigured(),
  announce: (args) => announce(args, dispatchDeps),
  getDmConvoForMembers: (members) => atproto.getDmConvoForMembers(members),
  sendDmMessage: (convoId, messageId, text) => atproto.sendDmMessage(convoId, messageId, text),
};
