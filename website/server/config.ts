/**
 * Environment for the /api/poe proxy (SPEC 4.3). Read on every request, never cached,
 * so a changed env var applies on the next call and tests can set process.env freely.
 *
 *   WEBSITE_SHARED_SECRET    required; without it POST answers 503 not_configured
 *   POE_AGENT_URL            default https://atpotato-bot.vercel.app
 *   POE_CHAT_DISABLED=1      kill switch: POST answers 503
 *   POE_RATE_LIMIT_ID        optional @vercel/firewall rate limit id
 *   POE_MOCK=1               deterministic mock stream, ignored when VERCEL_ENV=production
 *   POE_UPSTREAM_TIMEOUT_MS  whole-turn upstream timeout, default 240000
 */

export const DEFAULT_AGENT_URL = 'https://atpotato-bot.vercel.app';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 240_000;
/** Stay under the function's maxDuration (300 s in vercel.json) so the proxy, not Vercel, ends the turn. */
export const MAX_UPSTREAM_TIMEOUT_MS = 290_000;
export const MIN_UPSTREAM_TIMEOUT_MS = 1_000;

export type Env = Record<string, string | undefined>;

export interface PoeConfig {
  /** WEBSITE_SHARED_SECRET, or null when unset/empty. Never logged. */
  secret: string | null;
  /** Base URL without a trailing slash, or null when POE_AGENT_URL is not a usable URL. */
  agentUrl: string | null;
  disabled: boolean;
  rateLimitId: string | null;
  /** POE_MOCK=1 and VERCEL_ENV is not "production". */
  mock: boolean;
  upstreamTimeoutMs: number;
  production: boolean;
}

function flag(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https URL (http only for loopback, for local bot development); no credentials, query or hash. */
export function normalizeAgentUrl(raw: string | undefined): string | null {
  const value = raw?.trim() || DEFAULT_AGENT_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (!secure && !localHttp) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.round(n)));
}

export function readConfig(env: Env = process.env): PoeConfig {
  const production = env.VERCEL_ENV === 'production';
  const rateLimitId = env.POE_RATE_LIMIT_ID?.trim();
  return {
    secret: env.WEBSITE_SHARED_SECRET ? env.WEBSITE_SHARED_SECRET : null,
    agentUrl: normalizeAgentUrl(env.POE_AGENT_URL),
    disabled: flag(env.POE_CHAT_DISABLED),
    rateLimitId: rateLimitId ? rateLimitId : null,
    mock: flag(env.POE_MOCK) && !production,
    upstreamTimeoutMs: parseTimeout(env.POE_UPSTREAM_TIMEOUT_MS),
    production,
  };
}
