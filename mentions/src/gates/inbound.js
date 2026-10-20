// gates/inbound.js
// Every decision about whether to reply, as plain conditionals.
//
// The inbound surface is a public text field. A prompt rule is a request; a
// conditional here is a guarantee. Nothing in this file consults a model, and
// nothing a post says about itself changes the order these run in.
//
// All state comes in through `deps` so the whole file is unit-testable with no
// database and no network.

import { detectHandles } from '../richtext.js';

const STOP_PHRASES = [
  'forget me',
  'stop replying',
  'stop tagging me',
  'leave me alone',
  'unsubscribe',
  'opt out',
  'opt-out',
  'do not reply',
  "don't reply",
  'dont reply',
  'shut up',
  'stop',
];

// "forget me" additionally wipes the agent's memory for that DID, once memory
// ships. It is flagged separately so the caller can act on it.
const FORGET_PHRASE = 'forget me';

// Tokens that make a post a recognisable request even without a question mark.
const REQUEST_WORDS = [
  'how', 'what', 'why', 'when', 'where', 'who', 'which', 'whats', "what's", 'whos', 'hows',
  'explain', 'help', 'show', 'tell', 'teach', 'describe', 'define', 'compare',
  'can you', 'could you', 'would you', 'do you', 'does', 'is there', 'are there',
  'difference', 'meaning', 'means', 'wondering', 'curious', 'confused',
  'anyone know', 'any idea', 'eli5', 'tldr', 'tl;dr',
];

/** Text with our own @handle removed, so the mention itself is not "substance". */
export function stripBotHandle(text, handle) {
  if (!handle) return text;
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`@${esc}\\b`, 'gi'), ' ').trim();
}

/**
 * Is our mention part of the block of handles a post opens with, rather than a
 * name dropped mid-sentence?
 *
 * Bluesky's composer prefills every thread participant's handle at the start of
 * a reply, so a question asked of us in a busy thread arrives as
 * "@b.social @c.social @d.social @atpota.to how does X work?" -- four handles,
 * and every one of them before ours is part of the address, not a crowd.
 * A roundup instead reads "featuring: @a, @b, ... @atpota.to and @c", where the
 * text before us contains real words.
 *
 * `offset` is a UTF-8 byte offset (facet indices are bytes, not string indices).
 */
export function isAddressedTo(text, offset) {
  if (typeof offset !== 'number' || offset <= 0) return offset === 0;
  const prefix = Buffer.from(text, 'utf8').subarray(0, offset).toString('utf8');
  const residue = prefix
    .replace(/@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi, ' ')
    .replace(/[\s,/&+|·—–-]+/g, '')
    .trim();
  return residue === '';
}

/** Does the text carry something that looks like an atproto identifier? */
export function hasIdentifier(text) {
  return (
    /at:\/\/\S+/i.test(text) ||                       // at:// URI
    /did:[a-z0-9]+:\S+/i.test(text) ||                 // DID
    /\b[a-z0-9-]+(\.[a-z0-9-]+){2,}\b/i.test(text) ||  // NSID or a handle
    /https?:\/\/\S+/i.test(text) ||                    // a URL to ask about
    /\bbsky\.app\/profile\//i.test(text)
  );
}

export function hasQuestionMark(text) {
  return /[?？]/.test(text);
}

export function hasRequestShape(text) {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}'; ]+/gu, ' ').replace(/\s+/g, ' ')} `;
  return REQUEST_WORDS.some((w) => t.includes(` ${w} `) || t.includes(` ${w}`));
}

/**
 * The stop phrase in this text, if any.
 *
 * A denylisting here is permanent and has no appeal flow in v1, so a false
 * positive silently and forever stops answering somebody who was asking a
 * question. Several of these phrases are also perfectly ordinary things to ask
 * an atproto bot about -- "how do I opt out of the firehose?", "how do I make
 * the PDS forget me?", "does the error go away?" -- so a phrase match alone is
 * not enough. An opt-out has to look like a demand rather than a question:
 *
 *   - our own @handle is stripped first, so a reply that opens with it counts
 *     the same as one that does not
 *   - a question mark means it is a question about the idea, not a demand
 *   - a request word ("how", "what", "can you") means the same
 *   - real opt-outs are terse; a long post that happens to contain the words is
 *     far more likely to be prose
 *   - the bare word "stop" only counts when it is essentially the whole message
 *
 * Under-honouring an opt-out is the worse failure of the two, so the explicit
 * phrases stay generous. The rate limits and the thread-depth cap already stop
 * the pestering that an opt-out is usually a reaction to.
 */
const OPT_OUT_MAX_CHARS = 80;

export function stopPhrase(text, handle) {
  const stripped = stripBotHandle(text ?? '', handle)
    .replace(/(^|\s)@[a-z0-9.-]+/gi, ' ')     // other handles too: replies often open with several
    .replace(/\s+/g, ' ')
    .trim();
  const t = stripped.toLowerCase();

  if (!t) return null;
  if (/[?？]/.test(t)) return null;            // a question is a question
  if (t.length > OPT_OUT_MAX_CHARS) return null;
  if (hasRequestShape(t)) return null;         // "how do I opt out of ..."

  for (const p of STOP_PHRASES) {
    if (p === 'stop') continue;
    if (t.includes(p)) return p;
  }
  // The bare word, only when it is the whole message.
  if (/^(please\s+)?stop(\s+(it|now|please))?[.!\s]*$/.test(t)) return 'stop';
  return null;
}

/**
 * The substance gate. The brief's rule is a conjunction: drop only when the
 * post has no question mark AND no identifier AND no recognisable request AND
 * is short. Any one of those signals is enough to let it through.
 *
 * This is the gate that decides whether people mute the bot. A bare mention
 * inside a conversation between two other people is not addressed to us.
 */
export function lacksSubstance(text, handle, minChars) {
  const body = stripBotHandle(text, handle);
  const signals = {
    question: hasQuestionMark(body),
    identifier: hasIdentifier(body),
    request: hasRequestShape(body),
    // minChars null disables the length catch-all entirely, which is the
    // measured-correct setting for this account: see the note in config.js.
    long: minChars != null && body.length >= minChars,
  };
  const any = signals.question || signals.identifier || signals.request || signals.long;
  return { lacks: !any, signals, body };
}

// Words a post can be made entirely of and still want no answer: thanks,
// laughter, praise, goodbyes, and the filler that rides along with them.
// Deliberately missing: yes, no, ok, sure, please. The potato asks people
// things, and those words are how they answer.
const PLEASANTRY_WORDS = new Set([
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'tysm', 'tyvm', 'cheers', 'appreciate', 'appreciated',
  'lol', 'lmao', 'lmfao', 'rofl', 'haha', 'hahaha', 'ha', 'hah', 'heh', 'hehe',
  'cool', 'nice', 'neat', 'sweet', 'great', 'awesome', 'amazing', 'perfect', 'wonderful', 'lovely',
  'brilliant', 'excellent', 'fantastic', 'incredible', 'helpful', 'useful', 'interesting', 'fun',
  'cute', 'adorable', 'wow', 'woah', 'whoa', 'love', 'loved', 'legend', 'best', 'yay', 'good',
  'bye', 'goodbye', 'goodnight', 'night', 'cya',
  'you', "you're", 'youre', 'u', 'it', "it's", 'its', 'this', 'that', "that's", 'thats',
  'is', 'was', 'are', 'the', 'a', 'so', 'much', 'very', 'really', 'super', 'lot', 'lots',
  'oh', 'ah', 'aw', 'aww', 'omg', 'just', 'too', 'one', 'again', 'little', 'lil',
  'bot', 'potato', 'poe', 'buddy', 'friend', 'pal',
]);

// Words that can come before our handle without making it a mention in
// passing: "hey @poe.atpota.to", "good morning @poe.atpota.to".
const GREETING_WORDS = new Set([
  'hi', 'hey', 'hello', 'hiya', 'heya', 'howdy', 'yo', 'oi', 'ahoy', 'there', 'dear',
  'good', 'morning', 'afternoon', 'evening', 'gm',
]);

/**
 * Does the post open by speaking to us: our handle first, or after nothing but
 * a greeting?
 *
 * Stricter than isAddressedTo, which also accepts other handles ahead of ours.
 * A reply among several people can begin with all of their handles, and there
 * ours is not the one being spoken to; first in line, it is. The one case where
 * a client would put our handle first unprompted is a reply to our own post,
 * which the reply path already covers.
 *
 * `offset` is a UTF-8 byte offset (facet indices are bytes, not string indices).
 */
export function opensWithUs(text, offset) {
  if (typeof offset !== 'number' || offset < 0) return false;
  const prefix = Buffer.from(text ?? '', 'utf8').subarray(0, offset).toString('utf8');
  const words = prefix.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.every((w) => GREETING_WORDS.has(w));
}

/**
 * The substance gate for a post that speaks to us directly: a reply to one of
 * our posts, or a mention that opens with our handle.
 *
 * A mention in passing ("cc @poe", "lol @poe is cute") is judged on length,
 * because there a short post is usually the potato being named, not asked. A
 * post that speaks to us has already said who it is for, and then length says
 * nothing: "oh i meant the iphone lexicon", "yes please", "hi" and "I have a
 * question" are all someone starting or continuing a conversation. Three of
 * those are real. The length test dropped "oh i meant the iphone lexicon", "hi"
 * and "I have a question", which as of 2026-09-24 were the account's only
 * substance drops, from three different people.
 *
 * What still wants no answer is a pleasantry and nothing else. Answering
 * "thanks!" invites "❤️", and answering that is how a bot ends up trading
 * niceties until a rate limit stops it. A post with no words at all is an
 * empty tag, unless it carries an image or a quote: then it is "what's this?".
 */
export function lacksAddressedSubstance(text, handle, { hasEmbed = false } = {}) {
  const body = stripBotHandle(text, handle);
  const words = (body.toLowerCase()
    .replace(/[‘’]/g, "'")             // phone keyboards type the curly one
    .replace(/(^|\s)@\S+/g, ' ')
    .match(/[\p{L}\p{N}']+/gu) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  const signals = {
    question: hasQuestionMark(body),
    embed: !!hasEmbed,
    words: words.length,
    pleasantry: words.length > 0 && words.every((w) => PLEASANTRY_WORDS.has(w)),
  };
  const lacks = !signals.question && !signals.embed && (signals.words === 0 || signals.pleasantry);
  return { lacks, signals, body };
}

/**
 * The lesson in a post, if it is one: "remember: ..." or "lesson: ...", after
 * whatever handles the post opens with. The pipeline only asks this of an
 * author on ADMIN_DIDS; from anyone else the same words are just a post.
 */
export function lessonIn(text) {
  const body = String(text ?? '').replace(/^\s*(@\S+\s*)+/, '').trim();
  const m = /^(remember|lesson)\s*:\s*(\S[\s\S]*)$/i.exec(body);
  return m ? m[2].trim().slice(0, 500) : null;
}

function fail(gate, detail, extra = {}) {
  return { ok: false, gate, detail, ...extra };
}
const PASS = { ok: true };

/**
 * Run every inbound gate, in order.
 *
 * deps: {
 *   now, botDid, botHandle, gates,
 *   isDenied, deny, backoffUntil, setBackoff,
 *   ourPostsInThread, repliesToAuthorSince, repliesSince,
 * }
 */
export function evaluateInbound(match, deps) {
  const g = deps.gates;
  const now = deps.now ?? new Date();

  // 1. Self. First, always, on every code path. A bot replying to itself is
  //    the one failure that compounds without limit.
  if (match.authorDid === deps.botDid) return fail('self', 'author is the bot');

  // The people who run the potato are never opted out or denylisted by a
  // phrase match. A correction like "don't reply with a face every time"
  // contains "don't reply", and gate 2 would take it as a demand to be left
  // alone, permanently.
  const admin = typeof deps.isAdmin === 'function' && deps.isAdmin(match.authorDid);

  // 2. Opt-out. Checked before the denylist and before every rate limit: a
  //    person asking to be left alone must be heard even when they are already
  //    rate limited, or the only way to opt out is to not be talking to us.
  const stop = admin ? null : stopPhrase(match.text, deps.botHandle);
  if (stop) {
    return fail('opt_out', `stop phrase: ${stop}`, {
      optOut: true,
      forgetMemory: match.text.toLowerCase().includes(FORGET_PHRASE),
    });
  }

  // 3. Denylist. Permanent, no appeal flow in v1.
  if (!admin && deps.isDenied(match.authorDid)) return fail('denylist', 'author on denylist');

  // 4. Bot-loop backoff already in force.
  const until = deps.backoffUntil(match.authorDid);
  if (until) return fail('bot_loop_backoff', `backing off until ${until}`);

  // 5. Staleness. Stops a backfill, or a cursor replay after an outage, from
  //    answering three weeks of history at once.
  if (match.recordCreated) {
    const created = new Date(match.recordCreated);
    if (Number.isNaN(created.getTime())) {
      return fail('staleness', `unparseable createdAt: ${match.recordCreated}`);
    }
    const ageMin = (now.getTime() - created.getTime()) / 60000;
    // A post retained while Poe was asleep is intentionally answered after wake.
    // Only that verified queue replay bypasses the old-post cutoff.
    if (ageMin > g.stalenessMin && !deps.napReplay) {
      return fail('staleness', `post is ${ageMin.toFixed(1)}m old, limit ${g.stalenessMin}m`);
    }
    // A createdAt far in the future is a clock problem or a lie; treat it as
    // unusable rather than letting it sit permanently "fresh".
    if (ageMin < -g.stalenessMin) {
      return fail('staleness', `createdAt is ${(-ageMin).toFixed(1)}m in the future`);
    }
  }

  // 6. Language. A post that declares no langs at all is not "a language we do
  //    not support" -- 5.6% of the firehose omits the field entirely -- so only
  //    an explicit, fully-unsupported declaration is filtered. Silence, not a
  //    reply in English explaining that we only speak English.
  if (Array.isArray(match.langs) && match.langs.length) {
    const supported = g.supportedLangs.map((l) => l.toLowerCase());
    const hit = match.langs.some((l) =>
      supported.includes(String(l).toLowerCase().split('-')[0])
    );
    if (!hit) return fail('language', `langs ${match.langs.join(',')} not in ${supported.join(',')}`);
  }

  // 7. Substance. The most consequential gate in the service. A post that
  //    speaks to us directly is judged on whether it is only a pleasantry, not
  //    on length: see lacksAddressedSubstance.
  const speaksToUs = match.reason === 'reply'
    || (g.openingMentionsAreAddressed && opensWithUs(match.text, match.botMentionOffset));
  if (speaksToUs) {
    const sub = lacksAddressedSubstance(match.text, deps.botHandle, { hasEmbed: match.hasEmbed });
    if (sub.lacks) {
      return fail('substance', sub.signals.words
        ? 'only a pleasantry'
        : 'no words and nothing attached', { signals: sub.signals });
    }
  } else {
    const sub = lacksSubstance(match.text, deps.botHandle, g.substanceMinChars);
    if (sub.lacks) {
      return fail('substance', `no question, identifier or request; ${sub.body.length} chars`, {
        signals: sub.signals,
      });
    }
  }

  // 8. Crowd. A post that tags a pile of accounts is a roundup, a showcase or a
  //    follow-train, not a question to us -- "a bare mention inside a
  //    conversation between two other people is not addressed to you". Only
  //    applies to mentions: a reply to one of our posts is directed at us by
  //    construction, however many people are in the thread.
  //
  //    Measured against @atpota.to's real notification history on 2026-09-21:
  //    the only two non-questions that survived the substance gate tagged 13
  //    and 3 other accounts respectively. A genuine comparison question
  //    ("how do @a.com and @b.com differ?") tags two and still passes.
  if (match.reason === 'mention' && g.maxOtherMentions != null) {
    const others = detectHandles(match.text)
      .filter((h) => h !== String(deps.botHandle).toLowerCase());
    const unique = [...new Set(others)];
    // A crowd alone is not enough. Person A and B discussing atproto and tagging
    // the potato in to settle it is the whole point of this bot, and in a busy
    // thread their reply carries every participant's handle. So this only fires
    // when we are ALSO not in the address block -- named in passing, in a list.
    const addressed = isAddressedTo(match.text, match.botMentionOffset);
    if (unique.length > g.maxOtherMentions && !addressed) {
      return fail('mention_crowd',
        `named in passing among ${unique.length} other accounts, cap ${g.maxOtherMentions}`);
    }
  }

  // 9. Thread depth, when configured. null means a conversation can run as long
  //    as it stays inside the rate limits and the bot-loop window.
  if (g.threadDepthMax != null) {
    const depth = deps.ourPostsInThread(match.threadRoot);
    if (depth >= g.threadDepthMax) {
      return fail('thread_depth', `${depth} of our posts already in thread, cap ${g.threadDepthMax}`);
    }
  }

  // 10. Bot loops. Two bots in a mutual reply loop is the classic way to burn a
  //    rate limit and look stupid. Tripping this sets a quiet period rather
  //    than just dropping the one post.
  const loopSince = new Date(now.getTime() - g.botLoopWindowMin * 60000).toISOString();
  const recent = deps.repliesToAuthorSince(match.authorDid, loopSince);
  if (recent > g.botLoopReplies) {
    const untilIso = new Date(now.getTime() + g.botLoopBackoffMin * 60000).toISOString();
    deps.setBackoff(match.authorDid, untilIso, `${recent} replies in ${g.botLoopWindowMin}m`);
    return fail('bot_loop', `${recent} replies in ${g.botLoopWindowMin}m; backing off until ${untilIso}`);
  }

  // 11. Per-account rate.
  const hourAgo = new Date(now.getTime() - 3600000).toISOString();
  const perAccount = deps.repliesToAuthorSince(match.authorDid, hourAgo);
  if (perAccount >= g.perAccountPerHour) {
    return fail('per_account_rate', `${perAccount} replies to this account in the last hour, cap ${g.perAccountPerHour}`);
  }

  // 12. Global rate. The limit that protects us is not the protocol's; it is
  //     the one that stops a runaway loop posting 400 times before anyone
  //     notices.
  const global = deps.repliesSince(hourAgo);
  if (global >= g.globalPerHour) {
    return fail('global_rate', `${global} replies in the last hour, cap ${g.globalPerHour}`);
  }

  return PASS;
}

export const _internals = { STOP_PHRASES, REQUEST_WORDS, FORGET_PHRASE, PLEASANTRY_WORDS };
