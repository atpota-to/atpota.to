// operator-posts.js
// Posts the operator asks Poe for in a DM ("post the weather", "tell people about
// the newsletter", anything else), the droplet's half. Poe writes the post and
// proposes it with its propose_post tool, which arrives on the callback URL as
// { dmId, operatorDid, proposal: { text, card } }. The droplet checks the text,
// keeps one live proposal, and shows the exact post, with its card, under Poe's DM
// reply. It is posted only when the operator answers yes to that message, exactly
// as shown: the same confirmation a dispatch announcement has (dispatch.js).
//
// The operator's yes is the approval, so these are not held to the weather posts'
// caps (gates/weather.js). A weather one is recorded with them afterwards (kind
// 'operator'), so the automatic posts keep their distance from it. The kill switch,
// a nap and STAGE below 4 still stop it, and the card is never posted wrong: a
// card whose image doesn't load is no post.

import { config, isAdmin, killSwitchEngaged } from './config.js';
import { db, nowIso } from './db.js';
import { logger } from './logger.js';
import { isNapping } from './nap.js';
import { byteLength, detectHandles, detectLinks, graphemeLength } from './richtext.js';
import {
  answersProposal, buildAnnouncement, cardThumb, defaultDeps as dispatchDeps, fitPostText, nextTid, ogContent, postUrl,
} from './dispatch.js';
import { WEATHER_CARD, freshCardUrl, defaultDeps as weatherDeps } from './weather-posts.js';

db.exec(`
  -- Posts Poe proposed in an operator DM. One is live at a time, and it posts only
  -- on the operator's yes to the DM that showed it.
  CREATE TABLE IF NOT EXISTS operator_post (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_message_id       TEXT NOT NULL,  -- the operator DM Poe was answering
    operator_did        TEXT NOT NULL,
    text                TEXT NOT NULL,  -- exactly what the operator is shown and what posts
    card                TEXT NOT NULL,  -- weather | newsletter | none
    status              TEXT NOT NULL,  -- proposed|attached|superseded|declined|confirmed|posting|posted|failed
    decision_message_id TEXT,
    detail              TEXT,
    post_rkey           TEXT UNIQUE,    -- claimed before posting
    post_uri            TEXT,
    created_at          TEXT NOT NULL,
    decided_at          TEXT,
    posted_at           TEXT
  );
  CREATE INDEX IF NOT EXISTS operator_post_dm_idx ON operator_post (dm_message_id, status);
`);

const POST_MAX_GRAPHEMES = 300;
const POST_MAX_BYTES = 3000;
const CALLS_PER_DM = 10;
const calls = new Map();

/** What each card links, and how the confirmation names it. */
export const CARDS = {
  weather: { url: 'https://atpota.to/weather', name: 'the atmosphere weather report',
    title: 'the atmosphere weather report · atpotato',
    description: "how busy bluesky is right now, how much of the network isn't bluesky at all, and which other apps are writing records, read live from the firehose." },
  newsletter: { url: 'https://atpota.to/blog', name: "poe's atmosphere dispatch",
    title: "poe's atmosphere dispatch",
    description: "a weekly roundup of the atmosphere from poe, atpotato's potato." },
  none: null,
};

/** Why the text can't go out as a post, or null. The reason goes back to Poe to fix. */
export function postTextProblem(text, card) {
  if (!text.trim()) return 'the post text is empty';
  const n = graphemeLength(text);
  if (n > POST_MAX_GRAPHEMES) return `the post is ${n} graphemes and a post holds ${POST_MAX_GRAPHEMES}`;
  if (byteLength(text) > POST_MAX_BYTES) return `the post is over ${POST_MAX_BYTES} bytes`;
  if (detectHandles(text).length) return 'the post @-mentions someone; name people without the @, nobody is pinged by this post';
  if (detectLinks(text).length) {
    return card === 'none'
      ? 'leave the link out: a post without a card can\'t carry one. pick the weather or newsletter card instead'
      : 'leave the link out; the card under the post already links it';
  }
  if (/\*\*|__|\[[^\]]+\]\([^)]+\)|^#{1,6}\s/m.test(text)) return 'the post uses markdown, which Bluesky shows literally';
  return null;
}

/**
 * Poe's proposal from the callback URL. Answers { status, body }; a check that
 * failed is a 200 with accepted: false and the reason, so Poe can fix the post and
 * call again in the same turn.
 */
export function handlePostProposal(body) {
  const p = body?.proposal;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.dmId !== 'string' || !body.dmId || body.dmId.length > 300 ||
      typeof body.operatorDid !== 'string' || !/^did:(plc|web):[^\s]{1,290}$/.test(body.operatorDid) ||
      !p || typeof p !== 'object' || typeof p.text !== 'string' || p.text.length > 6000 ||
      !Object.hasOwn(CARDS, p.card)) {
    return { status: 400, body: { error: 'BadRequest' } };
  }
  // Only while Poe is answering that operator's DM: the agent has been handed it
  // and has not replied yet.
  const dm = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(body.dmId);
  if (!dm || dm.operator_did !== body.operatorDid || !isAdmin(dm.operator_did) || dm.status !== 'dispatched') {
    return { status: 409, body: { error: 'NotAnsweringThatDm' } };
  }
  const n = (calls.get(body.dmId) ?? 0) + 1;
  calls.set(body.dmId, n);
  if (calls.size > 500) calls.delete(calls.keys().next().value);
  if (n > CALLS_PER_DM) return { status: 429, body: { error: 'TooManyProposals' } };

  const text = p.text.trim();
  const problem = postTextProblem(text, p.card);
  if (problem) return { status: 200, body: { accepted: false, reason: problem } };

  db.exec('BEGIN IMMEDIATE');
  try {
    // One live proposal at a time: this one replaces every earlier one.
    db.prepare(`UPDATE operator_post SET status = 'superseded', decided_at = ?
      WHERE status IN ('proposed', 'attached')`).run(nowIso());
    db.prepare(`INSERT INTO operator_post (dm_message_id, operator_did, text, card, status, created_at)
      VALUES (?, ?, ?, ?, 'proposed', ?)`).run(body.dmId, body.operatorDid, text, p.card, nowIso());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logger.info('operator post proposed', { dmId: body.dmId, card: p.card });
  return { status: 200, body: {
    accepted: true, text,
    note: 'proposed, not posted. the operator sees this exact post under your reply and it goes out only if they answer yes.',
  } };
}

/** The block added under Poe's reply. */
export function postConfirmationBlock(proposal) {
  const card = CARDS[proposal.card];
  return [
    card ? `here's the post, with the card for ${card.name} (${card.url}):` : "here's the post, with no card:",
    '',
    proposal.text,
    '',
    'reply "yes" to post it from poe, or "no" to drop it.',
  ].join('\n');
}

/**
 * Called when Poe's reply to a DM arrives. If Poe proposed a post in that turn,
 * returns the reply with the post under it, else null. The reply is cut to make
 * room; the post never is.
 */
export function attachPostProposal(dmId, reply, maxGraphemes = 999) {
  const proposal = db.prepare(`SELECT * FROM operator_post WHERE dm_message_id = ? AND status = 'proposed'
    ORDER BY id DESC LIMIT 1`).get(dmId);
  if (!proposal) return null;
  db.prepare(`UPDATE operator_post SET status = 'attached' WHERE id = ? AND status = 'proposed'`).run(proposal.id);
  const block = postConfirmationBlock(proposal);
  const room = maxGraphemes - graphemeLength(block) - 2;
  const head = reply.trim() && room > 20 ? fitPostText(reply.trim(), room, 9000) : '';
  return head ? `${head}\n\n${block}` : block;
}

/** The proposal an operator's message can answer, or null (dispatch.js answersProposal). */
export function livePostProposalFor(row) {
  const proposal = db.prepare(`SELECT * FROM operator_post WHERE status = 'attached' ORDER BY id DESC LIMIT 1`).get();
  return answersProposal(proposal, row) ? proposal : null;
}

/** Settle a proposal with the operator's answer. False if it was no longer live. */
export function decidePostProposal(id, decision, messageId) {
  return db.prepare(`UPDATE operator_post SET status = ?, decision_message_id = ?, decided_at = ?
    WHERE id = ? AND status = 'attached'`).run(decision === 'yes' ? 'confirmed' : 'declined', messageId, nowIso(), id).changes > 0;
}

export const defaultDeps = {
  fetchPage: dispatchDeps.fetchPage,
  fetchImage: dispatchDeps.fetchImage,
  fetchCard: weatherDeps.fetchCard,
  uploadBlob: dispatchDeps.uploadBlob,
  createPost: dispatchDeps.createPost,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const fail = (id, detail) =>
  db.prepare(`UPDATE operator_post SET status = 'failed', detail = ? WHERE id = ?`).run(detail, id);

/** The card's words and image for a post, or a throw saying why there's no card. */
async function cardFor(name, deps) {
  const card = CARDS[name];
  if (name === 'weather') {
    // The live card, by its own address (weather-posts.js), with one retry: a cold start can be slow.
    let image;
    try {
      image = await deps.fetchCard(freshCardUrl(WEATHER_CARD, 'storm'));
    } catch {
      await deps.sleep(3000);
      image = await deps.fetchCard(freshCardUrl(WEATHER_CARD, 'storm'));
    }
    return { url: card.url, title: card.title, description: card.description, thumb: await deps.uploadBlob(image.bytes, image.mimeType) };
  }
  // The newsletter: the blog's own words and image, read from the page.
  const page = await deps.fetchPage(card.url);
  if (page.status !== 200) throw new Error(`${card.url} answered ${page.status}`);
  const { thumb, note } = await cardThumb(page.html, card.url, deps);
  if (!thumb) throw new Error(note);
  return {
    url: card.url,
    title: ogContent(page.html, 'og:title') || card.title,
    description: ogContent(page.html, 'og:description') || card.description,
    thumb,
  };
}

/**
 * Post a confirmed proposal from Poe's account. Returns the line for Poe's DM
 * reply: the post's link, or why it didn't go out. Never throws.
 */
export async function publishPostProposal(id, deps = defaultDeps) {
  const p = db.prepare('SELECT * FROM operator_post WHERE id = ?').get(id);
  if (p?.status !== 'confirmed') return null;
  if (config.stage < 4 || killSwitchEngaged()) {
    fail(id, 'posting is off');
    return "i didn't post it: posting is switched off right now (the kill switch, or the stage).";
  }
  if (isNapping()) {
    fail(id, 'napping');
    return "i didn't post it: i'm napping. wake me and ask again.";
  }
  let card = null;
  if (CARDS[p.card]) {
    try {
      card = await cardFor(p.card, deps);
    } catch (err) {
      fail(id, `no card: ${err.message}`);
      logger.warn('operator post not posted: no card', { id, card: p.card, error: err.message });
      return `i didn't post it: the card for ${CARDS[p.card].name} isn't loading right now (${err.message}). ask me again in a bit.`;
    }
  }

  // The key first, so a post whose fate a crash leaves unknown can be found under it.
  const rkey = nextTid();
  if (!db.prepare(`UPDATE operator_post SET status = 'posting', post_rkey = ? WHERE id = ? AND status = 'confirmed'`)
    .run(rkey, id).changes) return null;
  const record = card
    ? buildAnnouncement({ text: p.text, pageUrl: card.url, title: card.title, description: card.description, thumb: card.thumb })
    : { $type: 'app.bsky.feed.post', text: p.text, createdAt: nowIso(), langs: ['en'] };
  try {
    const res = await deps.createPost(record, rkey);
    const at = nowIso();
    db.prepare(`UPDATE operator_post SET status = 'posted', post_uri = ?, posted_at = ? WHERE id = ?`).run(res.uri, at, id);
    if (p.card === 'weather') {
      // Counted with the weather posts, so the automatic ones keep their distance (gates/weather.js postGate).
      db.prepare(`INSERT INTO weather_post (kind, subject, facts, status, post_text, post_rkey, post_uri, post_cid,
        posted_at, created_at, updated_at) VALUES ('operator', ?, '{}', 'posted', ?, ?, ?, ?, ?, ?, ?)`)
        .run(`dm:${p.dm_message_id}`, p.text, rkey, res.uri, res.cid, at, at, at);
    }
    logger.info('operator post posted', { id, card: p.card, uri: res.uri });
    return `posted! ${postUrl(res.uri)}`;
  } catch (err) {
    fail(id, err.message);
    logger.error('operator post failed', { id, rkey, error: err.message });
    return `posting failed (${err.message}). it may or may not have gone out, so check my profile before asking again.`;
  }
}
