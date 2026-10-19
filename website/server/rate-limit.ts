/**
 * Local, per-instance rate limiter (SPEC 4.3). Best effort: each Vercel instance keeps
 * its own counters, so the optional @vercel/firewall check is the global backstop.
 *
 *   per client IP:        8 messages / 10 minutes and 40 / day
 *   per conversation id:  30 messages / day
 *
 * Sliding-window logs (one timestamp per accepted message). A refused message is not
 * recorded, so hammering does not extend the wait. Memory is bounded by maxKeys.
 */

export interface WindowRule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const IP_RULES: readonly WindowRule[] = [
  { limit: 8, windowMs: 10 * MINUTE },
  { limit: 40, windowMs: DAY },
];
export const CONVERSATION_RULES: readonly WindowRule[] = [{ limit: 30, windowMs: DAY }];

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly longest: number;
  private readonly keep: number;

  constructor(
    private readonly rules: readonly WindowRule[],
    private readonly maxKeys = 10_000,
  ) {
    this.longest = Math.max(...rules.map((r) => r.windowMs));
    this.keep = Math.max(...rules.map((r) => r.limit));
  }

  /** Milliseconds until `key` may send again; 0 when it may send now. Does not record. */
  wait(key: string, now: number): number {
    const list = this.prune(key, now);
    if (!list) return 0;
    let wait = 0;
    for (const rule of this.rules) {
      const inWindow = list.filter((t) => t > now - rule.windowMs);
      if (inWindow.length >= rule.limit) {
        // The window frees a slot when the (n - limit + 1)th oldest hit ages out.
        const oldest = inWindow[inWindow.length - rule.limit]!;
        wait = Math.max(wait, oldest + rule.windowMs - now);
      }
    }
    return wait;
  }

  record(key: string, now: number): void {
    const list = this.prune(key, now) ?? [];
    list.push(now);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    // Re-insert so Map order is least-recently-used first.
    this.hits.delete(key);
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }

  get size(): number {
    return this.hits.size;
  }

  private prune(key: string, now: number): number[] | undefined {
    const list = this.hits.get(key);
    if (!list) return undefined;
    const cutoff = now - this.longest;
    let drop = 0;
    while (drop < list.length && list[drop]! <= cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length === 0) {
      this.hits.delete(key);
      return undefined;
    }
    return list;
  }
}

export interface LimitDecision {
  limited: boolean;
  /** Whole seconds for the retry-after header (at least 1 when limited). */
  retryAfter: number;
  scope?: 'ip' | 'conversation';
}

export interface LocalLimiter {
  /** Checks both scopes and records the message only when neither is over its limit. */
  take(ip: string, conversationId: string, now: number): LimitDecision;
}

export function createLocalLimiter(
  ipRules: readonly WindowRule[] = IP_RULES,
  conversationRules: readonly WindowRule[] = CONVERSATION_RULES,
): LocalLimiter {
  const byIp = new SlidingWindowLimiter(ipRules);
  const byConversation = new SlidingWindowLimiter(conversationRules);
  return {
    take(ip, conversationId, now) {
      const ipWait = byIp.wait(ip, now);
      const convWait = byConversation.wait(conversationId, now);
      if (ipWait > 0 || convWait > 0) {
        const scope = ipWait >= convWait ? 'ip' : 'conversation';
        return { limited: true, retryAfter: Math.max(1, Math.ceil(Math.max(ipWait, convWait) / 1000)), scope };
      }
      byIp.record(ip, now);
      byConversation.record(conversationId, now);
      return { limited: false, retryAfter: 0 };
    },
  };
}

/** The client IP as Vercel reports it: first x-forwarded-for entry, else x-real-ip. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real.slice(0, 64);
  return 'unknown';
}
