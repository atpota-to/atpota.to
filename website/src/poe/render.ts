/**
 * The safe renderer: the ONLY way Poe's answer text reaches the DOM (SPEC 4.6,
 * render contract in understand-poe.md 5.3). Nodes are built with createElement
 * and text nodes; there is no innerHTML anywhere in the widget.
 *
 *   blank-line separated paragraphs  -> <p> (single newlines -> <br>)
 *   lines starting "- "              -> <ul><li>
 *   `x`                              -> <code>
 *   ``` fences                       -> <pre><code>
 *   bare https:// URL                -> <a target=_blank rel="noopener noreferrer nofollow ugc"> showing the
 *                                       full URL, ONLY when it appears exactly (after trimming trailing
 *                                       .,;:!?) ) in this turn's links, uses https, has no credentials and an
 *                                       ASCII host; at most 3 per answer
 *   any other URL                    -> grey text (<span class="poe-url">)
 *   at:// and did: strings           -> <code class="poe-id">, never links
 *   trailing kaomoji with a ◕        -> <span aria-hidden="true">
 *   anything else (**, #, [x](y), <html>) stays literal text
 */

export const MAX_LINKS_PER_ANSWER = 3;
const MAX_RENDER_CHARS = 20_000;
const LINK_REL = 'noopener noreferrer nofollow ugc';
const TRAILING_PUNCT = '.,;:!?)';

export interface RenderResult {
  fragment: DocumentFragment;
  /** The links that became anchors, in order (what the transcript stores). */
  links: string[];
  /** Readable text for the live region: no kaomoji, no markup. */
  plain: string;
}

interface Ctx {
  doc: Document;
  allowed: Set<string>;
  links: string[];
  max: number;
  plain: string[];
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'pre'; text: string };

/** Splits answer text into paragraphs, lists and fenced code. Pure; exported for tests. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] | null = null;
  let list: string[] | null = null;
  const flush = () => {
    if (para && para.length) blocks.push({ kind: 'p', lines: para });
    if (list && list.length) blocks.push({ kind: 'ul', items: list });
    para = null;
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s{0,3}```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      blocks.push({ kind: 'pre', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const item = /^\s{0,3}[-•]\s+(.*)$/.exec(line);
    if (item) {
      if (para) {
        blocks.push({ kind: 'p', lines: para });
        para = null;
      }
      list ??= [];
      list.push((item[1] as string).trim());
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // indented continuation of the previous list item
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) {
      blocks.push({ kind: 'ul', items: list });
      list = null;
    }
    para ??= [];
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function isAsciiHost(host: string): boolean {
  return /^[a-z0-9.-]+$/i.test(host);
}

/**
 * The exact-match link rule. Returns the clickable URL for a raw candidate (as
 * found in the text) or null. Tries the raw match first, then strips trailing
 * punctuation one character at a time, so "https://x.to/a)." links "https://x.to/a"
 * while a links-set entry that really ends in ")" still matches.
 */
export function matchAllowedLink(raw: string, allowed: ReadonlySet<string>): string | null {
  let candidate = raw;
  for (;;) {
    if (allowed.has(candidate) && isSafeHttps(candidate)) return candidate;
    const last = candidate.charAt(candidate.length - 1);
    if (!last || !TRAILING_PUNCT.includes(last)) return null;
    candidate = candidate.slice(0, -1);
  }
}

export function isSafeHttps(url: string): boolean {
  if (!url.startsWith('https://')) return false;
  if (/[\s<>"'`\\\u0000-\u001f\u007f]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  // Reject any "@" before the path (userinfo, even if URL() normalised it away).
  const authority = url.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return false;
  const host = authority.replace(/:\d+$/, '');
  if (!host || !isAsciiHost(host) || !parsed.hostname.includes('.')) return false;
  return true;
}

/** Trailing sentence punctuation after a URL that is not part of it. */
function splitTrailing(raw: string): [string, string] {
  let end = raw.length;
  while (end > 0 && TRAILING_PUNCT.includes(raw.charAt(end - 1))) end--;
  return [raw.slice(0, end), raw.slice(end)];
}

// URL-ish tokens, at:// URIs and DIDs. Linear, no nested quantifiers.
const TOKEN_RE = /(https?:\/\/[^\s<>"'`]+)|(at:\/\/[^\s<>"'`]+)|(did:[a-z]+:[A-Za-z0-9._:%-]+)/g;

function appendText(parent: Node, text: string, ctx: Ctx): void {
  if (!text) return;
  parent.appendChild(ctx.doc.createTextNode(text));
  ctx.plain.push(text);
}

function appendCode(parent: Node, text: string, ctx: Ctx, className?: string): void {
  const code = ctx.doc.createElement('code');
  if (className) code.className = className;
  code.textContent = text;
  parent.appendChild(code);
  ctx.plain.push(text);
}

/** Text outside code spans: URLs, at:// URIs and DIDs. */
function appendLinked(parent: Node, text: string, ctx: Ctx): void {
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    // A scheme glued to a word ("chat://", "candid:x:y") is not a URL or DID.
    if (m.index > 0 && /[A-Za-z0-9]/.test(text.charAt(m.index - 1))) {
      TOKEN_RE.lastIndex = m.index + 1;
      continue;
    }
    appendText(parent, text.slice(last, m.index), ctx);
    const raw = m[0];
    if (m[1]) {
      const href = ctx.links.length < ctx.max ? matchAllowedLink(raw, ctx.allowed) : null;
      if (href) {
        const a = ctx.doc.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = LINK_REL;
        a.className = 'poe-link';
        a.textContent = href;
        parent.appendChild(a);
        ctx.plain.push(href);
        ctx.links.push(href);
        appendText(parent, raw.slice(href.length), ctx);
      } else {
        const [url, trail] = splitTrailing(raw);
        const span = ctx.doc.createElement('span');
        span.className = 'poe-url';
        span.textContent = url;
        parent.appendChild(span);
        ctx.plain.push(url);
        appendText(parent, trail, ctx);
      }
    } else {
      const [id, trail] = splitTrailing(raw);
      appendCode(parent, id, ctx, 'poe-id');
      appendText(parent, trail, ctx);
    }
    last = m.index + raw.length;
  }
  appendText(parent, text.slice(last), ctx);
}

/** Inline text: `code` spans first (never linkified), then URLs in the rest. */
function appendInline(parent: Node, text: string, ctx: Ctx): void {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('`', i);
    if (open === -1) break;
    const close = text.indexOf('`', open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // "``" is not a code span; keep it literal
      appendLinked(parent, text.slice(i, close + 1), ctx);
      i = close + 1;
      continue;
    }
    appendLinked(parent, text.slice(i, open), ctx);
    const inner = text.slice(open + 1, close);
    const isId = /^(at:\/\/|did:)/.test(inner);
    appendCode(parent, inner, ctx, isId ? 'poe-id' : undefined);
    i = close + 1;
  }
  appendLinked(parent, text.slice(i), ctx);
}

/**
 * Finds a trailing kaomoji: the last whitespace-separated token, if it contains
 * "◕". Letters/digits glued in front of the face (as in "thanks(◕‿◕)") stay
 * visible. Returns [before, face] or null.
 */
export function splitTrailingFace(text: string): [string, string] | null {
  const trimmed = text.replace(/\s+$/, '');
  const start = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\n'), trimmed.lastIndexOf('\t')) + 1;
  const token = trimmed.slice(start);
  const eye = token.indexOf('◕');
  if (eye === -1) return null;
  let faceStart = 0;
  for (let i = eye - 1; i >= 0; i--) {
    if (/[A-Za-z0-9]/.test(token.charAt(i))) {
      faceStart = i + 1;
      break;
    }
  }
  const face = token.slice(faceStart);
  if (token.includes('`') || token.includes('://')) return null; // part of a code span or a URL
  return [trimmed.slice(0, start + faceStart), face];
}

function appendFace(parent: Node, face: string, ctx: Ctx): void {
  const span = ctx.doc.createElement('span');
  span.className = 'poe-face';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = face;
  parent.appendChild(span);
}

/** Renders a final answer. `links` is the turn's set from the done event (or a stored subset). */
export function renderAnswer(text: string, links: Iterable<string> = [], doc: Document = document, max = MAX_LINKS_PER_ANSWER): RenderResult {
  const ctx: Ctx = { doc, allowed: new Set(links), links: [], max, plain: [] };
  const fragment = doc.createDocumentFragment();
  let source = typeof text === 'string' ? text : '';
  if (source.length > MAX_RENDER_CHARS) source = `${source.slice(0, MAX_RENDER_CHARS)}…`;
  const blocks = parseBlocks(source);

  // Peel a trailing kaomoji off the last paragraph or list item.
  let face: string | null = null;
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock && lastBlock.kind !== 'pre') {
    const arr = lastBlock.kind === 'p' ? lastBlock.lines : lastBlock.items;
    const idx = arr.length - 1;
    const split = splitTrailingFace(arr[idx] as string);
    if (split) {
      face = split[1];
      arr[idx] = split[0];
      if (arr[idx] === '' && arr.length > 1 && lastBlock.kind === 'p') arr.pop();
    }
  }

  blocks.forEach((block, index) => {
    if (index > 0) ctx.plain.push('\n\n');
    if (block.kind === 'pre') {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = block.text;
      pre.appendChild(code);
      fragment.appendChild(pre);
      ctx.plain.push(block.text);
      return;
    }
    if (block.kind === 'ul') {
      const ul = doc.createElement('ul');
      block.items.forEach((item, i) => {
        if (i > 0) ctx.plain.push('\n');
        const li = doc.createElement('li');
        appendInline(li, item, ctx);
        ul.appendChild(li);
      });
      fragment.appendChild(ul);
      return;
    }
    const p = doc.createElement('p');
    block.lines.forEach((line, i) => {
      if (i > 0) {
        p.appendChild(doc.createElement('br'));
        ctx.plain.push('\n');
      }
      appendInline(p, line, ctx);
    });
    fragment.appendChild(p);
  });

  if (face) {
    const host = fragment.lastElementChild;
    const target = host?.tagName === 'UL' ? host.lastElementChild : host;
    if (target && target.tagName !== 'PRE') {
      if (target.lastChild) target.appendChild(doc.createTextNode(' '));
      appendFace(target, face, ctx);
    } else {
      const p = doc.createElement('p');
      appendFace(p, face, ctx);
      fragment.appendChild(p);
    }
  }

  return { fragment, links: ctx.links, plain: ctx.plain.join('').replace(/[ \t]+\n/g, '\n').trim() };
}
