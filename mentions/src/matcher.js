// matcher.js
// Turns a Jetstream v2 commit payload into a match, or into nothing.
//
// Two ways to match, and only two:
//   mention  a facet feature of type app.bsky.richtext.facet#mention whose did
//            is ours. Never the literal string "@atpota.to" — facets are what
//            the posting client actually resolved, text is just text, and the
//            two can disagree by accident or on purpose.
//   reply    record.reply.parent.uri is one of our posts.
//
// A quote post embeds our post at embed.record.record.uri. That is not a match.
// Quoting is usually commentary about us rather than a question to us, and
// replying reads as barging in. A post that quotes us AND replies to us still
// matches — on the reply, not the quote.

const MENTION_FEATURE = 'app.bsky.richtext.facet#mention';
export const POST_COLLECTION = 'app.bsky.feed.post';

/** at:// URI for a post, from the parts Jetstream gives us. */
export function postUri(did, rkey) {
  return `at://${did}/${POST_COLLECTION}/${rkey}`;
}

/**
 * The UTF-8 byte offset of the first mention facet for `did`, or null.
 * Used to tell "addressed to us" from "mentioned in passing": a post that opens
 * with a block of handles is talking TO those accounts, one that names us
 * mid-sentence is talking ABOUT us.
 */
export function mentionOffset(record, did) {
  const facets = Array.isArray(record?.facets) ? record.facets : [];
  let best = null;
  for (const facet of facets) {
    const features = Array.isArray(facet?.features) ? facet.features : [];
    const hit = features.some((f) => f && f.$type === MENTION_FEATURE && f.did === did);
    if (!hit) continue;
    const start = facet?.index?.byteStart;
    if (typeof start !== 'number') continue;
    if (best == null || start < best) best = start;
  }
  return best;
}

/** Every mention DID in a record's facets. Tolerates malformed facets. */
export function mentionDids(record) {
  const out = [];
  const facets = Array.isArray(record?.facets) ? record.facets : [];
  for (const facet of facets) {
    const features = Array.isArray(facet?.features) ? facet.features : [];
    for (const f of features) {
      if (f && f.$type === MENTION_FEATURE && typeof f.did === 'string') out.push(f.did);
    }
  }
  return out;
}

/** The post this record quotes, if any. Both embed shapes carry it. */
export function quotedUri(record) {
  const e = record?.embed;
  if (!e) return null;
  if (e.$type === 'app.bsky.embed.record' && typeof e.record?.uri === 'string') return e.record.uri;
  if (e.$type === 'app.bsky.embed.recordWithMedia' && typeof e.record?.record?.uri === 'string') {
    return e.record.record.uri;
  }
  return null;
}

function strongRef(ref) {
  if (!ref || typeof ref.uri !== 'string' || typeof ref.cid !== 'string') return null;
  return { uri: ref.uri, cid: ref.cid };
}

/**
 * Normalise a Jetstream v2 payload into the shape the rest of the pipeline uses.
 *
 * v2 puts everything flat on `payload` (did, rkey, cid, collection, operation,
 * record, seq, time). v1 nested it under `commit` and carried `time_us`. The
 * shapes are different enough that feeding one to code written for the other
 * silently matches nothing, so this only accepts v2.
 */
export function normaliseCommit(payload) {
  if (!payload || payload.collection !== POST_COLLECTION) return null;
  if (payload.operation !== 'create') return null;      // updates and deletes are not questions
  const record = payload.record;
  if (!record || typeof record.text !== 'string') return null;
  if (typeof payload.did !== 'string' || typeof payload.rkey !== 'string') return null;
  if (typeof payload.cid !== 'string') return null;      // no cid, no strong ref, no reply
  return {
    did: payload.did,
    rkey: payload.rkey,
    cid: payload.cid,
    record,
    seq: payload.seq,
    time: payload.time,
  };
}

/**
 * Does this post address us, and if so how?
 * Returns a match object, or null.
 *
 * `botDid` is compared against the signed record's own fields only. The author
 * DID on the result comes from the commit, never from parsing text — it is what
 * the agent's memory scope keys on, so a wrong value attaches one person's
 * memory to another.
 */
export function matchPost(ev, botDid, source = 'jetstream') {
  if (!ev) return null;
  const { did: authorDid, rkey, cid, record } = ev;

  // Self, first, before anything else can reach a code path that replies.
  if (authorDid === botDid) return null;

  const replyParent = strongRef(record?.reply?.parent);
  const replyRoot = strongRef(record?.reply?.root);

  const isReply = !!replyParent && replyParent.uri.startsWith(`at://${botDid}/`);
  const isMention = mentionDids(record).includes(botDid);

  if (!isReply && !isMention) return null;

  const uri = postUri(authorDid, rkey);

  // The reply we will send hangs off this post, so this post is our parent.
  const parent = { uri, cid };
  // The root of the thread: the matched post's own root when it is itself a
  // reply, otherwise the matched post is the root. Getting this wrong detaches
  // the reply from the thread in most clients.
  const root = replyRoot ?? parent;

  return {
    did: authorDid,
    rkey,
    uri,
    cid,
    authorDid,
    authorHandle: null,         // Jetstream carries no handle; filled in later if known
    text: record.text,
    reason: isReply ? 'reply' : 'mention',
    langs: Array.isArray(record.langs) ? record.langs : null,
    recordCreated: typeof record.createdAt === 'string' ? record.createdAt : null,
    threadRoot: root.uri,
    rootUri: root.uri,
    rootCid: root.cid,
    parentUri: parent.uri,
    parentCid: parent.cid,
    // What the matched post itself replies to, which is where reading the
    // thread above it starts. Not parentUri: that is the matched post, the one
    // OUR reply will hang off. Null for a post that starts a thread.
    upstreamUri: replyParent?.uri ?? null,
    upstreamCid: replyParent?.cid ?? null,
    quotedUri: quotedUri(record),
    // An image or a quote with a bare tag is "what's this?", not an empty post.
    hasEmbed: !!record.embed,
    botMentionOffset: mentionOffset(record, botDid),
    source,
  };
}
