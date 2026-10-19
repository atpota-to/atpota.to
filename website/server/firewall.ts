import { checkRateLimit as vercelCheckRateLimit } from '@vercel/firewall';
import { errorName, type Logger } from './log.js';

/**
 * Optional global rate limit through the Vercel Firewall (SPEC 4.3). Only runs when
 * POE_RATE_LIMIT_ID is set; it needs a matching @vercel/firewall rule in the dashboard.
 * Any SDK failure is logged once per instance and the request continues to the local
 * limiter (fail open), so a missing rule or a firewall hiccup never takes chat down.
 */

export type CheckRateLimit = (
  id: string,
  options: { request: Request; timeout?: number },
) => Promise<{ rateLimited: boolean; error?: string }>;

export const defaultCheckRateLimit: CheckRateLimit = (id, options) => vercelCheckRateLimit(id, options);

const FIREWALL_TIMEOUT_MS = 1_500;

let warned = false;

/** Test hook: forget that the failure was already logged. */
export function resetFirewallWarning(): void {
  warned = false;
}

export async function firewallLimited(
  id: string,
  request: Request,
  check: CheckRateLimit,
  log: Logger,
): Promise<boolean> {
  try {
    const result = await check(id, { request, timeout: FIREWALL_TIMEOUT_MS });
    if (result.error === 'not-found' && !warned) {
      warned = true;
      log({ event: 'firewall_error', code: 'rule_not_found' });
    }
    return result.rateLimited === true;
  } catch (err) {
    if (!warned) {
      warned = true;
      log({ event: 'firewall_error', code: 'sdk_failed', error: errorName(err) });
    }
    return false;
  }
}
