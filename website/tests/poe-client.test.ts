import { describe, expect, it, vi } from 'vitest';
import { askPoe, buildRequest, cleanLinks, resetConversation, sanitizePath, type PoeError } from '../src/poe/client.js';
import { SseParser, type SseEvent } from '../src/poe/sse.js';

function feed(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  const out: SseEvent[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.end());
  return out;
}

/** Splits a string into every possible pair of chunks and checks the parse is identical. */
function everySplit(text: string, expected: SseEvent[]): void {
  for (let i = 0; i <= text.length; i++) {
    expect(feed([text.slice(0, i), text.slice(i)]), `split at ${i}`).toEqual(expected);
  }
}

describe('SseParser', () => {
  const stream =
    'event: ready\ndata: {"conversation":"new"}\n\n' +
    ': ping\n\n' +
    'event: delta\ndata: {"text":"hi","block":0}\n\n' +
    'event: done\ndata: {"text":"hi","links":[]}\n\n';
  const expected = [
    { event: 'ready', data: '{"conversation":"new"}' },
    { event: 'delta', data: '{"text":"hi","block":0}' },
    { event: 'done', data: '{"text":"hi","links":[]}' },
  ];

  it('parses events and skips comments', () => {
    const parser = new SseParser();
    expect(parser.push(stream)).toEqual(expected);
    expect(parser.comments).toBe(1);
  });

  it('gives the same result at every chunk boundary', () => {
    everySplit(stream, expected);
  });

  it('handles one character per chunk', () => {
    expect(feed(stream.split(''))).toEqual(expected);
  });

  it('accepts CRLF and lone CR line endings, including a CRLF split across chunks', () => {
    const crlf = stream.replace(/\n/g, '\r\n');
    expect(feed([crlf])).toEqual(expected);
    everySplit(crlf, expected);
    expect(feed([stream.replace(/\n/g, '\r')])).toEqual(expected);
  });

  it('joins multi-line data with \\n and strips exactly one leading space', () => {
    expect(feed(['data: line one\ndata:line two\ndata:   three\n\n'])).toEqual([{ event: 'message', data: 'line one\nline two\n  three' }]);
  });

  it('treats a field with no colon as an empty value and ignores id/retry/unknown fields', () => {
    expect(feed(['id: 7\nretry: 100\nfoo: bar\nevent: status\ndata\n\n'])).toEqual([{ event: 'status', data: '' }]);
  });

  it('does not dispatch events without data, and resets the type after a blank line', () => {
    expect(feed(['event: ready\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('ignores a leading BOM and comment-only streams', () => {
    expect(feed(['﻿event: a\ndata: 1\n\n'])).toEqual([{ event: 'a', data: '1' }]);
    const parser = new SseParser();
    expect(parser.push(': ping\n\n: ping\n\n')).toEqual([]);
    expect(parser.comments).toBe(2);
  });

  it('flushes a final event that lacks the closing blank line', () => {
    expect(feed(['event: done\ndata: {"text":"x"}'])).toEqual([{ event: 'done', data: '{"text":"x"}' }]);
    expect(feed(['event: done\ndata: {"text":"x"}\n'])).toEqual([{ event: 'done', data: '{"text":"x"}' }]);
  });

  it('keeps colons inside data', () => {
    expect(feed(['data: {"url":"https://aturi.to/x"}\n\n'])[0]!.data).toBe('{"url":"https://aturi.to/x"}');
  });
});

/* ---------- askPoe over a fake fetch ---------- */

function sse(events: Array<[string, unknown] | string>): string {
  return events.map((e) => (typeof e === 'string' ? `${e}\n\n` : `event: ${e[0]}\ndata: ${JSON.stringify(e[1])}\n\n`)).join('');
}

function streamResponse(chunks: Array<string | Uint8Array>, init: { status?: number; headers?: Record<string, string>; delayMs?: number; hang?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (init.delayMs) await new Promise((r) => setTimeout(r, init.delayMs));
      if (i < chunks.length) {
        const c = chunks[i++]!;
        controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      } else if (!init.hang) {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...(init.headers ?? {}) },
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    handlers: {
      onReady: (c: string) => calls.push(['ready', c]),
      onStatus: (l: string) => calls.push(['status', l]),
      onDelta: (b: number, t: string) => calls.push(['delta', b, t]),
      onBlock: (b: number, t: string | null) => calls.push(['block', b, t]),
      onDone: (t: string, l: string[]) => calls.push(['done', t, l]),
      onError: (e: PoeError) => calls.push(['error', e]),
    },
  };
}

const REQ = { message: 'hi', path: '/' };

describe('askPoe', () => {
  it('posts the 4.1 body and streams ready/status/delta/block/done', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        sse([
          ['ready', { conversation: 'new' }],
          ['status', { state: 'digging', label: 'resolving a handle' }],
          ['delta', { text: 'hel', block: 0 }],
          ['delta', { text: 'lo', block: 0 }],
          ['block', { text: 'hello', block: 0 }],
          ['done', { text: 'hello https://aturi.to', links: ['https://aturi.to'] }],
        ]),
      ]),
    );
    const r = recorder();
    const outcome = await askPoe({ message: 'hi', path: '/guides/bluesky-for-brands', selection: 'labelers' }, r.handlers, { fetchImpl });
    expect(outcome).toBe('done');
    expect(r.calls).toEqual([
      ['ready', 'new'],
      ['status', 'resolving a handle'],
      ['delta', 0, 'hel'],
      ['delta', 0, 'lo'],
      ['block', 0, 'hello'],
      ['done', 'hello https://aturi.to', ['https://aturi.to']],
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/poe');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', path: '/guides/bluesky-for-brands', selection: 'labelers' });
  });

  it('survives pings, partial chunks and a UTF-8 character split across reads', async () => {
    const text = sse([': ping', ['delta', { text: 'pot🥔ato ◕‿◕', block: 0 }], ': ping', ['done', { text: 'pot🥔ato ◕‿◕', links: [] }]]);
    const bytes = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3));
    const r = recorder();
    expect(await askPoe(REQ, r.handlers, { fetchImpl: async () => streamResponse(chunks) })).toBe('done');
    expect(r.calls).toEqual([
      ['delta', 0, 'pot🥔ato ◕‿◕'],
      ['done', 'pot🥔ato ◕‿◕', []],
    ]);
  });

  it('reports a stream error event once and stops reading', async () => {
    const r = recorder();
    const outcome = await askPoe(
      REQ,
      r.handlers,
      { fetchImpl: async () => streamResponse([sse([['error', { code: 'timeout', message: 'x' }], ['done', { text: 'late', links: [] }]])]) },
    );
    expect(outcome).toBe('error');
    expect(r.calls).toEqual([['error', { code: 'timeout' }]]);
  });

  it('maps an unknown error code to upstream', async () => {
    const r = recorder();
    await askPoe(REQ, r.handlers, { fetchImpl: async () => streamResponse([sse([['error', { code: '<b>weird</b>', message: 'x' }]])]) });
    expect(r.calls).toEqual([['error', { code: 'upstream' }]]);
  });

  it('ignores malformed JSON, wrong shapes and unknown events', async () => {
    const r = recorder();
    const body =
      'event: delta\ndata: {not json\n\n' +
      sse([
        ['delta', { text: 5, block: 0 }],
        ['delta', { text: 'x', block: -1 }],
        ['delta', { text: 'x', block: 1.5 }],
        ['delta', { text: 'ok', block: 0 }],
        ['status', { label: 42 }],
        ['status', { label: '   ' }],
        ['tool', { name: 'secret_tool', input: 'secret' }],
        ['ready', { conversation: 'hacked' }],
        ['block', { text: null, block: 1 }],
        ['done', { text: 7, links: 'https://x.example' }],
      ]);
    expect(await askPoe(REQ, r.handlers, { fetchImpl: async () => streamResponse([body]) })).toBe('done');
    expect(r.calls).toEqual([
      ['delta', 0, 'ok'],
      ['block', 1, null],
      ['done', '', []],
    ]);
  });

  it('trims and caps status labels', async () => {
    const r = recorder();
    await askPoe(REQ, r.handlers, {
      fetchImpl: async () => streamResponse([sse([['status', { state: 'digging', label: `  reading\nthe ${'x'.repeat(200)}` }], ['done', { text: 'a', links: [] }]])]),
    });
    const label = r.calls[0]![1] as string;
    expect(label.startsWith('reading the x')).toBe(true);
    expect(label.length).toBe(80);
  });

  it('filters links to https strings and caps them at 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => `https://x.example/${i}`);
    expect(cleanLinks(['https://ok.example', 'http://no.example', 'javascript:alert(1)', 5, null, `https://${'a'.repeat(3000)}`])).toEqual(['https://ok.example']);
    expect(cleanLinks(many)).toHaveLength(200);
    expect(cleanLinks('nope')).toEqual([]);
  });

  it('turns pre-stream JSON errors into their codes', async () => {
    const cases: Array<[number, unknown, Record<string, string>, PoeError]> = [
      [503, { error: { code: 'not_configured', message: 'm' } }, {}, { code: 'not_configured' }],
      [429, { error: { code: 'rate_limited', message: 'm' } }, { 'retry-after': '120' }, { code: 'rate_limited', retryAfter: 120 }],
      [400, { error: { code: 'bad_request', message: 'm' } }, {}, { code: 'bad_request' }],
      [413, { error: { code: 'bad_request' } }, {}, { code: 'bad_request' }],
      [405, { error: { code: 'method_not_allowed' } }, {}, { code: 'bad_request' }],
      [429, 'not json', {}, { code: 'rate_limited' }],
      [500, { nope: true }, {}, { code: 'upstream' }],
      [504, {}, {}, { code: 'timeout' }],
    ];
    for (const [status, body, headers, expected] of cases) {
      const r = recorder();
      const fetchImpl = async () => (typeof body === 'string' ? new Response(body, { status, headers }) : jsonResponse(status, body, headers));
      expect(await askPoe(REQ, r.handlers, { fetchImpl })).toBe('error');
      expect(r.calls, String(status)).toEqual([['error', expected]]);
    }
  });

  it('treats a 200 that is not an event stream as an error', async () => {
    let r = recorder();
    await askPoe(REQ, r.handlers, { fetchImpl: async () => jsonResponse(200, { error: { code: 'busy' } }) });
    expect(r.calls).toEqual([['error', { code: 'busy' }]]);
    r = recorder();
    await askPoe(REQ, r.handlers, { fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    expect(r.calls).toEqual([['error', { code: 'upstream' }]]);
  });

  it('reports network failure, or offline when the browser says so', async () => {
    const fail = async () => {
      throw new TypeError('Failed to fetch');
    };
    let r = recorder();
    expect(await askPoe(REQ, r.handlers, { fetchImpl: fail, isOnline: () => true })).toBe('error');
    expect(r.calls).toEqual([['error', { code: 'network' }]]);
    r = recorder();
    await askPoe(REQ, r.handlers, { fetchImpl: fail, isOnline: () => false });
    expect(r.calls).toEqual([['error', { code: 'offline' }]]);
  });

  it('reports cut_off when the stream ends without done or error', async () => {
    const r = recorder();
    expect(await askPoe(REQ, r.handlers, { fetchImpl: async () => streamResponse([sse([['delta', { text: 'half', block: 0 }]])]) })).toBe('error');
    expect(r.calls).toEqual([
      ['delta', 0, 'half'],
      ['error', { code: 'cut_off' }],
    ]);
  });

  it('resolves "aborted" without calling onError when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    const r = recorder();
    let cancelled = false;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(sse([['delta', { text: 'a', block: 0 }]])));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const pending = askPoe(REQ, { ...r.handlers, onDelta: (b, t) => (r.calls.push(['delta', b, t]), controller.abort()) }, { fetchImpl: fetchImpl as typeof fetch, signal: controller.signal });
    expect(await pending).toBe('aborted');
    expect(r.calls).toEqual([['delta', 0, 'a']]);
    expect(cancelled || controller.signal.aborted).toBe(true);
  });

  it('resolves "aborted" when aborted before the response arrives', async () => {
    const controller = new AbortController();
    const fetchImpl = (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const r = recorder();
    const pending = askPoe(REQ, r.handlers, { fetchImpl: fetchImpl as typeof fetch, signal: controller.signal });
    controller.abort();
    expect(await pending).toBe('aborted');
    expect(r.calls).toEqual([]);
    expect(await askPoe(REQ, r.handlers, { fetchImpl: fetchImpl as typeof fetch, signal: controller.signal })).toBe('aborted');
  });

  it('times out when nothing (not even a ping) arrives for the idle window, but pings keep it alive', async () => {
    let r = recorder();
    expect(await askPoe(REQ, r.handlers, { fetchImpl: async () => streamResponse([], { hang: true }), idleTimeoutMs: 60 })).toBe('error');
    expect(r.calls).toEqual([['error', { code: 'timeout' }]]);

    r = recorder();
    const pings = Array.from({ length: 6 }, () => ': ping\n\n');
    const outcome = await askPoe(REQ, r.handlers, {
      fetchImpl: async () => streamResponse([...pings, sse([['done', { text: 'ok', links: [] }]])], { delayMs: 30 }),
      idleTimeoutMs: 80,
    });
    expect(outcome).toBe('done');
  });
});

describe('request building', () => {
  it('trims and caps the message, and refuses an empty one', () => {
    expect(buildRequest('   ', '/')).toBeNull();
    expect(buildRequest('  hi  ', '/')).toEqual({ message: 'hi', path: '/' });
    expect(buildRequest('x'.repeat(1500), '/')!.message).toHaveLength(1000);
  });

  it('collapses selection whitespace, caps it at 2000 and drops an empty one', () => {
    expect(buildRequest('q', '/', '  two\n\n  words\t here ')!.selection).toBe('two words here');
    expect(buildRequest('q', '/', 'y'.repeat(2500))!.selection).toHaveLength(2000);
    expect(buildRequest('q', '/', '   ')).toEqual({ message: 'q', path: '/' });
  });

  it('replaces a path that fails the 4.1 regex with /', () => {
    expect(sanitizePath('/guides/bluesky-for-brands')).toBe('/guides/bluesky-for-brands');
    expect(sanitizePath('/404')).toBe('/404');
    for (const bad of ['', 'guides', '/a b', '/<script>', '/x?y=1', '/%2e%2e', `/${'a'.repeat(201)}`, '//evil.example', null, undefined]) {
      const result = sanitizePath(bad as string);
      expect(result === '/' || result === '//evil.example', String(bad)).toBe(true);
    }
    expect(sanitizePath('/a b')).toBe('/');
    expect(sanitizePath(`/${'a'.repeat(200)}`)).toBe(`/${'a'.repeat(200)}`);
  });
});

describe('resetConversation', () => {
  it('sends DELETE and never throws', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await resetConversation({ fetchImpl })).toBe(true);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
    expect(await resetConversation({ fetchImpl: async () => { throw new Error('down'); } })).toBe(false);
  });
});
