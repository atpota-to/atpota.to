// richtext.js
// Grapheme counting and UTF-8 byte offsets for facets.
//
// Two separate traps here, and they bite in opposite directions:
//
//   Length. The lexicon caps text at 300 *graphemes* and 3000 *bytes*.
//   String.length is neither — it counts UTF-16 code units. "👩‍👩‍👧‍👦" is one
//   grapheme, 11 code units and 25 bytes. Both limits are enforced separately;
//   graphemes bind for English, bytes for anything with wide characters.
//
//   Facet offsets. index.byteStart/byteEnd are UTF-8 byte offsets, start
//   inclusive, end exclusive. A JavaScript string index is a UTF-16 code-unit
//   index, and using one as a byte offset puts the facet in the wrong place
//   the moment any non-ASCII character precedes the link — which, with emoji
//   in posts, is most of the time. Every offset below goes through
//   Buffer.byteLength() of the preceding slice, never the raw index.
//
// The upstream helper for this is @atproto/api's RichText. This service ships
// with no dependencies on purpose — it is the component holding the only write
// credential, and on a 1 GB droplet a dependency-free process is one less thing
// to compile, audit and page in. The behaviour below is pinned by tests in
// test/richtext.test.js covering the cases the naive versions get wrong.

const graphemeSeg = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Grapheme count, as the lexicon's maxGraphemes means it. */
export function graphemeLength(text) {
  let n = 0;
  for (const _ of graphemeSeg.segment(text)) n++;
  return n;
}

/** UTF-8 byte length, as the lexicon's maxLength means it. */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-16 index -> UTF-8 byte offset. The one conversion everything depends on. */
export function utf8Offset(text, utf16Index) {
  return Buffer.byteLength(text.slice(0, utf16Index), 'utf8');
}

// Link detection. Mirrors the shape atproto's detectFacets uses: a URL with a
// scheme, or a bare domain that looks like one. Anchored on a boundary so
// "foo.bar" inside a word is not picked up.
// Only an explicit scheme counts as a link.
//
// Bare-domain detection was a mistake for this bot specifically. Explaining
// atproto means naming domains in prose constantly -- "an nsid is a domain in
// reverse order, owned by whoever owns bsky.app" -- and every one of those was
// being turned into a link. Because the outbound link gate is an allowlist,
// a phantom link rejects the entire draft: that exact sentence cost a correct
// answer on 2026-09-23. It would also have made the word bsky.app clickable in
// the middle of a sentence that was not offering it as a destination.
//
// When the agent wants to give you a link it writes the whole URL, which is
// what the tool results contain anyway. The cost of this is that a bare domain
// renders as plain text; the benefit is that prose stays prose.
const LINK_RE = /()(https?:\/\/[^\s<>()\[\]]+)/gi;

// Trailing punctuation that is almost always sentence punctuation rather than
// part of the URL. A closing paren is only trimmed when unbalanced.
function trimTrailing(url) {
  let out = url.replace(/[.,;:!?]+$/, '');
  if (out.endsWith(')') && !out.includes('(')) out = out.replace(/\)+$/, '');
  return out;
}

/**
 * Every link in `text`, with UTF-8 byte offsets.
 * Returns [{ uri, byteStart, byteEnd, text }].
 */
export function detectLinks(text) {
  const out = [];
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const lead = m[1] ?? '';
    const raw = m[2];
    if (!raw) continue;
    const trimmed = trimTrailing(raw);
    if (!trimmed) continue;

    const startUtf16 = m.index + lead.length;
    const byteStart = utf8Offset(text, startUtf16);
    const byteEnd = byteStart + Buffer.byteLength(trimmed, 'utf8');
    out.push({ uri: trimmed, byteStart, byteEnd, index: startUtf16, text: trimmed });
  }
  return out;
}

/** Facets for the links in `text`. Link facets only — never mention facets. */
export function linkFacets(text) {
  return detectLinks(text).map((l) => ({
    index: { byteStart: l.byteStart, byteEnd: l.byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: l.uri }],
  }));
}

// @handle-shaped tokens in a draft. The poster never builds mention facets, so
// one of these notifies nobody — but it still reads as a tag, and a draft that
// tags a third party is the ugliest thing a prompt injection can talk the model
// into. The outbound gate rejects on this.
const HANDLE_RE = /(^|[\s(\[{<"'])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

export function detectHandles(text) {
  const out = [];
  HANDLE_RE.lastIndex = 0;
  let m;
  while ((m = HANDLE_RE.exec(text)) !== null) out.push(m[2].toLowerCase());
  return out;
}

/**
 * The official client's link display form, from social-app's toShortUrl():
 * host plus path, with the path cut to 13 characters and an ellipsis when it
 * runs past 15.
 */
export function toShortUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    const path = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    if (path.length > 15) return u.host + path.slice(0, 13) + '...';
    return u.host + path;
  } catch {
    return url;
  }
}

/**
 * Rewrite a draft the way the Bluesky composer does: the visible text carries
 * the shortened link, the facet carries the real URL.
 *
 * This is not cosmetic. The lexicon's 300-grapheme limit applies to `text`, and
 * `text` is what the client stores -- verified against live posts on
 * 2026-09-23, where "flightaware" (11 chars) fronted a 64-character URL. Writing
 * the full URL into the text, as this did originally, spends the answer's
 * budget on characters nobody reads. An aturi.to record link costs 22 graphemes
 * shortened against 34 written out.
 *
 * Returns the rewritten text and its facets, with offsets computed on the
 * rewritten string.
 */
export function shortenLinks(text) {
  const links = detectLinks(text);
  if (!links.length) return { text, facets: [] };

  let out = '';
  let cursor = 0;
  const facets = [];
  for (const l of links) {
    out += text.slice(cursor, l.index);
    const shown = toShortUrl(l.uri);
    const byteStart = Buffer.byteLength(out, 'utf8');
    out += shown;
    facets.push({
      index: { byteStart, byteEnd: Buffer.byteLength(out, 'utf8') },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: l.uri }],
    });
    cursor = l.index + l.text.length;
  }
  out += text.slice(cursor);
  return { text: out, facets };
}

const LINK_FEATURE = 'app.bsky.richtext.facet#link';
const bareUrl = (s) => s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

/**
 * The inverse of shortenLinks, for text going to the agent: each link facet's
 * visible text becomes the URL it points at.
 *
 * A post's `text` holds the shortened display form, so without this the agent
 * is handed "github.com/bluesky-so..." and cannot follow or name the link it is
 * being asked about. Display text that is not a shortening of its URL, the
 * "click here" kind, keeps its words and gets the real destination beside it.
 *
 * Facets are UTF-8 byte ranges; malformed or overlapping ones are skipped.
 */
export function expandLinks(text, facets) {
  if (typeof text !== 'string' || !Array.isArray(facets) || !facets.length) return text ?? '';
  const bytes = Buffer.from(text, 'utf8');
  const links = [];
  for (const f of facets) {
    const uri = f?.features?.find((x) => x?.$type === LINK_FEATURE)?.uri;
    const start = f?.index?.byteStart;
    const end = f?.index?.byteEnd;
    if (typeof uri !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end > bytes.length || start >= end) continue;
    links.push({ start, end, uri });
  }
  links.sort((a, b) => a.start - b.start);

  const out = [];
  let cursor = 0;
  for (const { start, end, uri } of links) {
    if (start < cursor) continue;
    const shown = bytes.subarray(start, end).toString('utf8');
    const stem = bareUrl(shown.replace(/(\.\.\.|…)$/, ''));
    const replacement = stem && bareUrl(uri).startsWith(stem) ? uri : `${shown} (${uri})`;
    out.push(bytes.subarray(cursor, start), Buffer.from(replacement, 'utf8'));
    cursor = end;
  }
  out.push(bytes.subarray(cursor));
  return Buffer.concat(out).toString('utf8');
}

// --- the potato's faces -----------------------------------------------------
// Every face in the palette (skills/bluesky-reply.md) is built on two ◕ eyes,
// and nothing else the potato writes uses that character, so a run of non-space
// characters containing one is a face.
const FACE = /[^\s]*◕[^\s]*/gu;
const FACE_WITH_SPACE = /[ \t]*[^\s]*◕[^\s]*/gu;

export function facesIn(text) {
  return String(text ?? '').match(FACE) ?? [];
}

/**
 * The draft to post, with its face left off when the moment has had enough of
 * them. Two rules, because the prompt alone did not hold (2026-09-24: six of
 * eight plain technical answers still wore a face after being told plainly
 * that a plain answer never needs one):
 *
 *   - Never two replies running in a thread. The same face twice was the tic
 *     at its most obvious: two answers five minutes apart, both ending (◕‿◕).
 *   - Only on a short reply. Every hello, thanks, goodnight and compliment in
 *     that day's samples came in under 200 graphemes, and nearly every real
 *     answer over it. A face on a long answer reads as a signature, not a mood.
 */
export function faceRules(draft, { previousInThread = null, maxGraphemes = null } = {}) {
  if (!facesIn(draft).length) return draft;
  const bare = String(draft)
    .replace(FACE_WITH_SPACE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (facesIn(previousInThread).length) return bare;
  if (maxGraphemes != null && graphemeLength(bare) > maxGraphemes) return bare;
  return draft;
}

// --- splitting a long answer across posts ---------------------------------

// Abbreviations whose trailing dot is not a sentence end.
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'no', 'fig', 'al']);

/**
 * Sentence boundaries, for this voice and this subject matter.
 *
 * Intl.Segmenter is the obvious tool and it does not work here: it wants a
 * capital letter after the period, and the potato writes lowercase, so a whole
 * multi-sentence answer comes back as one segment. Checked on 2026-09-23.
 *
 * The rules that matter for atproto text:
 *   - a break needs punctuation followed by whitespace, so the dots inside
 *     `app.bsky.feed.post`, `handle.invalid` and `atpota.to` are never breaks
 *   - a dot inside a URL is never a break, even before a space
 *   - "e.g." and friends are not sentence ends
 *   - a blank line is always a break
 */
export function splitSentences(text) {
  const linkSpans = detectLinks(text).map((l) => [l.index, l.index + l.text.length]);
  const inLink = (i) => linkSpans.some(([a, b]) => i >= a && i < b);

  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      // A newline ends whatever came before it.
      const piece = text.slice(start, i + 1);
      if (piece.trim()) out.push(piece);
      start = i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;
    if (inLink(i)) continue;
    // Run past "?!" and "..."
    let j = i;
    while (j + 1 < text.length && '.?!'.includes(text[j + 1])) j++;
    const next = text[j + 1];
    if (next !== undefined && !/\s/.test(next)) { i = j; continue; }

    const before = text.slice(start, i);
    const lastWord = (before.match(/(\S+)$/)?.[1] ?? '').toLowerCase();
    if (ABBREVIATIONS.has(lastWord)) { i = j; continue; }

    // Swallow ALL following whitespace, newlines included. Advancing over only
    // spaces and tabs left the newlines to be dropped as whitespace-only
    // segments, so rejoining the sentences silently deleted the separator and
    // produced "them.https://aturi.to/..." -- which then failed link detection
    // and posted an unclickable URL. Observed 2026-09-23.
    let end = j + 1;
    while (end < text.length && /\s/.test(text[end])) end++;
    out.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length && text.slice(start).trim()) out.push(text.slice(start));
  return out.length ? out : [text];
}

/**
 * Pack an answer into as few posts as it fits in, splitting only at sentence
 * boundaries so nothing is cut mid-thought.
 *
 * Each post is measured on its STORED form: links are shortened first, exactly
 * as the poster will write them, so the limit is charged against what a reader
 * actually sees.
 *
 * Returns { ok, posts } where each post is { text, facets, graphemes, bytes }.
 * Fails rather than truncating when a single sentence cannot fit alone, or when
 * the answer needs more posts than allowed.
 */
export function packIntoPosts(text, { maxGraphemes, maxBytes, maxPosts }) {
  // Name whichever limit was actually exceeded. Reporting graphemes when the
  // byte limit was the one that bound sends you looking in the wrong place:
  // 150 family emoji are 150 graphemes and 3,750 bytes.
  const overBy = (m) => (m.graphemes > maxGraphemes
    ? `${m.graphemes} graphemes, over the ${maxGraphemes} limit`
    : `${m.bytes} bytes, over the ${maxBytes} limit`);

  const measure = (raw) => {
    const { text: stored, facets } = shortenLinks(raw.trim());
    return { text: stored, facets, graphemes: graphemeLength(stored), bytes: byteLength(stored) };
  };

  const whole = measure(text);
  if (whole.graphemes <= maxGraphemes && whole.bytes <= maxBytes) {
    return { ok: true, posts: [whole] };
  }

  const sentences = splitSentences(text);
  const posts = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current + sentence;
    const m = measure(candidate);
    if (m.graphemes <= maxGraphemes && m.bytes <= maxBytes) { current = candidate; continue; }

    if (!current.trim()) {
      // One sentence that does not fit on its own. Breaking inside it would cut
      // a thought in half, which is the thing this exists to avoid.
      const solo = measure(sentence);
      return { ok: false, reason: `a single sentence is ${overBy(solo)}, and splitting it would cut mid-sentence` };
    }
    posts.push(measure(current));
    current = sentence;
    if (posts.length >= maxPosts) break;
  }
  if (current.trim()) posts.push(measure(current));

  if (posts.length > maxPosts) {
    return { ok: false, reason: `answer needs ${posts.length} posts, cap is ${maxPosts}` };
  }
  const over = posts.find((p) => p.graphemes > maxGraphemes || p.bytes > maxBytes);
  if (over) return { ok: false, reason: `a post is ${overBy(over)}` };

  return { ok: true, posts };
}
