import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';
import { apiMiddleware } from '../build/api-middleware.js';

// A throwaway Vite root with api/*.ts handlers that exercise the middleware.
const STREAM_HANDLER = `
export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < 4; i++) {
        controller.enqueue(encoder.encode('event: delta\\ndata: ' + JSON.stringify({ i, echo: body.message }) + '\\n\\n'));
        await new Promise((r) => setTimeout(r, 150));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'set-cookie': 'a=1; Path=/api; HttpOnly',
      'x-seen-url': request.url,
      'x-seen-ip': request.headers.get('x-forwarded-for') ?? '',
    },
  });
}

export async function DELETE(): Promise<Response> {
  const headers = new Headers();
  headers.append('set-cookie', 'a=; Max-Age=0; Path=/api');
  headers.append('set-cookie', 'b=; Max-Age=0; Path=/api');
  return new Response(null, { status: 204, headers });
}
`;

const ABORT_HANDLER = `
export const seen: { aborted: boolean } = (globalThis as any).__abortSeen ??= { aborted: false };
export async function POST(request: Request): Promise<Response> {
  request.signal.addEventListener('abort', () => { seen.aborted = true; });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(': ping\\n\\n')), 50);
    },
    cancel() {
      clearInterval(timer);
      seen.aborted = true;
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
`;

const ENV_HANDLER = `
export async function GET(): Promise<Response> {
  return Response.json({ value: process.env.ATPOTATO_TEST_ENV ?? null, vite: process.env.VITE_ATPOTATO_TEST ?? null });
}
`;

const THROW_HANDLER = `
export async function POST(): Promise<Response> {
  throw new Error('boom');
}
`;

let root = '';

function setupRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atpotato-api-'));
  mkdirSync(join(dir, 'api'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(dir, 'api', 'stream.ts'), STREAM_HANDLER);
  writeFileSync(join(dir, 'api', 'abort.ts'), ABORT_HANDLER);
  writeFileSync(join(dir, 'api', 'boom.ts'), THROW_HANDLER);
  writeFileSync(join(dir, 'api', 'env.ts'), ENV_HANDLER);
  writeFileSync(join(dir, '.env.local'), 'ATPOTATO_TEST_ENV=from-dotenv\nVITE_ATPOTATO_TEST=client-only\n');
  return dir;
}

async function readTimed(res: Response): Promise<{ chunks: string[]; times: number[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const times: number[] = [];
  const start = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
    times.push(Date.now() - start);
  }
  return { chunks, times };
}

function sharedChecks(getBase: () => string) {
  it('streams chunks as they are produced, not all at the end', async () => {
    const res = await fetch(`${getBase()}/api/stream?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('set-cookie')).toBe('a=1; Path=/api; HttpOnly');
    expect(res.headers.get('x-seen-url')).toBe(`${getBase()}/api/stream?x=1`);
    expect(res.headers.get('x-seen-ip')).toMatch(/127\.0\.0\.1|::1/);
    const { chunks, times } = await readTimed(res);
    const text = chunks.join('');
    expect(text.match(/event: delta/g)).toHaveLength(4);
    expect(text).toContain('"echo":"hello"');
    // First bytes arrive well before the stream finishes (~600ms total).
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(times[0]!).toBeLessThan(300);
    expect(times[times.length - 1]! - times[0]!).toBeGreaterThan(300);
  });

  it('passes multiple set-cookie headers and empty bodies through', async () => {
    const res = await fetch(`${getBase()}/api/stream`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual(['a=; Max-Age=0; Path=/api', 'b=; Max-Age=0; Path=/api']);
  });

  it('answers 405 with Allow for methods the module does not export', async () => {
    const res = await fetch(`${getBase()}/api/stream`, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('copies non-VITE_ variables from .env files into process.env', async () => {
    const res = await fetch(`${getBase()}/api/env`);
    expect(await res.json()).toEqual({ value: 'from-dotenv', vite: null });
  });

  it('turns a thrown error into a 500 JSON error', async () => {
    const res = await fetch(`${getBase()}/api/boom`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream');
  });

  it('leaves unknown /api paths to the rest of the stack', async () => {
    const res = await fetch(`${getBase()}/api/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('cancels the handler stream when the client goes away', async () => {
    const g = globalThis as { __abortSeen?: { aborted: boolean } };
    g.__abortSeen = { aborted: false };
    const controller = new AbortController();
    const res = await fetch(`${getBase()}/api/abort`, { method: 'POST', signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    expect(g.__abortSeen.aborted).toBe(true);
  });
}

beforeAll(() => {
  root = setupRoot();
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('api middleware under vite dev', () => {
  let server: ViteDevServer;
  let base = '';
  beforeAll(async () => {
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [apiMiddleware()],
      server: { port: 0, host: '127.0.0.1', cors: false, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await server?.close();
  });
  sharedChecks(() => base);
});

describe('api middleware under vite preview', () => {
  let server: PreviewServer;
  let base = '';
  beforeAll(async () => {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>t</title>');
    server = await preview({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [apiMiddleware()],
      preview: { port: 0, host: '127.0.0.1', cors: false },
    });
    const { port } = server.httpServer.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  });
  sharedChecks(() => base);
});
