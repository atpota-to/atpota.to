// dispatch-markdown.js
// Poe writes an issue of the dispatch in a small markdown dialect; this turns it
// into the Leaflet content a site.standard.document carries (pub.leaflet.content,
// one linear page of blocks), plus the plain textContent beside it. The same
// record is what the preview shows and what is published, so the operator
// approves exactly what goes out.
//
// The dialect, which bot/agent/skills/dispatch-issue.md teaches Poe:
//
//   ## heading               a header block (# to ######, levels 1 to 6)
//   a paragraph              a text block; lines that follow without a blank
//                            line between are the same paragraph
//   - item / * item          an unordered list; indent two spaces to nest
//   1. item                  an ordered list
//   > quote                  a blockquote
//   ---                      a horizontal rule
//   {{subscribe}}            Leaflet's subscribe form (a signup block)
//   https://… alone          a link card (website block), or a Bluesky post
//                            embed for a bsky.app post link; filled in by
//                            enrichBlocks(), which needs the network
//   ```lang … ```            a code block
//
// Inline: **bold**, *italic* or _italic_, `code`, ~~strike~~, [text](https://…),
// and bare https:// links, all as Leaflet facets with UTF-8 byte offsets. A
// backslash escapes a marker. Links must be http(s); anything else is left as
// plain text, with a note saying so.
//
// Notes are for Poe to fix (a link left as text, a ** that doesn't close, a
// card that couldn't be looked up) and never stop a save. Problems do: an issue
// that can't be published as it is.
//
// No mention facets are ever made, so an issue notifies nobody, whatever its
// text says. Zero dependencies, like the rest of this service.

import { byteLength, graphemeLength, utf8Offset } from './richtext.js';

export const LEAFLET_CONTENT = 'pub.leaflet.content';
const T = 'pub.leaflet.blocks.';
const PAGE = 'pub.leaflet.pages.linearDocument';
const FACET = 'pub.leaflet.richtext.facet';

export const MAX_MARKDOWN_CHARS = 60000;
const MAX_BLOCKS = 400;
const MAX_LIST_DEPTH = 4;

const SIGNUP_LINE = /^\{\{\s*subscribe\s*\}\}$/i;
const EMBED_LINE = /^<?(https?:\/\/[^\s<>]+?)>?$/;
const HR_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const HEADER_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_LINE = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_LINE = /^>\s?(.*)$/;
const FENCE_LINE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]{0,40})\s*$/;

/** Whether a link may go in an issue: an absolute http(s) URL without credentials. */
export function linkable(uri) {
  try {
    const u = new URL(uri);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !!u.hostname;
  } catch {
    return false;
  }
}

// --- inline ---------------------------------------------------------------------

const ESCAPABLE = /[\\`*_[\]()~<>#+\-.!{}|]/;
const isSpace = (c) => c === undefined || /\s/u.test(c);
const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

// Poe's kaomoji are full of markdown's markers: (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧ has a *, (⊙_⊙;) a _,
// ¯\_(ツ)_/¯ both a backslash and a _. Two faces in one paragraph would pair up
// and italicize everything between them, so a word holding any of these
// characters is a face and is kept exactly as written.
const FACE_CHARS = /[◕⊙ᵕ˃˂ಠ･ﾟヮ‿ωﾉ✧⸜⸝｡•°∀▽´｀╥﹏╯□︵┻━¯ツ≧≦ノ⌒ʘ]/u;

/** The face starting at `i` (a run of non-space characters with a face character), or null. */
function faceAt(src, i) {
  if (!isSpace(src[i - 1]) && src[i - 1] !== '(') return null;
  const m = /^\S+/u.exec(src.slice(i));
  if (!m || !FACE_CHARS.test(m[0]) || /^(?:\[|<|https?:)/i.test(m[0])) return null;
  return m[0];
}

/** CommonMark's flanking rules: whether a delimiter run can open or close emphasis. */
function flanking(before, after, word) {
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  if (!word) return { open: left, close: right };
  // _ never opens or closes inside a word (snake_case stays as it is).
  return { open: left && (!right || isPunct(before)), close: right && (!left || isPunct(after)) };
}

/** A URL at the start of `s`, with trailing punctuation left in the text, or null. */
function bareUrlAt(s) {
  const m = /^https?:\/\/[^\s<>"]+/.exec(s);
  if (!m) return null;
  let url = m[0];
  // Sentence punctuation after a link is the sentence's, and a closing paren is
  // only the link's when the link opened one.
  for (;;) {
    const last = url.at(-1);
    if (/[.,;:!?'"*_~]/.test(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) { url = url.slice(0, -1); continue; }
    break;
  }
  return url.length > 'https://'.length ? url : null;
}

/** The index of the `]` closing the `[` at `open`, or -1. */
function closingBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) { i = end; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** The `(url)` right after a link's text, or null. */
function linkTarget(src, at) {
  if (src[at] !== '(') return null;
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const inside = src.slice(at + 1, i).trim().replace(/^<(.*)>$/, '$1');
      // A title after the URL ("url 'title'") is dropped, as Leaflet has nowhere to put it.
      return { uri: inside.split(/\s+/)[0] ?? '', end: i + 1 };
    }
  }
  return null;
}

/** Tokens for one run of inline text: text, delimiters, code, links. */
function tokenize(src, notes, inLink = false) {
  const tokens = [];
  let text = '';
  const flush = () => { if (text) { tokens.push({ t: 'text', v: text }); text = ''; } };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const face = faceAt(src, i);
    if (face) { text += face; i += face.length; continue; }
    if (c === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) { text += src[i + 1]; i += 2; continue; }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) { flush(); tokens.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (c === '[' && !inLink) {
      const close = closingBracket(src, i);
      const target = close > i ? linkTarget(src, close + 1) : null;
      if (target) {
        flush();
        const label = src.slice(i + 1, close);
        if (linkable(target.uri)) {
          tokens.push({ t: 'link', uri: target.uri, inner: tokenize(label, notes, true) });
        } else {
          notes.push(`the link "${label}" goes to "${target.uri}", which isn't an http(s) link, so it was left as plain text`);
          tokens.push(...tokenize(label, notes, true));
        }
        i = target.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(i));
      if (m && linkable(m[1])) { flush(); tokens.push({ t: 'auto', uri: m[1] }); i += m[0].length; continue; }
    }
    if ((c === 'h' || c === 'H') && !inLink && !isWordChar(src[i - 1])) {
      const url = bareUrlAt(src.slice(i));
      if (url && linkable(url)) { flush(); tokens.push({ t: 'auto', uri: url }); i += url.length; continue; }
    }
    const double = src.slice(i, i + 2);
    if (double === '**' || double === '__' || double === '~~') {
      flush();
      tokens.push({ t: 'delim', v: double, ...flanking(src[i - 1], src[i + 2], double === '__') });
      i += 2;
      continue;
    }
    if (c === '*' || c === '_') {
      flush();
      tokens.push({ t: 'delim', v: c, ...flanking(src[i - 1], src[i + 1], c === '_') });
      i += 1;
      continue;
    }
    text += c;
    i += 1;
  }
  flush();
  // Pair the delimiters: each closer takes the nearest open one of its kind, and
  // whatever opened between them is left as literal text.
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t !== 'delim') continue;
    if (tok.close) {
      const at = stack.findLastIndex((j) => tokens[j].v === tok.v);
      if (at >= 0 && tokens[stack[at]] !== tok) {
        tokens[stack[at]].pair = k;
        tok.paired = true;
        stack.length = at;
        continue;
      }
    }
    if (tok.open) stack.push(k);
  }
  return tokens;
}

const FEATURE = {
  '**': 'bold', __: 'bold', '*': 'italic', _: 'italic', '~~': 'strikethrough',
};

/** Write tokens into `out` (a { text, spans } accumulator). */
function emit(tokens, out) {
  const open = new Map();          // token index -> start offset
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === 'text') out.text += tok.v;
    else if (tok.t === 'code') {
      const start = out.text.length;
      out.text += tok.v;
      out.spans.push({ start, end: out.text.length, feature: { $type: `${FACET}#code` } });
    } else if (tok.t === 'auto') {
      const start = out.text.length;
      out.text += tok.uri;
      out.spans.push({ start, end: out.text.length, feature: { $type: `${FACET}#link`, uri: tok.uri } });
    } else if (tok.t === 'link') {
      const start = out.text.length;
      emit(tok.inner, out);
      if (out.text.length > start) {
        out.spans.push({ start, end: out.text.length, feature: { $type: `${FACET}#link`, uri: tok.uri } });
      }
    } else if (tok.t === 'delim') {
      if (tok.pair != null) open.set(tok.pair, out.text.length);
      else if (tok.paired) {
        const start = open.get(k);
        if (out.text.length > start) {
          out.spans.push({ start, end: out.text.length, feature: { $type: `${FACET}#${FEATURE[tok.v]}` } });
        }
      } else out.text += tok.v;
    }
  }
}

/** Inline markdown -> { plaintext, facets }. Facet offsets are UTF-8 bytes, as Leaflet's are. */
export function inlineRichText(src, notes = []) {
  const out = { text: '', spans: [] };
  emit(tokenize(src, notes), out);
  // Leading and trailing spaces are trimmed with every offset moved to match.
  const lead = out.text.length - out.text.trimStart().length;
  const plaintext = out.text.trim();
  const facets = out.spans
    .map((s) => ({ start: Math.max(0, s.start - lead), end: Math.min(plaintext.length, s.end - lead), feature: s.feature }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((s) => ({
      index: { byteStart: utf8Offset(plaintext, s.start), byteEnd: utf8Offset(plaintext, s.end) },
      features: [s.feature],
    }));
  if (/\*\*|~~/.test(plaintext.replace(/`[^`]*`/g, ''))) {
    notes.push(`a ** or ~~ in "${plaintext.slice(0, 60)}" doesn't close, so it shows literally`);
  }
  return facets.length ? { plaintext, facets } : { plaintext };
}

// --- blocks -----------------------------------------------------------------------

const wrap = (block) => ({ $type: `${PAGE}#block`, block });

function textBlock(type, src, notes, extra = {}) {
  return { $type: `${T}${type}`, ...extra, ...inlineRichText(src, notes) };
}

/** A run of list lines -> a list block, nested by indentation. */
function listBlock(items, notes) {
  // items: [{ indent, ordered, start, text }]
  const build = (from, indent, depth) => {
    const children = [];
    let i = from;
    while (i < items.length && items[i].indent >= indent) {
      const item = items[i];
      if (item.indent > indent && children.length && depth < MAX_LIST_DEPTH) {
        const nested = build(i, item.indent, depth + 1);
        children.at(-1).children = nested.children;
        i = nested.next;
        continue;
      }
      children.push({ $type: '', content: textBlock('text', item.text, notes) });
      i++;
    }
    return { children, next: i };
  };
  const ordered = items[0].ordered;
  const listType = ordered ? 'orderedList' : 'unorderedList';
  const stamp = (children) => children.map((c) => ({
    ...c,
    $type: `${T}${listType}#listItem`,
    ...(c.children ? { children: stamp(c.children) } : {}),
  }));
  const { children } = build(0, items[0].indent, 1);
  const block = { $type: `${T}${listType}`, children: stamp(children) };
  if (ordered && items[0].start !== 1) block.startIndex = items[0].start;
  return block;
}

/**
 * Markdown -> { blocks, notes, problems }. `blocks` are linearDocument#block wrappers.
 * Link-card lines come out as website blocks holding only `src`; enrichBlocks()
 * fills in their titles, and turns Bluesky post links into post embeds.
 */
export function markdownToBlocks(markdown) {
  const notes = [];
  const problems = [];
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = [];
  let para = [];
  let list = [];
  let quote = [];

  const endPara = () => {
    if (para.length) blocks.push(wrap(textBlock('text', para.join(' '), notes)));
    para = [];
  };
  const endList = () => {
    if (list.length) blocks.push(wrap(listBlock(list, notes)));
    list = [];
  };
  const endQuote = () => {
    if (quote.length) blocks.push(wrap(textBlock('blockquote', quote.join(' '), notes)));
    quote = [];
  };
  const endAll = () => { endPara(); endList(); endQuote(); };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();

    const fence = FENCE_LINE.exec(line);
    if (fence) {
      endAll();
      const body = [];
      let m = n + 1;
      for (; m < lines.length && !lines[m].trim().startsWith(fence[1]); m++) body.push(lines[m]);
      blocks.push(wrap({ $type: `${T}code`, plaintext: body.join('\n'), ...(fence[2] ? { language: fence[2] } : {}) }));
      n = m;
      continue;
    }
    if (!line) {
      endPara(); endQuote();
      // A blank line inside a list keeps the list going when the next line is an item.
      if (list.length && !LIST_LINE.test(lines[n + 1] ?? '')) endList();
      continue;
    }
    const listItem = LIST_LINE.exec(raw.replace(/\s+$/, ''));
    if (listItem && !HR_LINE.test(line.replace(/\s+/g, ''))) {
      endPara(); endQuote();
      const ordered = /\d/.test(listItem[2]);
      if (list.length && !list[0].ordered !== !ordered && listItem[1].length <= list[0].indent) endList();
      list.push({ indent: listItem[1].length, ordered, start: ordered ? parseInt(listItem[2], 10) : 1, text: listItem[3] });
      continue;
    }
    if (list.length && /^\s{2,}\S/.test(raw)) {
      // An indented line under an item carries on that item.
      list.at(-1).text += ` ${line}`;
      continue;
    }
    endList();
    if (HR_LINE.test(line.replace(/\s+/g, ''))) { endAll(); blocks.push(wrap({ $type: `${T}horizontalRule` })); continue; }
    if (SIGNUP_LINE.test(line)) { endAll(); blocks.push(wrap({ $type: `${T}signup` })); continue; }
    const header = HEADER_LINE.exec(line);
    if (header) {
      endAll();
      blocks.push(wrap(textBlock('header', header[2], notes, { level: header[1].length })));
      continue;
    }
    const q = QUOTE_LINE.exec(line);
    if (q) {
      endPara();
      if (q[1].trim()) quote.push(q[1].trim());
      else endQuote();
      continue;
    }
    endQuote();
    const embed = !para.length ? EMBED_LINE.exec(line) : null;
    if (embed && linkable(embed[1]) && bareUrlAt(embed[1]) === embed[1]) {
      blocks.push(wrap({ $type: `${T}website`, src: embed[1] }));
      continue;
    }
    para.push(line);
  }
  endAll();
  if (!blocks.some(({ block }) => block.plaintext?.trim() || block.children?.length)) problems.push('the issue has no text');
  if (blocks.length > MAX_BLOCKS) problems.push(`the issue has ${blocks.length} blocks; ${MAX_BLOCKS} is the most it can have`);
  return { blocks, notes, problems };
}

// --- link cards ---------------------------------------------------------------------

const BSKY_POST = /^https:\/\/(?:bsky\.app|staging\.bsky\.app)\/profile\/([^/?#]+)\/post\/([A-Za-z0-9._:~-]+)\/?$/;

/**
 * Fill in each link card: a Bluesky post link becomes a post embed (it needs the
 * post's cid), any other link a website card with the page's title and
 * description. Best effort: a card that can't be looked up stays a card with
 * just its link, and a note says so. `deps` (for tests): resolvePost(actor, rkey)
 * -> { uri, cid } | null, and fetchPageMeta(url) -> { title, description } | null.
 */
export async function enrichBlocks(blocks, deps) {
  // Every card is looked up at once, so a save with many cards takes as long as its slowest.
  const filled = await Promise.all(blocks.map(async (wrapper) => {
    const block = wrapper.block;
    if (block.$type !== `${T}website` || block.title || block.description) return { wrapper };
    const post = BSKY_POST.exec(block.src);
    if (post) {
      try {
        const ref = await deps.resolvePost(decodeURIComponent(post[1]), post[2]);
        if (ref?.uri && ref?.cid) return { wrapper: wrap({ $type: `${T}bskyPost`, postRef: { uri: ref.uri, cid: ref.cid } }) };
        return { wrapper, note: `the post ${block.src} couldn't be found, so it's a plain link card` };
      } catch (err) {
        return { wrapper, note: `the post ${block.src} couldn't be looked up (${err.message}), so it's a plain link card` };
      }
    }
    try {
      const meta = await deps.fetchPageMeta(block.src);
      const title = clean(meta?.title, 300);
      const description = clean(meta?.description, 500);
      return {
        wrapper: wrap({ $type: `${T}website`, src: block.src, ...(title ? { title } : {}), ...(description ? { description } : {}) }),
        ...(title ? {} : { note: `${block.src} has no title to show on its card` }),
      };
    } catch (err) {
      return { wrapper, note: `${block.src} couldn't be read for its card (${err.message}), so the card shows only the link` };
    }
  }));
  return { blocks: filled.map((f) => f.wrapper), notes: filled.map((f) => f.note).filter(Boolean) };
}

function clean(value, maxGraphemes) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (graphemeLength(text) <= maxGraphemes) return text;
  return `${[...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].slice(0, maxGraphemes - 1).map((s) => s.segment).join('').trimEnd()}…`;
}

// --- the document -------------------------------------------------------------------

/** The issue's plain text, one paragraph per block, as Leaflet writes textContent. */
export function blocksText(blocks) {
  const parts = [];
  const items = (children) => {
    for (const item of children ?? []) {
      if (item.content?.plaintext?.trim()) parts.push(item.content.plaintext.trim());
      items(item.children);
    }
  };
  for (const { block } of blocks) {
    if (block.$type === `${T}unorderedList` || block.$type === `${T}orderedList`) items(block.children);
    else if (block.$type !== `${T}code` && typeof block.plaintext === 'string' && block.plaintext.trim()) {
      parts.push(block.plaintext.trim());
    }
  }
  return parts.join('\n\n');
}

/** Why the issue's title, description or tags can't be published as they are, or []. */
export function metaProblems({ title, description, tags }) {
  const problems = [];
  if (typeof title !== 'string' || !title.trim()) problems.push('the issue needs a title');
  else if (graphemeLength(title.trim()) > 200) problems.push(`the title is ${graphemeLength(title.trim())} characters; keep it under 200`);
  if (description != null && typeof description !== 'string') problems.push('the description must be text');
  else if (description && graphemeLength(description.trim()) > 500) problems.push('the description is over 500 characters');
  if (tags != null && (!Array.isArray(tags) || tags.length > 20 ||
      tags.some((t) => typeof t !== 'string' || !t.trim() || graphemeLength(t.trim()) > 50))) {
    problems.push('tags must be up to 20 short words or phrases');
  }
  return problems;
}

/**
 * The site.standard.document an issue is published as, without the two fields
 * only publishing knows: publishedAt and path (both set from the record key).
 */
export function draftRecord({ title, description, tags, blocks }, { publicationUri, authorDid }) {
  const record = {
    $type: 'site.standard.document',
    site: publicationUri,
    title: title.trim(),
    ...(description?.trim() ? { description: description.trim() } : {}),
    ...(tags?.length ? { tags: [...new Set(tags.map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))] } : {}),
    textContent: blocksText(blocks),
    content: { $type: LEAFLET_CONTENT, pages: [{ $type: PAGE, blocks }] },
    contributors: [{ did: authorDid }],
  };
  return record;
}

/** Bytes of the record as JSON, a stand-in for its size on the PDS. */
export function recordSize(record) {
  return byteLength(JSON.stringify(record));
}
