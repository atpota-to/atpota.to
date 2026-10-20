// agent.js
// Calls the eve agent. The agent has no write tool and no atproto credential;
// it produces text and nothing more. That split is the security model, so
// nothing here hands it anything it could act on.

import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Dispatch one turn. A 202 means the turn was dispatched, not that a draft
 * exists -- the draft arrives later on the callback.
 *
 * authorDid comes from the signed record, never from parsing post text: it is
 * what the agent's memory scope keys on, so a wrong value here attaches one
 * person's memory to another.
 *
 * `context` is what readPostContext found (see thread.js): the text with its
 * links written out, the embed in words, images to describe, and the thread
 * above. All of it is context, and none of it is worth losing an answer over:
 * if the agent refuses the payload with it, the turn is sent again without.
 */
export async function sendMention(row, {
  timeoutMs = 15000, retryNote, context, operator = false, lessons = [], lessonSaved = null,
  styleNotes = [], styleSaved = null, agentUrl = config.agentUrl,
} = {}) {
  const base = {
    threadRoot: row.thread_root,
    postUri: row.uri,
    authorDid: row.author_did,
    authorHandle: row.author_handle ?? undefined,
    text: row.text,
    reason: row.reason,
    attempt: row.attempts,
    // Present only on a retry. It travels on the authenticated route, outside
    // the post text, so the agent can tell our correction from a stranger's.
    ...(retryNote ? { retryNote: String(retryNote).slice(0, 400) } : {}),
  };
  const extras = {
    // Which account the post was addressed to. The agent is never told
    // otherwise, and without it, it looked up "@poe.atpota.to", found a DID
    // it did not recognise as its own, and decided a hello was not for it.
    account: { handle: config.botHandle, did: config.botDid },
    ...(context?.text ? { text: context.text } : {}),
    ...(context?.attachment ? { attachment: context.attachment } : {}),
    ...(context?.images?.length ? { images: context.images } : {}),
    ...(context?.thread?.length ? { thread: context.thread } : {}),
    // From the people who run the potato (pipeline.js decides, by DID): that
    // this post is theirs, the lesson it just taught, and the standing ones.
    ...(operator ? { operator: true } : {}),
    ...(lessonSaved ? { lessonSaved } : {}),
    ...(lessons?.length ? { lessons } : {}),
    ...(styleNotes?.length ? { styleNotes } : {}),
    ...(styleSaved ? { styleSaved } : {}),
  };

  const res = await deliver({ ...base, ...extras }, { timeoutMs, agentUrl, postUri: row.uri });
  if (res.status === 400 && Object.keys(extras).length) {
    // A 400 here means the agent's schema and ours have drifted. That has
    // happened once already, over authorHandle, and what it produced was
    // silence. So the answer goes out with the bare post rather than not at all.
    logger.warn('agent refused the post context; sending the turn without it', {
      postUri: row.uri, fields: Object.keys(extras), detail: res.detail,
    });
    return deliver(base, { timeoutMs, agentUrl, postUri: row.uri });
  }
  return res;
}

async function deliver(payload, { timeoutMs, agentUrl, postUri }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${agentUrl}/bluesky/mention`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-atpotato-secret': config.sharedSecret,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const body = await res.text().catch(() => '');

    if (res.status === 202) return { ok: true, status: 202 };
    if (res.status === 401) {
      logger.error('agent rejected our secret', { status: 401, note: 'DROPLET_SHARED_SECRET out of sync with the agent env' });
      return { ok: false, status: 401, detail: 'bad shared secret' };
    }
    if (res.status === 400) {
      logger.error('agent rejected the payload', { status: 400, body: body.slice(0, 300), postUri });
      return { ok: false, status: 400, detail: `payload rejected: ${body.slice(0, 200)}` };
    }
    return { ok: false, status: res.status, detail: body.slice(0, 200) };
  } catch (err) {
    const detail = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    return { ok: false, status: 0, detail };
  } finally {
    clearTimeout(timer);
  }
}
