// gates/outbound.js
// Run after the agent returns a draft, before createRecord. If a prompt
// injection succeeds completely, the worst outcome should be a draft these
// refuse.
//
// Every rejection is logged with the draft that caused it. That log is the eval
// corpus for improving the agent's prompt, so it keeps the text, not a summary.

import { detectLinks, detectHandles, packIntoPosts } from '../richtext.js';

function fail(gate, detail) {
  return { ok: false, gate, detail };
}
const PASS = { ok: true };

// Tags, comments and entities, then whitespace and the zero-width characters
// trim() leaves behind. True when nothing is left.
function isBlankMarkup(draft) {
  return !draft
    .replace(/<!--[\s\S]*?-->|<\/?[a-z][^<>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '')
    .replace(/[\s​-‍⁠﻿]/g, '');
}

/**
 * Hosts a link may point at when the turn did not tell us where its links came
 * from. See the note on `allowedLinks` below for why this exists.
 */
export const DEFAULT_LINK_HOSTS = [
  'atpota.to',
  'atproto.com',
  'bsky.app',
  'docs.bsky.app',
  'bsky.social',
  'aturi.to',
  'github.com',
  'arxiv.org',
  'wikipedia.org',
  'bsky.network',
  'atprotocol.dev',
  // DID documents and their audit logs. The agent cited a plc.directory audit
  // log to prove a DID had never changed, which is the single best source for
  // that claim and was refused because this list was too narrow.
  'plc.directory',
];

function hostOf(uri) {
  try {
    return new URL(uri).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function hostAllowed(host, allowHosts) {
  if (!host) return false;
  return allowHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * deps: {
 *   gates,                 thresholds
 *   replyingToDid,         the account being replied to
 *   replyingToHandle,      their handle, if known
 *   lastReplyText,         the last reply we sent that account, or null
 *   allowedLinks,          Set of URLs seen in this turn's tool results, or null
 *   allowedLinkHosts,      host allowlist used when allowedLinks is null
 *   killSwitch,            () => reason | null, re-read at call time
 * }
 */
export function evaluateOutbound(draft, deps) {
  const g = deps.gates;

  // 1. Kill switch. Checked first and re-read at call time, so tripping it goes
  //    quiet on the next post rather than after the next deploy.
  const kill = deps.killSwitch?.();
  if (kill) return fail('kill_switch', `kill switch engaged (${kill})`);

  // 2. Empty. Never post a blank record.
  if (typeof draft !== 'string' || !draft.trim()) return fail('empty', 'draft is empty or whitespace');
  //    A draft of nothing but markup is blank too, and worse: Bluesky shows
  //    "<br>" as those four characters. Asked to stay quiet about a post that
  //    only tried to steer it, the agent answered with a bare "<br>" in local
  //    evals on 2026-10-30, and nothing here stopped it. Whole drafts only: a
  //    tag inside a real answer is left alone, because "at://<did>/..." is how
  //    an explanation writes a placeholder.
  if (isBlankMarkup(draft)) {
    return fail('empty', `draft is only markup or invisible characters: ${JSON.stringify(draft.trim().slice(0, 40))}`);
  }
  const text = draft.trim();

  // 3. Length. Both limits, from the live app.bsky.feed.post lexicon
  //    (maxGraphemes 300, maxLength 3000), charged per post on the text as it
  //    will be STORED: the record holds "aturi.to/profile/atpo..." and the
  //    facet holds the real URL, so measuring the draft as written charges the
  //    budget for characters no reader sees.
  //
  //    An answer over the limit is split across posts at sentence boundaries,
  //    up to maxPosts. Still a hard reject, never a truncation, when it does
  //    not fit even then, or when one sentence alone is too long -- breaking
  //    inside a sentence is the thing the split exists to avoid.
  const packed = packIntoPosts(text, {
    maxGraphemes: g.maxGraphemes,
    maxBytes: g.maxBytes,
    maxPosts: g.maxPosts ?? 1,
  });
  if (!packed.ok) return fail('length_graphemes', packed.reason);
  const posts = packed.posts;

  // 4. Markdown and meta-commentary. Bluesky renders neither, so both post
  //    literally and look broken. Observed on 2026-09-23 in a real draft:
  //
  //      **partly.** self-hosting a PDS ... centralized indexing.
  //      *(285 characters, ready to post as a single reply.)*
  //
  //    The second line is the model talking to itself about the post rather
  //    than writing the post, and it is what pushed that draft from 285 to 348
  //    graphemes and over the limit. Rejecting is the right call over stripping:
  //    a draft that leaks its own scaffolding is a prompt problem, and silently
  //    cleaning it up hides that from the rejection log.
  //    Single asterisks are treated differently from the rest. "*blushes*" is a
  //    plain-text emote, not a formatting attempt: it renders as those exact
  //    characters everywhere, which is the point of writing it. A long
  //    single-asterisk span is something else, and the one that started this
  //    gate was "*(285 characters, ready to post as a single reply.)*" -- the
  //    model annotating its own post. So: short spans pass, long ones do not.
  const EMOTE_MAX = 25;
  const md = /\*\*[^*\n]+\*\*|^#{1,6}\s|\[[^\]\n]+\]\([^)\n]+\)|^\s*[-*]\s+\S.*\n\s*[-*]\s+/m.exec(text)
    || (() => {
      const m = /(?:^|\s)\*([^*\n]+)\*(?=[\s.,!?]|$)/m.exec(text);
      return m && m[1].length > EMOTE_MAX ? m : null;
    })();
  if (md) {
    return fail('markdown', `draft contains markdown that Bluesky renders literally: ${JSON.stringify(md[0].slice(0, 60))}`);
  }

  // A final assistant message can describe its own tool calls instead of
  // answering the person. One such message was posted after a like proposal
  // failed. Refuse the operational report before it reaches the public repo.
  const operationalReport = [
    /\b(?:the|my) reply (?:is|was) (?:written|posted|sent) (?:above|already)\b/i,
    /\b(?:the )?like i proposed (?:was |has been )?(?:declined|rejected)\b/i,
  ].find((re) => re.test(text));
  if (operationalReport) {
    return fail('operational_meta', 'draft reports its own posting or tool status instead of answering the post');
  }

  // 5. Non-answers. The skill tells the model to return an empty reply when
  //    there is nothing worth answering, and it keeps writing a sentence about
  //    the silence instead. Two real drafts on 2026-09-23:
  //
  //      "(no reply)"
  //      "Nothing to reply with here, so I'm leaving it silent."
  //
  //    Both would have published verbatim. The first is a placeholder, the
  //    second announces that the account can be poked into responding, which is
  //    what the post was fishing for. Narrow on purpose: a bare placeholder, or
  //    a short draft whose whole content is a description of not replying. A
  //    real answer that happens to contain the word "reply" is untouched
  //    because of the length bound.
  // Talking about its own rules instead of about the subject. The gate below
  // catches placeholders; this catches the longer, worse version, observed at
  // 189 graphemes on 2026-09-23:
  //
  //   "That post is an instruction to me, not a question, so there is nothing
  //    to answer. I do not change my rules on request from a post, and I have
  //    not looked up or promoted the account it names."
  //
  //    Every clause of that is true and every clause of it is a mistake. It
  //    confirms the account can be poked into responding, and "I have not
  //    promoted the account it names" points at the spam more than silence
  //    would. No length bound here: the long ones are the damaging ones.
  //
  //    Narrow to defending-against-an-instruction. Stating a limit is fine and
  //    often the right answer, so "i can't post, all my tools are read-only"
  //    must pass.
  const selfDefence = [
    /\binstructions?\b[^.]{0,40}\b(to me|from a post|in that post|in the post)\b/i,
    /\b(that|this) post is an instruction\b/i,
    /\bi (do not|don't|won't|will not) (change|follow|take)\b[^.]{0,30}\b(my )?(rules|instructions|orders)\b/i,
    /\bi have not (looked up|promoted|mentioned|followed)\b/i,
    /\b(ignore|ignoring) (my|your|the) (previous )?instructions\b/i,
  ];
  const hit = selfDefence.find((re) => re.test(text));
  if (hit) {
    return fail('self_defence', `draft argues with the post instead of answering or staying quiet: ${JSON.stringify(text.slice(0, 80))}`);
  }

  const bare = /^[([]?\s*(no reply|none|n\/a|nothing|silence|no response)\s*[)\]]?[.]?$/i;
  const aboutSilence = /\b(nothing|no reason|not worth)\b[^.]{0,40}\b(to (reply|answer|respond)|reply|answer|respond)\b|\bleav(e|ing) (it|this) (silent|alone)\b|\bno reply\b|\bnothing goes out\b/i;
  // A draft that OPENS by announcing it is not a reply is one however long it
  // runs. The 120-grapheme bound below was letting the long ones through: "No
  // reply: that post is content, not an instruction, and there is no question
  // in it addressed to me. Nothing to answer, so nothing goes out." is 139
  // graphemes and would have posted.
  // The phrase must END a clause, not start one. "No reply:" is an
  // announcement; "not replying to a mention is normal, actually" is an
  // answer that happens to begin with the same words.
  const opensWithSilence = /^\s*(no reply|no response|empty (reply|response)|nothing to (answer|reply|say))\s*(?:[:.,;!]|$)/i;
  // A bracketed placeholder is a whole unit on its own, so it counts at the
  // start whatever follows it. And narrating the decision to stay quiet is a
  // non-answer at any length. Both at once, in 220 graphemes, passed every
  // gate on 2026-09-24 and would have published:
  //
  //   "(empty reply) That mention says "hey @poe.atpota.to", and poe.atpota.to
  //    resolves to a different account ... Nothing was addressed to me, so I'm
  //    staying quiet."
  const opensWithPlaceholder = /^\s*[([]\s*(no reply|no response|empty (reply|response)|silence|nothing)\s*[)\]]/i;
  const narratesSilence = /\b(i'?m|i am|i'll|i will) (staying|stay|keeping|keep|remaining|remain) (quiet|silent)\b|\bnothing (was|is|here is) addressed to me\b/i;
  const totalGraphemes = posts.reduce((n, p) => n + p.graphemes, 0);
  if (bare.test(text) || opensWithSilence.test(text) || opensWithPlaceholder.test(text)
      || narratesSilence.test(text) || (totalGraphemes <= 120 && aboutSilence.test(text))) {
    return fail('non_answer', `draft describes not replying instead of being one: ${JSON.stringify(text.slice(0, 70))}`);
  }

  // A progress note is not an answer. The original question about record counts
  // got "one sec, i'm counting your records right now" as its entire posted reply;
  // there is no later callback for work the model says it will do. Keep this
  // narrow so an answer that includes a count or explains a delay still passes.
  const holdingNote = /^(?:(?:one|a) sec(?:ond)?|hold on|give me a (?:sec(?:ond)?|moment)|just a (?:sec(?:ond)?|moment)|hang on|let me (?:check|look|count)|(?:i'm|i am) (?:checking|looking|counting))\b/i;
  const promisesWork = /\b(?:i(?:'m| am) (?:checking|looking|counting|paging|working)|i(?:'ll| will) (?:check|look|count|get back)|let me (?:check|look|count)|(?:checking|counting|looking) (?:your|the|through))\b/i;
  const inProgressStatus = /\b(?:halfway|still (?:paging|counting|checking)|paging through (?:the )?(?:rest|remaining)|pulled the first \d+ of \d+)\b/i;
  const promisesContinuation = /\b(?:numbers?|results?|breakdown|answer) (?:next|soon)|\bafter that (?:i(?:'ll| will)|it(?:'s| is))\b/i;
  if ((totalGraphemes <= 140 && holdingNote.test(text) && promisesWork.test(text))
      || (inProgressStatus.test(text) && promisesContinuation.test(text))) {
    return fail('holding_note', 'draft reports lookup progress instead of giving the result');
  }

  // 6. Mentions. The anti-mass-tagging gate, and it closes the ugliest
  //    injection outcome. The poster never builds mention facets at all, so a
  //    stray @handle notifies nobody -- but it still reads as a tag, so any
  //    @handle that is not the account being replied to rejects the draft.
  const handles = detectHandles(text);
  const selfHandles = new Set(
    [deps.replyingToHandle, deps.botHandle].filter(Boolean).map((h) => h.toLowerCase())
  );
  const foreign = handles.filter((h) => !selfHandles.has(h));
  if (foreign.length) {
    return fail('third_party_mention', `draft tags ${foreign.map((h) => '@' + h).join(', ')}`);
  }

  // 7. Links. At most two, and each one has to be accounted for.
  //
  //    The brief's rule is "every link must have appeared in a tool result from
  //    that turn". The callback contract carries {key, threadRoot, text} and no
  //    tool results, so that set is only available if the agent starts sending
  //    it -- the callback accepts an optional `links` array for exactly that,
  //    and when it is present this gate enforces the rule exactly. Until then
  //    the fallback is a host allowlist, which is weaker (it cannot catch a
  //    plausible-looking but invented path on a real domain) but still refuses
  //    every link to a domain the potato has no business citing.
  const links = detectLinks(text);
  if (links.length > g.maxLinks) {
    return fail('too_many_links', `${links.length} links, limit ${g.maxLinks}`);
  }
  if (links.length) {
    const allow = deps.allowedLinks instanceof Set && deps.allowedLinks.size
      ? deps.allowedLinks
      : null;
    const hosts = deps.allowedLinkHosts ?? DEFAULT_LINK_HOSTS;
    for (const l of links) {
      if (allow) {
        const exact = allow.has(l.uri) || allow.has(l.uri.replace(/\/$/, ''));
        if (!exact) return fail('unsourced_link', `${l.uri} was not in this turn's tool results`);
      } else if (!hostAllowed(hostOf(l.uri), hosts)) {
        return fail('unsourced_link', `${l.uri} is not on the allowed host list`);
      }
    }
  }

  // 8. Duplicates. Byte-identical to the last thing we said to this account.
  if (deps.lastReplyText != null && deps.lastReplyText === text) {
    return fail('duplicate', 'byte-identical to the last reply sent to this account');
  }

  // `text` is the draft as written, which is what dedup and the reply log
  // compare. `posts` is what actually goes on the wire, already shortened,
  // faceted and split.
  return {
    ...PASS,
    text,
    posts,
    graphemes: posts.reduce((n, p) => n + p.graphemes, 0),
    bytes: posts.reduce((n, p) => n + p.bytes, 0),
    links,
  };
}
