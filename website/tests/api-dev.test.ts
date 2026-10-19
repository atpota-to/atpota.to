import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';
import { apiMiddleware } from '../build/api-middleware.js';

// The real api/poe.ts served by the dev/preview middleware, in mock mode (SPEC 4.4):
// proves the SSE reaches an HTTP client incrementally, not buffered.

const root = fileURLToPath(new URL('..', import.meta.url));

interface Timed {
  text: string;
  /** ms since the request started, per chunk */
  times: number[];
  /** ms at which each "event: x" first appeared */
  at: Record<string, number>;
}

async function readTimed(res: Response, started: number): Promise<Timed> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const times: number[] = [];
  const at: Record<string, number> = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const t = Date.now() - started;
    times.push(t);
    for (const m of text.matchAll(/^event: (\w+)$/gm)) at[m[1]!] ??= t;
  }
  return { text, times, at };
}

/** Loads and compiles api/poe.ts once, so timings below measure streaming only. */
async function warmUp(base: string): Promise<void> {
  const res = await fetch(`${base}/api/poe`, { method: 'DELETE' });
  expect(res.status).toBe(204);
}

function ask(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/poe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function sharedChecks(getBase: () => string) {
  it('streams the mock answer incrementally with the cookie set', async () => {
    const started = Date.now();
    const res = await ask(getBase(), { message: 'what is an at:// link?', path: '/' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^poe_conversation=[A-Za-z0-9_-]{43}; Path=\/api\/poe; HttpOnly; SameSite=Lax; Max-Age=7200$/);
    const { text, times, at } = await readTimed(res, started);
    expect(text.startsWith('event: ready\ndata: {"conversation":"new"}\n\n')).toBe(true);
    expect(text).toContain('event: status\ndata: {"state":"digging","label":"looking that up"}');
    expect(text).toContain('"links":["https://aturi.to"]');
    // Many chunks over time: ready lands at once, done ~2 s later. (The module was
    // compiled in beforeAll; the absolute bound is loose for busy CI machines.)
    expect(times.length).toBeGreaterThan(20);
    expect(at.ready!).toBeLessThan(1500);
    expect(at.done! - at.ready!).toBeGreaterThan(1000);
    expect(at.delta!).toBeLessThan(at.done! - 500);

    // Second message with the cookie continues the conversation.
    const id = /^poe_conversation=([^;]+);/.exec(cookie)![1]!;
    const again = await ask(getBase(), { message: 'thanks' }, { cookie: `poe_conversation=${id}` });
    const second = await readTimed(again, Date.now());
    expect(second.text.startsWith('event: ready\ndata: {"conversation":"continued"}')).toBe(true);
  });

  it('serves the pre-stream errors as JSON', async () => {
    const rate = await ask(getBase(), { message: 'hi #rate' });
    expect(rate.status).toBe(429);
    expect(rate.headers.get('retry-after')).toBe('60');
    expect(((await rate.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    const bad = await fetch(`${getBase()}/api/poe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    await bad.body?.cancel();

    const foreign = await ask(getBase(), { message: 'hi' }, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    await foreign.body?.cancel();

    const lookalike = await ask(getBase(), { message: 'hi' }, { origin: 'https://atpota-to-evil.vercel.app' });
    expect(lookalike.status).toBe(403);
    await lookalike.body?.cancel();

    const plain = await fetch(`${getBase()}/api/poe`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    expect(plain.status).toBe(415);
    await plain.body?.cancel();

    const get = await fetch(`${getBase()}/api/poe`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, DELETE');
    expect(((await get.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('DELETE clears the cookie', async () => {
    const res = await fetch(`${getBase()}/api/poe`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^poe_conversation=; Path=\/api\/poe; HttpOnly; SameSite=Lax; Max-Age=0/);
  });

  it('survives a client that disconnects mid-answer', async () => {
    const controller = new AbortController();
    const res = await fetch(`${getBase()}/api/poe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    // The server keeps answering other requests.
    const next = await fetch(`${getBase()}/api/poe`, { method: 'DELETE' });
    expect(next.status).toBe(204);
  });
}

let dist = '';

beforeAll(() => {
  vi.stubEnv('POE_MOCK', '1');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('POE_CHAT_DISABLED', '');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  dist = mkdtempSync(join(tmpdir(), 'atpotato-api-dev-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dist) rmSync(dist, { recursive: true, force: true });
});

describe('api/poe.ts under vite dev (POE_MOCK=1)', () => {
  let server: ViteDevServer;
  let base = '';
  beforeAll(async () => {
    server = await createServer({
      root,
      configFile: false,
      envDir: false,
      logLevel: 'silent',
      plugins: [apiMiddleware()],
      server: { port: 0, host: '127.0.0.1', cors: false, hmr: false, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await warmUp(base);
  });
  afterAll(async () => {
    await server?.close();
  });
  sharedChecks(() => base);

  it('"#slow" pings for about 3 s before answering', async () => {
    const started = Date.now();
    const res = await ask(base, { message: 'slowly please #slow' });
    const { text, at } = await readTimed(res, started);
    const beforeStatus = text.slice(0, text.indexOf('event: status'));
    expect(beforeStatus.match(/^: ping$/gm)).toHaveLength(6);
    expect(at.status!).toBeGreaterThanOrEqual(2900);
    expect(text).toContain('event: done');
  }, 15_000);
});

describe('api/poe.ts under vite preview (POE_MOCK=1)', () => {
  let server: PreviewServer;
  let base = '';
  beforeAll(async () => {
    server = await preview({
      root,
      configFile: false,
      envDir: false,
      logLevel: 'silent',
      plugins: [apiMiddleware()],
      build: { outDir: dist },
      preview: { port: 0, host: '127.0.0.1', cors: false },
    });
    const { port } = server.httpServer.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    await warmUp(base);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  });
  sharedChecks(() => base);
});
