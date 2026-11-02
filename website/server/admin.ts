/**
 * The admin page's proxy (/api/admin, the page is admin/index.html): Poe's state, memory and
 * guidance for the people who run it, and a few things they can change.
 *
 * Who: a signed-in visitor whose DID is on ADMIN_DIDS, or Poe's own account. They prove it the
 * way the chat and "forget me" do: their PDS signs an atproto service-auth token addressed to
 * atpota.to for its own method, to.atpota.poe.admin (server/identity.ts verifies it). A chat or
 * forget token never opens this.
 *
 * Where it goes: two upstreams, each on ADMIN_SHARED_SECRET, which nothing else holds:
 *   the bot     POST {POE_AGENT_URL}/admin/memory    every private memory (bot/agent/lib/memory-admin.ts)
 *   the droplet {DROPLET_ADMIN_ORIGIN}/admin/...     state, guidance, history, nap (mentions/src/admin.js)
 * Both get the admin's DID too; the droplet checks it against its own ADMIN_DIDS. The secret
 * must differ from WEBSITE_SHARED_SECRET, which can only ever assert a chat visitor.
 *
 *   ADMIN_DIDS              comma-separated; empty means nobody (503)
 *   ADMIN_SHARED_SECRET     required (503 without it)
 *   DROPLET_ADMIN_ORIGIN    default https://hook.atpota.to
 *
 * GET  ?view=overview | history&slot=&scope= | person&did= | digest
 * POST { target: "memory" | "restore" | "guidance" | "nap", ... }
 */

import { POE_DID } from './blog/config.js';
import { normalizeAgentUrl, readConfig, type Env } from './config.js';
import { bearerToken, identify, POE_ADMIN_LXM, type IdentifyResult } from './identity.js';
import { consoleLogger, type Logger } from './log.js';
import { isAllowedOrigin } from './origin.js';
import { parseJson, readBodyCapped } from './validation.js';

export const DEFAULT_DROPLET_ADMIN_ORIGIN = 'https://hook.atpota.to';
export const ADMIN_SECRET_HEADER = 'x-atpotato-admin-secret';
export const ADMIN_DID_HEADER = 'x-atpotato-admin-did';
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_BODY = 96 * 1024;
const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,253})$/;
const SLOTS = new Set(['life', 'operator-dm-life', 'self', 'operator-notes', 'person']);
const MEMORY_ACTIONS = new Set(['read', 'add', 'edit', 'remove', 'remove-archived']);
const SHARED_SCOPES: Record<string, string> = { life: 'poe-life', 'operator-dm-life': 'poe-operator-dm-life', self: 'poe-self' };

export interface AdminConfig {
  admins: string[];
  secret: string | null;
  agentUrl: string | null;
  dropletUrl: string | null;
  identity: boolean;
}

export function readAdminConfig(env: Env): AdminConfig {
  const chat = readConfig(env);
  const secret = env.ADMIN_SHARED_SECRET?.trim() || null;
  return {
    admins: (env.ADMIN_DIDS ?? '').split(',').map((s) => s.trim()).filter((s) => DID_RE.test(s)),
    // Never the chat's secret: that one may only assert a visitor.
    secret: secret && secret !== chat.secret ? secret : null,
    agentUrl: chat.agentUrl,
    dropletUrl: normalizeAgentUrl(env.DROPLET_ADMIN_ORIGIN?.trim() || DEFAULT_DROPLET_ADMIN_ORIGIN),
    identity: chat.identity,
  };
}

export interface AdminDeps {
  env?: () => Env;
  fetch?: typeof fetch;
  log?: Logger;
  identify?: (token: string) => Promise<IdentifyResult>;
}

export interface AdminHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
};

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status: number, message: string) => json(status, { error: { message } });

type Upstream = { ok: true; body: unknown } | { ok: false; status: number; message: string };

export function createAdminHandlers(deps: AdminDeps = {}): AdminHandlers {
  const env = deps.env ?? (() => process.env);
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = deps.log ?? consoleLogger;
  const verify = deps.identify ?? ((token: string) => identify(token, { fetch: doFetch, lxm: POE_ADMIN_LXM }));

  /** The admin behind a request, or the response that refuses it. */
  async function admin(request: Request, config: AdminConfig): Promise<{ did: string; handle: string | null } | Response> {
    if (!config.identity || !config.secret || !config.agentUrl || !config.dropletUrl) {
      log({ event: 'admin', status: 503, code: 'not_configured' });
      return fail(503, "the admin page isn't set up on this deployment yet");
    }
    const token = bearerToken(request);
    const result: IdentifyResult = token
      ? await verify(token).catch((): IdentifyResult => ({ ok: false, reason: 'no_key' }))
      : { ok: false, reason: 'malformed' };
    if (!result.ok) {
      log({ event: 'admin', status: 401, code: result.reason });
      return fail(401, 'sign in again to use the admin page');
    }
    const { did, handle } = result.visitor;
    if (did !== POE_DID && !config.admins.includes(did)) {
      log({ event: 'admin', status: 403, code: 'not_admin' });
      return fail(403, 'this page is only for the people who run poe');
    }
    return { did, handle };
  }

  async function upstream(url: string, init: RequestInit, config: AdminConfig, did: string): Promise<Upstream> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          [ADMIN_SECRET_HEADER]: config.secret!,
          [ADMIN_DID_HEADER]: did,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 502, message: 'unreachable' };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, body };
    const detail = body?.detail ?? body?.error;
    return {
      ok: false,
      status: res.status >= 500 ? 502 : res.status,
      message: typeof detail === 'string' && detail.length <= 300 ? detail : `answered ${res.status}`,
    };
  }

  const droplet = (path: string, config: AdminConfig, did: string, body?: unknown) =>
    upstream(`${config.dropletUrl}${path}`, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) }, config, did);
  const memory = (call: Record<string, unknown>, config: AdminConfig, did: string) =>
    upstream(`${config.agentUrl}/admin/memory`, { method: 'POST', body: JSON.stringify({ ...call, by: did }) }, config, did);

  const answer = (result: Upstream) => (result.ok ? json(200, result.body) : fail(result.status, result.message));
  const part = (result: Upstream) => (result.ok ? result.body : { error: result.message });

  async function GET(request: Request): Promise<Response> {
    const config = readAdminConfig(env());
    const who = await admin(request, config);
    if (who instanceof Response) return who;
    const params = new URL(request.url).searchParams;
    const view = params.get('view') ?? 'overview';

    if (view === 'overview') {
      const [state, guidance, people, mem] = await Promise.all([
        droplet('/admin/state', config, who.did),
        droplet('/admin/guidance', config, who.did),
        droplet('/admin/people', config, who.did),
        memory({ action: 'overview', operators: config.admins }, config, who.did),
      ]);
      log({ event: 'admin', status: 200, code: 'overview' });
      return json(200, { me: who, admins: config.admins, state: part(state), guidance: part(guidance), people: part(people), memory: part(mem) });
    }
    if (view === 'history') {
      const slot = params.get('slot') ?? '';
      const scope = params.get('scope') ?? '';
      if (!/^[a-z][a-z-]{0,40}(:archive)?$/.test(slot) || !scope || scope.length > 300) return fail(400, 'which history?');
      return answer(await droplet(`/admin/memory/history?${new URLSearchParams({ slot, scope, limit: '40' })}`, config, who.did));
    }
    if (view === 'person') {
      const did = params.get('did') ?? '';
      if (!DID_RE.test(did)) return fail(400, 'that is not a DID');
      return answer(await memory({ action: 'read', slot: 'person', did }, config, who.did));
    }
    if (view === 'digest') return answer(await droplet('/admin/digest', config, who.did));
    return fail(404, 'no such view');
  }

  async function POST(request: Request): Promise<Response> {
    if (!isAllowedOrigin(request.headers.get('origin'), request.url)) return fail(403, 'not from atpota.to');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(415, 'send JSON');
    const config = readAdminConfig(env());
    const who = await admin(request, config);
    if (who instanceof Response) return who;
    const raw = await readBodyCapped(request, MAX_BODY);
    if (!raw.ok) return fail(raw.reason === 'too_large' ? 413 : 400, 'that request is too big or unreadable');
    const parsed = parseJson(raw.text);
    const body = parsed.ok && parsed.value && typeof parsed.value === 'object' ? (parsed.value as Record<string, unknown>) : null;
    if (!body) return fail(400, 'send a JSON object');
    const target = ['memory', 'restore', 'guidance', 'nap'].includes(String(body.target)) ? String(body.target) : 'unknown';
    log({ event: 'admin', status: 200, code: `post_${target}` });

    switch (body.target) {
      case 'memory': {
        const call = body.call as Record<string, unknown> | undefined;
        if (!call || typeof call !== 'object' || !MEMORY_ACTIONS.has(String(call.action)) || !SLOTS.has(String(call.slot))) {
          return fail(400, 'that memory change is not one the admin page makes');
        }
        return answer(await memory(call, config, who.did));
      }
      case 'restore': {
        // Write an old version back: read it from the droplet's backup log, check it is a
        // version of the document being restored, then have the bot store it.
        const slot = String(body.slot ?? '');
        const did = typeof body.did === 'string' ? body.did : undefined;
        const id = Number(body.versionId);
        if (!SLOTS.has(slot) || !Number.isInteger(id) || id < 1) return fail(400, 'which version?');
        const scope = SHARED_SCOPES[slot] ?? did;
        if (!scope || (!(slot in SHARED_SCOPES) && !DID_RE.test(scope))) return fail(400, 'whose notes?');
        const version = await droplet(`/admin/memory/version?id=${id}`, config, who.did);
        if (!version.ok) return answer(version);
        const v = version.body as { slot?: unknown; scope?: unknown; content?: unknown } | null;
        if (v?.slot !== slot || v.scope !== scope || typeof v.content !== 'string') {
          return fail(400, 'that version belongs to another document');
        }
        return answer(await memory({ action: 'restore', slot, ...(did ? { did } : {}), content: v.content }, config, who.did));
      }
      case 'guidance': {
        const { target: _target, ...rest } = body;
        return answer(await droplet('/admin/guidance', config, who.did, rest));
      }
      case 'nap':
        return answer(await droplet('/admin/nap', config, who.did, { text: String(body.text ?? '').slice(0, 200) }));
      default:
        return fail(400, 'target must be memory, restore, guidance or nap');
    }
  }

  async function methodNotAllowed(): Promise<Response> {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST', 'cache-control': 'no-store' } });
  }

  return { GET, POST, methodNotAllowed };
}
