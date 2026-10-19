import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, loadEnv, type Logger, type Plugin, type ViteDevServer } from 'vite';

/**
 * Runs Vercel-style Web handlers from api/*.ts under `vite dev` and `vite preview`.
 *
 *   /api/<name>  ->  api/<name>.ts, calling its exported POST / DELETE / GET / ... function
 *                    with a Web `Request` and streaming the returned Web `Response` back.
 *
 * - dev: modules load through the dev server's ssrLoadModule (edits apply on the next request).
 * - preview: a private middleware-mode Vite server (no HMR, no watcher) loads them the same way.
 * - Non-VITE_ variables from .env, .env.local, .env.[mode], .env.[mode].local are copied into
 *   process.env (existing variables win), so e.g. POE_MOCK=1 in .env.local works in dev.
 * - Like Vercel, x-forwarded-for / x-real-ip / x-forwarded-proto / x-forwarded-host are set
 *   when missing. The client disconnecting aborts `request.signal` and cancels the body.
 * - A method without an export gets 405 with an Allow header. A thrown error gets a 500 JSON body.
 * - /_vercel/insights/script.js (Vercel Web Analytics, platform-provided) answers with an empty
 *   script locally so pages load without console errors.
 */

type Handler = (request: Request) => Response | Promise<Response>;
type ApiModule = Record<string, unknown>;
type Loader = (id: string) => Promise<ApiModule>;

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const ROUTE_RE = /^\/api\/([A-Za-z0-9_-]+)\/?$/;

export interface ApiMiddlewareOptions {
  /** Directory holding the function files. Default: "<root>/api". */
  apiDir?: string;
}

function jsonError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify({ error: { code, message } }));
}

export function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const proto = String(req.headers['x-forwarded-proto'] ?? (encrypted ? 'https' : 'http')).split(',')[0]!.trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? req.headers[':authority'] ?? 'localhost');
  const path = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
  const url = new URL(path, `${proto}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(':')) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const remote = req.socket.remoteAddress ?? '127.0.0.1';
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', remote);
  if (!headers.has('x-real-ip')) headers.set('x-real-ip', remote);
  if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', proto);
  if (!headers.has('x-forwarded-host')) headers.set('x-forwarded-host', host);

  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function sendWebResponse(res: ServerResponse, response: Response, method: string): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);

  if (!response.body || method === 'HEAD') {
    await response.body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  // Send headers now so streamed responses (SSE) start immediately.
  res.flushHeaders();
  const reader = response.body.getReader();
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  res.once('close', cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      const ok = res.write(value);
      if (!ok) {
        await new Promise<void>((resolveDrain) => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            resolveDrain();
          };
          res.once('drain', finish);
          res.once('close', finish);
        });
      }
    }
  } finally {
    res.off('close', cancel);
    reader.releaseLock();
  }
  if (!res.destroyed) res.end();
}

const ANALYTICS_PATH = '/_vercel/insights/script.js';

function analyticsStub(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
  const pathname = ((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0];
  if (pathname !== ANALYTICS_PATH) return next();
  res.statusCode = 200;
  res.setHeader('content-type', 'text/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end('/* Vercel Web Analytics only runs on Vercel deployments. */\n');
}

export function createApiHandler(apiDir: string, load: Loader, logger: Logger) {
  return async function atpotatoApiMiddleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    const pathname = ((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0]!;
    const match = ROUTE_RE.exec(pathname);
    if (!match) return next();
    const file = resolve(apiDir, `${match[1]}.ts`);
    if (!existsSync(file)) return next();

    const method = (req.method ?? 'GET').toUpperCase();
    const started = Date.now();
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    let mod: ApiModule;
    try {
      mod = await load(file);
    } catch (err) {
      logger.error(`[api] failed to load ${file}: ${(err as Error)?.stack ?? String(err)}`);
      return jsonError(res, 500, 'upstream', 'the api route failed to load.');
    }

    const exported = METHODS.filter((m) => typeof mod[m] === 'function');
    const handler = (mod[method] as Handler | undefined) ?? (method === 'HEAD' ? (mod.GET as Handler | undefined) : undefined);
    if (typeof handler !== 'function') {
      return jsonError(res, 405, 'method_not_allowed', 'method not allowed.', { allow: exported.join(', ') });
    }

    try {
      const response = await handler(toWebRequest(req, controller.signal));
      if (!(response instanceof Response)) throw new TypeError('handler did not return a Response');
      await sendWebResponse(res, response, method);
      logger.info(`[api] ${method} ${pathname} ${response.status} ${Date.now() - started}ms`, { timestamp: true });
    } catch (err) {
      if (controller.signal.aborted) {
        logger.info(`[api] ${method} ${pathname} client closed after ${Date.now() - started}ms`, { timestamp: true });
        if (!res.destroyed) res.end();
        return;
      }
      logger.error(`[api] ${method} ${pathname} threw: ${(err as Error)?.stack ?? String(err)}`);
      jsonError(res, 500, 'upstream', 'something went wrong.');
    }
  };
}

function loadDotEnv(mode: string, envDir: string | false, root: string): void {
  if (envDir === false) return;
  const env = loadEnv(mode, envDir || root, '');
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('VITE_')) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function apiMiddleware(options: ApiMiddlewareOptions = {}): Plugin {
  let apiDir = options.apiDir ?? '';
  return {
    name: 'atpotato:api-middleware',
    configResolved(config) {
      apiDir = options.apiDir ?? resolve(config.root, 'api');
      if (config.command === 'serve') loadDotEnv(config.mode, config.envDir, config.root);
    },
    configureServer(server: ViteDevServer) {
      // Registered directly (not returned) so it runs before Vite's own HTML/static middlewares.
      server.middlewares.use(analyticsStub);
      server.middlewares.use(
        createApiHandler(apiDir, (id) => server.ssrLoadModule(id) as Promise<ApiModule>, server.config.logger),
      );
    },
    configurePreviewServer(preview) {
      let loader: Promise<ViteDevServer> | undefined;
      const getLoader = () =>
        (loader ??= createServer({
          configFile: false,
          root: preview.config.root,
          mode: preview.config.mode,
          envDir: false,
          logLevel: 'warn',
          appType: 'custom',
          server: { middlewareMode: true, hmr: false, ws: false, watch: null },
          optimizeDeps: { noDiscovery: true, include: [] },
        }));
      preview.httpServer.once('close', () => {
        void loader?.then((s) => s.close());
      });
      preview.middlewares.use(analyticsStub);
      preview.middlewares.use(
        createApiHandler(apiDir, async (id) => (await getLoader()).ssrLoadModule(id) as Promise<ApiModule>, preview.config.logger),
      );
    },
  };
}
