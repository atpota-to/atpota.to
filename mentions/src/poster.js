// poster.js
// The only path to createRecord. Every outbound gate runs here, on every call,
// including retries -- there is deliberately no "already checked" fast path,
// because the one that skips the gates is the one that posts the bad draft.

import { config, gates, killSwitchEngaged } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import { evaluateOutbound } from './gates/outbound.js';
import { faceRules } from './richtext.js';
import { isNapping, pauseRow } from './nap.js';
import { sendProposedLike } from './likes.js';


// Gates where rewriting could plausibly produce a postable answer.
const RETRYABLE_GATES = new Set([
  'unsourced_link',
  'too_many_links',
  'length_graphemes',
  'length_bytes',
  'markdown',
  'third_party_mention',
  'holding_note',
  'operational_meta',
]);

// Only a failed rewrite of a fixable answer earns a fixed reply. Safety and
// deliberate-silence gates must not turn into a public response.
const FALLBACK_GATES = new Set([
  'unsourced_link', 'too_many_links', 'length_graphemes',
  'length_bytes', 'markdown', 'holding_note', 'operational_meta',
]);
export const FALLBACK_REPLIES = [
  "oopsie! i made a hash brown of that answer. could you ask me again? (◕‿◕;)",
  "oh crumbs, that came out more mashed than helpful. mind giving me another go? (◕﹏◕)",
  "i got my thoughts in a tangle trying to answer that. sorry! could you ask me a smaller piece of it?",
  "oops, i couldn't get that one into a shape i trust. try me again with a narrower question? (◕‿◕)ゞ",
  "my brain went full potato on that one, and not in the useful way. sorry! could you give me another shot?",
];

/** What to tell the model about why its answer was refused. */
function retryNoteFor(verdict) {
  switch (verdict.gate) {
    case 'unsourced_link':
      return `${verdict.detail}. Use a URL exactly as a tool returned it, or name the thing without a link.`;
    case 'too_many_links':
      return `${verdict.detail}. Keep the most useful one or two.`;
    case 'length_graphemes':
    case 'length_bytes':
      return `${verdict.detail}. Say the same thing shorter.`;
    case 'markdown':
      return `${verdict.detail}. Bluesky has no markdown; write plain sentences.`;
    case 'third_party_mention':
      return `${verdict.detail}. Name them without the @, or leave them out.`;
    case 'holding_note':
      return `${verdict.detail}. Finish the lookup in this turn and give the result, or say what you could not verify. Do not promise a later reply.`;
    case 'operational_meta':
      return `${verdict.detail}. Answer the person's original post directly. Never describe your draft, tool calls, likes, proposals, or whether anything was sent.`;
    default:
      return verdict.detail;
  }
}

/**
 * Build the record. `reply` needs root and parent, each a strong ref with both
 * uri and cid. The root comes from the matched post's own reply.root when it is
 * itself a reply, otherwise the matched post is the root -- computed at match
 * time and stored, so this just reads it back. Getting it wrong detaches the
 * reply from the thread in most clients.
 */
export function buildPostRecord(row, text, replyLangs, facets = [], parent = null) {
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    langs: replyLangs.slice(0, 3),      // the lexicon accepts at most 3
    reply: {
      // The root never moves, however many posts the answer takes. Only the
      // parent walks: the first post hangs off the mention, the second off the
      // first, and so on. Pointing a later post at the mention instead would
      // fan the answer out as siblings rather than chaining it.
      root: { uri: row.root_uri, cid: row.root_cid },
      parent: parent ?? { uri: row.parent_uri, cid: row.parent_cid },
    },
  };
  if (facets.length) record.facets = facets;
  return record;
}

/**
 * Gate a draft and, if it passes and we are at stage 4, post it.
 * Returns { posted, gate?, detail?, uri? }.
 */
export async function postReply(row, draft, { allowedLinks = null, fallback = false } = {}) {
  if (isNapping() || db.getQueueRow(row.id)?.status === 'paused') {
    pauseRow(row.id);
    return { posted: false, gate: 'nap' };
  }
  const g = gates();

  // A face only on a short reply, and never two replies running in a thread.
  // The prompt asks for restraint; this is what guarantees it (richtext.js).
  const draftText = faceRules(draft, {
    previousInThread: db.lastReplyTextInThread(row.thread_root),
    maxGraphemes: g.faceMaxGraphemes,
  });
  if (draftText !== draft) logger.info('face left off', { queueId: row.id });

  const verdict = evaluateOutbound(draftText, {
    gates: g,
    botHandle: config.botHandle,
    replyingToDid: row.author_did,
    replyingToHandle: row.author_handle,
    lastReplyText: db.lastReplyTextTo(row.author_did),
    allowedLinks,
    allowedLinkHosts: g.allowedLinkHosts,
    killSwitch: killSwitchEngaged,
  });

  if (!verdict.ok) {
    db.recordRejection(row.id, 'outbound', verdict.gate, verdict.detail, draftText);

    // Some refusals mean the answer was nearly right: a link it trimmed, a post
    // too long, markdown it should not have used. Those are worth one more turn
    // with the reason attached, because the alternative is a person who asked a
    // good question and got silence with no way to tell why.
    //
    // Others are not. non_answer and self_defence are the model deciding not to
    // engage, and asking again is arguing with it. duplicate, kill_switch and
    // empty are not fixable by rewriting.
    if (!fallback && RETRYABLE_GATES.has(verdict.gate) && (row.draft_retries ?? 0) < 1) {
      logger.warn('draft refused; asking for one more attempt', {
        queueId: row.id, gate: verdict.gate, detail: verdict.detail,
      });
      db.rearmForRetry(row.id);
      const { dispatch } = await import('./pipeline.js');
      dispatch(row.id, { dispatched: 0, dispatchErrors: 0 }, retryNoteFor(verdict))
        .catch((err) => logger.error('retry dispatch threw', { queueId: row.id, err }));
      return { posted: false, gate: verdict.gate, detail: verdict.detail, retrying: true };
    }

    if (!fallback && (row.draft_retries ?? 0) >= 1 && FALLBACK_GATES.has(verdict.gate)) {
      logger.warn('rewrite refused; trying fixed fallback through poster', {
        queueId: row.id, gate: verdict.gate, detail: verdict.detail,
      });
      const faceOptions = {
        previousInThread: db.lastReplyTextInThread(row.thread_root),
        maxGraphemes: g.faceMaxGraphemes,
      };
      let index = row.id % FALLBACK_REPLIES.length;
      if (faceRules(FALLBACK_REPLIES[index], faceOptions) === db.lastReplyTextTo(row.author_did)) {
        index = (index + 1) % FALLBACK_REPLIES.length;
      }
      const result = await postReply(row, FALLBACK_REPLIES[index], { fallback: true });
      return { ...result, fallback: true, originalGate: verdict.gate };
    }

    // A non_answer is the agent deciding there was nothing worth saying. The
    // outcome is the same as a rejection -- nothing is posted -- but calling it
    // one puts a correct decision in the same bucket as bad drafts, and that
    // bucket is the eval corpus. `declined` keeps them separable.
    const status = verdict.gate === 'non_answer' ? 'declined' : 'rejected';
    db.setStatus(row.id, status, {
      gate: verdict.gate, gate_detail: verdict.detail, settled_at: db.nowIso(),
    });
    logger.warn('draft rejected', {
      queueId: row.id, gate: verdict.gate, detail: verdict.detail,
      author: row.author_handle ?? row.author_did, draft: draftText,
    });
    return { posted: false, gate: verdict.gate, detail: verdict.detail };
  }

  // Stage is the milestone dial. Below 4 the poster records what it *would*
  // have posted and stops: drafts land in the queue, readable next to the post
  // that prompted them, and nothing reaches the network.
  if (config.stage < 4) {
    logger.info('draft passed all gates; not posting (stage < 4)', {
      queueId: row.id, stage: config.stage, graphemes: verdict.graphemes,
      bytes: verdict.bytes, links: verdict.links.length, posts: verdict.posts.length,
      author: row.author_handle ?? row.author_did, draft: verdict.text,
    });
    db.setStatus(row.id, 'drafted', { settled_at: db.nowIso() });
    return { posted: false, gate: 'stage', detail: `stage ${config.stage} does not post` };
  }

  if (config.dryRun) {
    logger.info('DRY_RUN: would post', { queueId: row.id, draft: verdict.text });
    return { posted: false, gate: 'dry_run', detail: 'DRY_RUN set' };
  }

  // Probe and voice-sample rows are real agent turns about a post that does
  // not exist. They get this far so their drafts are gated like any other,
  // and stop here. Until this check, the only thing keeping one off the
  // network was the PDS refusing its made-up CID.
  if (row.source === 'voice-sample') {
    db.setStatus(row.id, 'drafted', { settled_at: db.nowIso() });
    return { posted: false, gate: 'synthetic', detail: 'voice-sample rows never post' };
  }

  try {
    const { createPost } = await import('./atproto.js');

    // Re-check the kill switch here, after the last await before the network
    // call. The gate above ran before a dynamic import and, on the first post
    // after a restart, before createSession -- which is a network round trip
    // that can take seconds. A switch thrown during that window would otherwise
    // be honoured only from the NEXT post, which is not what "go quiet in ten
    // seconds" means. This narrows the gap to the createRecord request itself,
    // which is the part that cannot be made atomic.
    const lateKill = killSwitchEngaged();
    if (lateKill) {
      db.recordRejection(row.id, 'outbound', 'kill_switch', `engaged mid-post (${lateKill})`, draftText);
      db.setStatus(row.id, 'rejected', {
        gate: 'kill_switch', gate_detail: `engaged mid-post (${lateKill})`, settled_at: db.nowIso(),
      });
      logger.warn('kill switch engaged between gate and post; dropped', {
        queueId: row.id, how: lateKill, draft: draftText,
      });
      return { posted: false, gate: 'kill_switch', detail: `engaged mid-post (${lateKill})` };
    }

    // Post the chain. Each post replies to the one before it.
    let parent = null;
    const sent = [];
    for (const [i, post] of verdict.posts.entries()) {
      if (isNapping() || db.getQueueRow(row.id)?.status === 'paused') {
        if (sent.length) {
          db.recordReply({ queueId: row.id, authorDid: row.author_did, inReplyTo: row.uri,
            replyUri: sent[0].uri, replyCid: sent[0].cid, text: verdict.text, postCount: sent.length });
          return { posted: true, partial: true, gate: 'nap', uri: sent[0].uri };
        }
        pauseRow(row.id);
        return { posted: false, gate: 'nap' };
      }
      const record = buildPostRecord(row, post.text, g.replyLangs, post.facets, parent);
      let res;
      try {
        res = await createPost(record);
      } catch (err) {
        if (sent.length) {
          // Part of the answer is already public. Retrying would repost the
          // parts that landed, so this stops here and records what exists.
          db.recordReply({
            queueId: row.id, authorDid: row.author_did, inReplyTo: row.uri,
            replyUri: sent[0].uri, replyCid: sent[0].cid,
            text: verdict.text, postCount: sent.length,
          });
          db.setStatus(row.id, 'failed', {
            gate: 'partial_thread',
            gate_detail: `posted ${sent.length} of ${verdict.posts.length}; post ${i + 1} failed: ${String(err.message).slice(0, 200)}`,
            settled_at: db.nowIso(),
          });
          logger.error('thread posted partially', {
            queueId: row.id, sent: sent.length, of: verdict.posts.length,
            err, note: 'not retried: the posts that landed are public',
          });
          return { posted: true, partial: true, uri: sent[0].uri, gate: 'partial_thread' };
        }
        throw err;
      }
      sent.push(res);
      parent = { uri: res.uri, cid: res.cid };
    }

    db.recordReply({
      queueId: row.id,
      authorDid: row.author_did,
      inReplyTo: row.uri,
      replyUri: sent[0].uri,
      replyCid: sent[0].cid,
      text: verdict.text,
      postCount: sent.length,
    });
    db.setStatus(row.id, 'posted', { settled_at: db.nowIso() });
    logger.info('posted reply', {
      queueId: row.id, uri: sent[0].uri, posts: sent.length, inReplyTo: row.uri,
      author: row.author_handle ?? row.author_did, graphemes: verdict.graphemes,
    });
    // Only now, with the whole reply public, may a like Poe proposed go out.
    const like = await sendProposedLike(row.id);
    return { posted: true, uri: sent[0].uri, posts: sent.length, liked: like.liked };
  } catch (err) {
    if (isNapping() || db.getQueueRow(row.id)?.status === 'paused') {
      pauseRow(row.id);
      return { posted: false, gate: 'nap' };
    }
    db.setStatus(row.id, 'failed', {
      gate: 'post_error', gate_detail: String(err.message).slice(0, 500), settled_at: db.nowIso(),
    });
    logger.error('createRecord failed', { queueId: row.id, err, status: err.status });
    return { posted: false, gate: 'post_error', detail: err.message };
  }
}


// --- cooldown notices -----------------------------------------------------

/**
 * What the potato says when it has hit a rate limit.
 *
 * Written here rather than generated, which is the whole point: the limit
 * exists to stop spending model turns, so answering it with a model turn would
 * defeat it. One of these goes out once per account per cooldown window, and
 * then the account gets silence until the window passes.
 *
 * Kept in the voice of skills/bluesky-reply.md. If that voice changes, these
 * should follow, and nothing enforces that but you.
 */
export const COOLDOWN_NOTICES = [
  "ok i need a little lie down! i've answered a LOT this hour and my brain has gone more starch than usual. ask me again in a bit and i'll be right here. (◕‿◕)ᶻᶻ",
  "phew, that's my answers used up for this hour. potatoes tire easily, it's a known issue. come back shortly and i'll be full of beans again!",
  "oof, hourly quota gone. i'm going to sit in the dark for a while like a proper potato. back with you soon, promise! (◕‿◕)ノ",
  "i've hit my limit for the hour, which is a very boring thing for a potato to have. give it a little and i'll be right back.",
  "uh oh, i've answered all i can for this hour! going to curl up in the soil for a bit. ask me again after a little rest. (◕‿◕)ᶻᶻ",
  "the potato is temporarily out of words. tragic, i know. give me a little while and ask again? (◕‿◕;)",
  "i've used up my answers for now! i'm going to stare fondly at some records until i've recharged. come back in a bit?",
];

/**
 * Tell somebody we are out of answers, once, then go quiet.
 * Runs the outbound gates like any other post, so the kill switch still stops it.
 */
export async function postCooldownNotice(row, gate) {
  if (isNapping() || db.getQueueRow(row.id)?.status === 'paused') return { posted: false, reason: 'nap' };
  const g = gates();
  const mins = g.cooldownNoticeMins ?? 60;
  if (!db.claimCooldownNotice(row.author_did, gate, mins)) return { posted: false, reason: 'already notified' };

  // Rotate on the DID so one account does not get the same line each time.
  const seed = [...row.author_did].reduce((n, c) => n + c.charCodeAt(0), 0);
  const last = db.lastReplyTextTo(row.author_did);
  const options = COOLDOWN_NOTICES.filter((t) => t !== last);
  const text = options[seed % options.length];

  const verdict = evaluateOutbound(text, {
    gates: g,
    botHandle: config.botHandle,
    replyingToDid: row.author_did,
    replyingToHandle: row.author_handle,
    lastReplyText: last,
    allowedLinks: null,
    allowedLinkHosts: g.allowedLinkHosts,
    killSwitch: killSwitchEngaged,
  });
  if (!verdict.ok) {
    logger.warn('cooldown notice refused by a gate', { queueId: row.id, gate: verdict.gate });
    return { posted: false, reason: verdict.gate };
  }
  if (config.stage < 4 || config.dryRun) {
    logger.info('would send cooldown notice', { queueId: row.id, gate, text });
    return { posted: false, reason: 'stage' };
  }

  try {
    const { createPost } = await import('./atproto.js');
    const record = buildPostRecord(row, verdict.posts[0].text, g.replyLangs, verdict.posts[0].facets);
    const res = await createPost(record);
    db.recordReply({
      queueId: row.id, authorDid: row.author_did, inReplyTo: row.uri,
      replyUri: res.uri, replyCid: res.cid, text: verdict.posts[0].text, postCount: 1,
    });
    logger.info('sent cooldown notice', { queueId: row.id, gate, uri: res.uri });
    return { posted: true, uri: res.uri };
  } catch (err) {
    logger.error('cooldown notice failed to post', { queueId: row.id, err });
    return { posted: false, reason: 'post_error' };
  }
}
