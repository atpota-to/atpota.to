import { existsSync, readFileSync } from 'node:fs';
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
 * - vercel.json "rewrites" whose destination is an /api/ route apply here too (e.g. /blog ->
 *   /api/blog?view=index), so pages served by a function work in dev and preview. Only the
 *   source syntax this site uses is understood: literal segments, ":name", ":name*" and
 *   ":name+". Unlike Vercel, there is no filesystem check first, so keep those sources off
 *   paths that are real files.
 */

type Handler = (request: Request) => Response | Promise<Response>;
type ApiModule = Record<string, unknown>;
type Loader = (id: string) => Promise<ApiModule>;

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const ROUTE_RE = /^\/api\/([A-Za-z0-9_-]+)\/?$/;

export interface ApiMiddlewareOptions {
  /** Directory holding the function files. Default: "<root>/api". */
  apiDir?: string;
  /** vercel.json to read rewrites from. Default: "<root>/vercel.json"; false to skip. */
  vercelJson?: string | false;
}

export interface Rewrite {
  source: string;
  destination: string;
}

interface CompiledRewrite {
  re: RegExp;
  names: string[];
  destination: string;
}

const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)([*+]?)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiles a vercel.json rewrite source ("/blog/:path*") into a regular expression. */
export function compileRewrite(rule: Rewrite): CompiledRewrite {
  const names: string[] = [];
  let pattern = '';
  for (const segment of rule.source.split('/').filter(Boolean)) {
    const param = PARAM_RE.exec(segment);
    if (!param) {
      if (segment.includes(':') || segment.includes('(')) throw new Error(`[api] unsupported rewrite source "${rule.source}"`);
      pattern += `/${escapeRegExp(segment)}`;
      continue;
    }
    names.push(param[1]!);
    if (param[2] === '*') pattern += '(?:/(.*))?';
    else if (param[2] === '+') pattern += '/(.+)';
    else pattern += '/([^/]+)';
  }
  return { re: new RegExp(`^${pattern || '/'}$`), names, destination: rule.destination };
}

/**
 * The first matching rewrite's destination for this path and query, with :params filled in
 * and the original query merged in (destination values win), or null when none match.
 */
export function applyRewrites(rules: readonly CompiledRewrite[], pathname: string, search: string): string | null {
  for (const rule of rules) {
    const match = rule.re.exec(pathname);
    if (!match) continue;
    const values = new Map(rule.names.map((name, i) => [name, match[i + 1] ?? '']));
    const filled = rule.destination.replace(/:([A-Za-z_][A-Za-z0-9_]*)[*+]?/g, (_m, name: string) =>
      values.has(name) ? values.get(name)! : '',
    );
    const url = new URL(filled, 'http://localhost');
    for (const [key, value] of new URLSearchParams(search)) if (!url.searchParams.has(key)) url.searchParams.append(key, value);
    return `${url.pathname}${url.search}`;
  }
  return null;
}

/** The vercel.json rewrites that point at an /api/ function, compiled. */
export function readApiRewrites(file: string): CompiledRewrite[] {
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, 'utf8')) as { rewrites?: Rewrite[] };
  return (config.rewrites ?? []).filter((r) => r.destination.startsWith('/api/')).map(compileRewrite);
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

export function toWebRequest(req: IncomingMessage, signal: AbortSignal, rewrittenPath?: string): Request {
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const proto = String(req.headers['x-forwarded-proto'] ?? (encrypted ? 'https' : 'http')).split(',')[0]!.trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? req.headers[':authority'] ?? 'localhost');
  const path = rewrittenPath ?? (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
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

export function createApiHandler(apiDir: string, load: Loader, logger: Logger, rewrites: readonly CompiledRewrite[] = []) {
  return async function atpotatoApiMiddleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    const original = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
    const queryAt = original.indexOf('?');
    const rewritten =
      rewrites.length > 0
        ? applyRewrites(rewrites, queryAt === -1 ? original : original.slice(0, queryAt), queryAt === -1 ? '' : original.slice(queryAt))
        : null;
    const pathname = (rewritten ?? original).split('?')[0]!;
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
      const response = await handler(toWebRequest(req, controller.signal, rewritten ?? undefined));
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
  let rewrites: CompiledRewrite[] = [];
  return {
    name: 'atpotato:api-middleware',
    configResolved(config) {
      apiDir = options.apiDir ?? resolve(config.root, 'api');
      if (options.vercelJson !== false) rewrites = readApiRewrites(options.vercelJson ?? resolve(config.root, 'vercel.json'));
      if (config.command === 'serve') loadDotEnv(config.mode, config.envDir, config.root);
    },
    configureServer(server: ViteDevServer) {
      // Registered directly (not returned) so it runs before Vite's own HTML/static middlewares.
      server.middlewares.use(analyticsStub);
      server.middlewares.use(
        createApiHandler(apiDir, (id) => server.ssrLoadModule(id) as Promise<ApiModule>, server.config.logger, rewrites),
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
        createApiHandler(
          apiDir,
          async (id) => (await getLoader()).ssrLoadModule(id) as Promise<ApiModule>,
          preview.config.logger,
          rewrites,
        ),
      );
    },
  };
}
