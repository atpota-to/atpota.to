import { describe, expect, it } from 'vitest';
import { normalizeAgentUrl, parseTimeout, readConfig } from '../server/config.js';
import {
  CONVERSATION_ID_RE,
  clearedCookie,
  conversationCookie,
  isInsecureLocalhost,
  newConversationId,
  readConversationId,
} from '../server/cookie.js';
import { errorName } from '../server/log.js';
import { ERROR_CODES, MESSAGES } from '../server/messages.js';
import { isAllowedOrigin } from '../server/origin.js';
import { mockAnswer, mockPreStream, mockWantsLink } from '../server/poe-mock.js';
import { SlidingWindowLimiter, clientIp, createLocalLimiter } from '../server/rate-limit.js';
import { canonicalPath, pageTitle } from '../server/routes.js';
import { SseOverflowError, SseParser, encodeEvent } from '../server/sse.js';
import { FALLBACK_LABEL, TOOL_LABELS, baseToolName, toolLabel } from '../server/tool-labels.js';
import { clip, cleanLinks, safeErrorMessage, toErrorCode, upstreamBody } from '../server/upstream.js';
import { normalizeSelection, readBodyCapped, sanitizePath, validateChat } from '../server/validation.js';

describe('config', () => {
  it('reads the documented env vars', () => {
    const c = readConfig({
      WEBSITE_SHARED_SECRET: 's3cret',
      POE_AGENT_URL: 'https://bot.example/',
      POE_CHAT_DISABLED: '1',
      POE_RATE_LIMIT_ID: ' poe-chat ',
      POE_MOCK: '1',
      POE_UPSTREAM_TIMEOUT_MS: '5000',
    });
    expect(c).toEqual({
      secret: 's3cret',
      agentUrl: 'https://bot.example',
      disabled: true,
      rateLimitId: 'poe-chat',
      mock: true,
      upstreamTimeoutMs: 5000,
      production: false,
    });
  });

  it('defaults and empties', () => {
    const c = readConfig({ WEBSITE_SHARED_SECRET: '', POE_RATE_LIMIT_ID: '  ' });
    expect(c.secret).toBeNull();
    expect(c.agentUrl).toBe('https://atpotato-bot.vercel.app');
    expect(c.disabled).toBe(false);
    expect(c.rateLimitId).toBeNull();
    expect(c.mock).toBe(false);
    expect(c.upstreamTimeoutMs).toBe(240_000);
  });

  it('ignores POE_MOCK in production', () => {
    expect(readConfig({ POE_MOCK: '1', VERCEL_ENV: 'production' }).mock).toBe(false);
    expect(readConfig({ POE_MOCK: '1', VERCEL_ENV: 'preview' }).mock).toBe(true);
    expect(readConfig({ POE_MOCK: '0' }).mock).toBe(false);
  });

  it('clamps the upstream timeout below maxDuration', () => {
    expect(parseTimeout(undefined)).toBe(240_000);
    expect(parseTimeout('abc')).toBe(240_000);
    expect(parseTimeout('-5')).toBe(240_000);
    expect(parseTimeout('10')).toBe(1000);
    expect(parseTimeout('999999')).toBe(290_000);
    expect(parseTimeout('120000')).toBe(120_000);
  });

  it('accepts https agent URLs (and http only on loopback)', () => {
    expect(normalizeAgentUrl('https://x.example/a/b//')).toBe('https://x.example/a/b');
    expect(normalizeAgentUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeAgentUrl('http://x.example')).toBeNull();
    expect(normalizeAgentUrl('https://x.example/?q=1')).toBeNull();
    expect(normalizeAgentUrl('https://u:p@x.example')).toBeNull();
    expect(normalizeAgentUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('validation', () => {
  it('sanitizes paths', () => {
    expect(sanitizePath('/guides/bluesky-for-brands')).toBe('/guides/bluesky-for-brands');
    expect(sanitizePath('/a_b.c-d/E9')).toBe('/a_b.c-d/E9');
    expect(sanitizePath('')).toBe('/');
    expect(sanitizePath('guides')).toBe('/');
    expect(sanitizePath('/a b')).toBe('/');
    expect(sanitizePath('/ü')).toBe('/');
    expect(sanitizePath('/x#y')).toBe('/');
    expect(sanitizePath(`/${'a'.repeat(200)}`)).toBe(`/${'a'.repeat(200)}`);
    expect(sanitizePath(`/${'a'.repeat(201)}`)).toBe('/');
    expect(sanitizePath(null)).toBe('/');
  });

  it('collapses selection whitespace', () => {
    expect(normalizeSelection('  a\n\n b\t\tc  ')).toBe('a b c');
  });

  it('validates the body shape', () => {
    expect(validateChat({ message: ' hi ', path: '/x', selection: '  ' })).toEqual({ ok: true, value: { message: 'hi', path: '/x' } });
    expect(validateChat({ message: 'hi', selection: null })).toEqual({ ok: true, value: { message: 'hi', path: '/' } });
    expect(validateChat([])).toEqual({ ok: false, reason: 'not_object' });
    expect(validateChat({ message: 1 })).toEqual({ ok: false, reason: 'message_missing' });
    expect(validateChat({ message: ' ' })).toEqual({ ok: false, reason: 'message_empty' });
    expect(validateChat({ message: '🥔'.repeat(501) })).toEqual({ ok: false, reason: 'message_too_long' });
    expect(validateChat({ message: 'a', selection: {} })).toEqual({ ok: false, reason: 'selection_type' });
    expect(validateChat({ message: 'a', selection: 'b'.repeat(2001) })).toEqual({ ok: false, reason: 'selection_too_long' });
    // A long run of whitespace collapses below the cap.
    expect(validateChat({ message: 'a', selection: `x${' '.repeat(5000)}y` })).toEqual({
      ok: true,
      value: { message: 'a', path: '/', selection: 'x y' },
    });
  });

  it('reads bodies up to the cap', async () => {
    const ok = await readBodyCapped(new Request('https://a.example', { method: 'POST', body: 'x'.repeat(8192) }));
    expect(ok).toEqual({ ok: true, text: 'x'.repeat(8192) });
    const big = await readBodyCapped(new Request('https://a.example', { method: 'POST', body: 'x'.repeat(8193) }));
    expect(big).toEqual({ ok: false, reason: 'too_large' });
    const multi = await readBodyCapped(new Request('https://a.example', { method: 'POST', body: 'é'.repeat(4097) }));
    expect(multi).toEqual({ ok: false, reason: 'too_large' }); // 8194 bytes
  });
});

describe('routes', () => {
  it('maps paths to server-side titles', () => {
    expect(pageTitle('/')).toBe('atpota.to home');
    expect(pageTitle('/index.html')).toBe('atpota.to home');
    expect(pageTitle('/guides/bluesky-for-brands')).toBe('How to use Bluesky to grow your brand');
    expect(pageTitle('/guides/bluesky-for-brands/')).toBe('How to use Bluesky to grow your brand');
    expect(pageTitle('/guides/bluesky-for-brands.html')).toBe('How to use Bluesky to grow your brand');
    expect(pageTitle('/404')).toBe('atpota.to');
    expect(pageTitle('/constructor')).toBe('atpota.to');
    expect(pageTitle('/__proto__')).toBe('atpota.to');
    expect(canonicalPath('///')).toBe('/');
  });
});

describe('cookie', () => {
  it('mints 43-character base64url ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newConversationId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(CONVERSATION_ID_RE);
  });

  it('reads the first valid poe_conversation value', () => {
    const id = 'A'.repeat(43);
    const req = (cookie: string) => new Request('https://atpota.to/api/poe', { headers: { cookie } });
    expect(readConversationId(req(`a=1; poe_conversation=${id}; b=2`))).toBe(id);
    expect(readConversationId(req(`poe_conversation="${id}"`))).toBe(id);
    expect(readConversationId(req(`poe_conversation=bad; poe_conversation=${id}`))).toBe(id);
    expect(readConversationId(req('xpoe_conversation=' + id))).toBeNull();
    expect(readConversationId(req(`poe_conversation=${id}x`))).toBeNull();
    expect(readConversationId(req(`poe_conversation=${'A'.repeat(42)}+`))).toBeNull();
    expect(readConversationId(new Request('https://atpota.to/api/poe'))).toBeNull();
  });

  it('builds the cookie strings', () => {
    const id = 'b'.repeat(43);
    expect(conversationCookie(id, 'https://atpota.to/api/poe')).toBe(
      `poe_conversation=${id}; Path=/api/poe; HttpOnly; Secure; SameSite=Lax; Max-Age=7200`,
    );
    expect(conversationCookie(id, 'http://localhost:5173/api/poe')).toBe(
      `poe_conversation=${id}; Path=/api/poe; HttpOnly; SameSite=Lax; Max-Age=7200`,
    );
    expect(clearedCookie('https://atpota.to/api/poe')).toBe(
      'poe_conversation=; Path=/api/poe; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
    expect(isInsecureLocalhost('http://127.0.0.1:4173/api/poe')).toBe(true);
    expect(isInsecureLocalhost('http://[::1]:4173/api/poe')).toBe(true);
    expect(isInsecureLocalhost('https://localhost/api/poe')).toBe(false);
    expect(isInsecureLocalhost('http://localhost.evil.example/api/poe')).toBe(false);
  });
});

describe('origin', () => {
  const url = 'https://atpota.to/api/poe';
  it.each([
    [null, true],
    ['https://atpota.to', true],
    ['https://www.atpota.to', true],
    ['https://atpotato.com', true],
    ['https://www.atpotato.com', true],
    ['https://atpota-to.vercel.app', true],
    ['https://atpota-to-git-redesign-vite-poe-atpotato.vercel.app', true],
    ['https://atpota-to-abc123-atpotato.vercel.app', true],
    ['http://localhost:5173', true],
    ['http://127.0.0.1:4173', true],
    ['https://evil.example', false],
    ['https://evil.vercel.app', false],
    ['https://atpota-to.vercel.app.evil.example', false],
    ['https://notatpota-to.vercel.app', false],
    ['http://atpota.to', false],
    ['https://atpota.to:444', false],
    ['https://atpota.to.evil.example', false],
    ['null', false],
    ['', false],
    ['file://', false],
  ])('%s -> %s', (origin, allowed) => {
    expect(isAllowedOrigin(origin, url)).toBe(allowed);
  });

  it('allows the request URL origin itself', () => {
    expect(isAllowedOrigin('https://some-alias.example', 'https://some-alias.example/api/poe')).toBe(true);
    expect(isAllowedOrigin('https://some-alias.example', 'https://other.example/api/poe')).toBe(false);
  });
});

describe('rate limiter', () => {
  it('slides each window and reports the wait until a slot frees', () => {
    const l = new SlidingWindowLimiter([{ limit: 2, windowMs: 1000 }]);
    expect(l.wait('k', 0)).toBe(0);
    l.record('k', 0);
    l.record('k', 400);
    expect(l.wait('k', 500)).toBe(500);
    expect(l.wait('k', 999)).toBe(1);
    // A hit exactly one window old has aged out.
    expect(l.wait('k', 1000)).toBe(0);
    l.record('k', 1000);
    expect(l.wait('k', 1100)).toBe(300); // hits at 400 and 1000: 400 frees at 1400
  });

  it('applies the strictest of several windows', () => {
    const l = new SlidingWindowLimiter([
      { limit: 2, windowMs: 1000 },
      { limit: 3, windowMs: 10_000 },
    ]);
    l.record('k', 0);
    l.record('k', 100);
    l.record('k', 2000);
    expect(l.wait('k', 2100)).toBe(7900); // 3 in 10 s: first ages out at 10,000
  });

  it('does not record refused messages', () => {
    const lim = createLocalLimiter([{ limit: 1, windowMs: 1000 }], [{ limit: 10, windowMs: 1000 }]);
    expect(lim.take('ip', 'c', 0).limited).toBe(false);
    for (let t = 100; t < 1000; t += 100) expect(lim.take('ip', 'c', t)).toMatchObject({ limited: true, scope: 'ip' });
    expect(lim.take('ip', 'c', 1000).limited).toBe(false);
  });

  it('rounds retry-after up to whole seconds (at least 1)', () => {
    const lim = createLocalLimiter([{ limit: 1, windowMs: 1500 }], [{ limit: 10, windowMs: 1000 }]);
    lim.take('ip', 'c', 0);
    expect(lim.take('ip', 'c', 1).retryAfter).toBe(2);
    expect(lim.take('ip', 'c', 1499).retryAfter).toBe(1);
  });

  it('keeps memory bounded', () => {
    const l = new SlidingWindowLimiter([{ limit: 1, windowMs: 60_000 }], 100);
    for (let i = 0; i < 1000; i++) l.record(`ip${i}`, i);
    expect(l.size).toBe(100);
    expect(l.wait('ip999', 1000)).toBeGreaterThan(0);
    expect(l.wait('ip0', 1000)).toBe(0);
  });

  it('drops keys whose hits all aged out', () => {
    const l = new SlidingWindowLimiter([{ limit: 5, windowMs: 1000 }]);
    l.record('k', 0);
    expect(l.size).toBe(1);
    l.wait('k', 5000);
    expect(l.size).toBe(0);
  });

  it('extracts the client IP', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '', 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('sse', () => {
  it('encodes one-line events', () => {
    expect(encodeEvent('delta', { text: 'a\nb\r\nc', block: 0 })).toBe('event: delta\ndata: {"text":"a\\nb\\r\\nc","block":0}\n\n');
  });

  it('parses LF, CRLF and CR, comments, multi-line data and default event names', () => {
    const p = new SseParser();
    const out = [
      ...p.push(': ping\n\nevent: a\ndata: 1\n\n'),
      ...p.push('event: b\r\ndata: x\r\ndata: y\r\n\r\n'),
      ...p.push('data:no-space\r\r'),
      ...p.push('event: c\ndata: 2\nid: 7\nretry: 10\nfoo: bar\n\n'),
      ...p.push('event: only-event\n\n'),
    ];
    expect(out).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: 'x\ny' },
      { event: 'message', data: 'no-space' },
      { event: 'c', data: '2' },
    ]);
    expect(p.comments).toBe(1);
  });

  it('handles a CRLF split across chunks', () => {
    const p = new SseParser();
    expect(p.push('event: a\r')).toEqual([]);
    expect(p.push('\ndata: 1\r')).toEqual([]);
    expect(p.push('\n\r')).toEqual([{ event: 'a', data: '1' }]);
    expect(p.push('\nevent: b\ndata: 2\n\n')).toEqual([{ event: 'b', data: '2' }]);
  });

  it('discards an unterminated trailing event and refuses huge ones', () => {
    const p = new SseParser();
    expect(p.push('event: a\ndata: 1')).toEqual([]);
    expect(p.end()).toEqual([]);
    const small = new SseParser(100);
    expect(() => small.push('data: ' + 'x'.repeat(200))).toThrow(SseOverflowError);
    const lines = new SseParser(100);
    expect(() => {
      for (let i = 0; i < 20; i++) lines.push('data: xxxxxxxxxx\n');
    }).toThrow(SseOverflowError);
  });
});

describe('tool labels', () => {
  const SPEC_TOOLS = [
    'resolve_identity',
    'resolve_link',
    'get_record',
    'get_profile',
    'get_posts',
    'get_thread',
    'search_atproto_docs',
    'read_atproto_doc',
    'get_feed',
    'list_records',
    'describe_repo',
    'get_backlinks',
    'get_lexicon_schema',
  ];

  it('labels every tool the spec names, with and without the connection prefix', () => {
    for (const name of SPEC_TOOLS) {
      expect(TOOL_LABELS[name], name).toBeTruthy();
      expect(toolLabel(`atmosphere__${name}`)).toBe(TOOL_LABELS[name]);
      expect(toolLabel(name)).toBe(TOOL_LABELS[name]);
    }
    expect(toolLabel('atmosphere__resolve_identity')).toBe('resolving a handle');
    expect(toolLabel('atmosphere__read_atproto_doc')).toBe('reading the atproto docs');
    expect(toolLabel('atmosphere__get_record')).toBe('looking up a record');
    expect(toolLabel('atmosphere__get_feed')).toBe('checking a feed');
  });

  it('labels the authored and built-in tools too', () => {
    expect(toolLabel('scan_collection')).toBe('counting records');
    expect(toolLabel('search_bluesky_posts')).toBe('searching posts');
    expect(toolLabel('top_mentioned_posts')).toBe('finding the most mentioned posts');
    expect(toolLabel('web_search')).toBe('searching the web');
  });

  it('falls back for unknown, internal or hostile names', () => {
    for (const name of ['bash', 'write_file', 'connection_search', 'agent', '', 'constructor', '__proto__', 'toString', 42, null, 'x'.repeat(300)]) {
      expect(toolLabel(name)).toBe(FALLBACK_LABEL);
    }
    expect(FALLBACK_LABEL).toBe('looking that up');
  });

  it('strips connection prefixes in several spellings', () => {
    expect(baseToolName('atmosphere__get_record')).toBe('get_record');
    expect(baseToolName('mcp__atmosphere__get_record')).toBe('get_record');
    expect(baseToolName('atmosphere.get_record')).toBe('get_record');
    expect(baseToolName('atmosphere/get_record')).toBe('get_record');
    expect(baseToolName('ATMOSPHERE__GET_RECORD')).toBe('get_record');
  });

  it('labels are short, lowercase, and free of em dashes and ellipses', () => {
    for (const label of [...Object.values(TOOL_LABELS), FALLBACK_LABEL]) {
      expect(label).toBe(label.toLowerCase());
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).not.toMatch(/[—…]|\.\.\./);
    }
  });
});

describe('upstream helpers', () => {
  it('clips without splitting surrogate pairs', () => {
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip('ab🥔', 3)).toBe('ab');
    expect(clip('ab🥔', 4)).toBe('ab🥔');
  });

  it('filters links', () => {
    expect(
      cleanLinks([
        'https://aturi.to',
        'https://aturi.to',
        'https://bsky.app/profile/atpota.to/post/3k',
        'http://x.example',
        'HTTPS://upper.example',
        'https://a:b@x.example',
        'https://user@x.example',
        'https://:pw@x.example',
        'https://x.example/\u0000',
        'https://x.example/​ok',
        ' https://x.example',
        'javascript:alert(1)',
        'data:text/html,hi',
        {},
      ]),
    ).toEqual(['https://aturi.to', 'https://bsky.app/profile/atpota.to/post/3k', 'https://x.example/​ok']);
    expect(cleanLinks('https://aturi.to')).toEqual([]);
    expect(cleanLinks(undefined)).toEqual([]);
  });

  it('maps error codes and keeps only safe messages', () => {
    for (const code of ERROR_CODES) expect(toErrorCode(code)).toBe(code);
    expect(toErrorCode('stream_failed')).toBe('upstream');
    expect(toErrorCode(undefined)).toBe('upstream');
    expect(safeErrorMessage('timeout', 'poe is still digging. ask again in a minute.')).toBe('poe is still digging. ask again in a minute.');
    expect(safeErrorMessage('timeout', 'Error: ETIMEDOUT')).toBe(MESSAGES.timeout);
    expect(safeErrorMessage('conversation_over', '')).toBe(MESSAGES.conversation_over);
    expect(safeErrorMessage('upstream', 'go to evil.example/x')).toBe(MESSAGES.upstream);
  });

  it('builds the strict upstream body', () => {
    expect(JSON.parse(upstreamBody({ conversationId: 'c'.repeat(43), message: 'm', path: '/', title: 't' }))).toEqual({
      conversationId: 'c'.repeat(43),
      message: 'm',
      page: { path: '/', title: 't' },
    });
    expect(JSON.parse(upstreamBody({ conversationId: 'c'.repeat(43), message: 'm', path: '/', title: 't', selection: 's' })).selection).toBe('s');
  });
});

describe('messages', () => {
  it('are lowercase and free of em dashes', () => {
    for (const message of Object.values(MESSAGES)) {
      expect(message).toBe(message.toLowerCase());
      expect(message).not.toContain('—');
    }
  });
});

describe('mock helpers', () => {
  it('answers deterministically', () => {
    expect(mockAnswer({ message: 'hi' })).toEqual(mockAnswer({ message: 'hi' }));
    expect(mockAnswer({ message: 'hi' }).links).toEqual([]);
    expect(mockAnswer({ message: 'at://x' }).links).toEqual(['https://aturi.to']);
    expect(mockWantsLink('Any LINKS?')).toBe(true);
    expect(mockWantsLink('hello')).toBe(false);
    expect(mockPreStream('hello')).toBeNull();
    expect(mockPreStream('#rate')?.status).toBe(429);
  });
});

describe('log helpers', () => {
  it('logs error class names only', () => {
    expect(errorName(new TypeError('secret message'))).toBe('TypeError');
    expect(errorName(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('TypeError:ECONNREFUSED');
    expect(errorName({ name: 'has spaces and secrets' })).toBe('unknown');
    expect(errorName('string')).toBe('unknown');
  });
});
