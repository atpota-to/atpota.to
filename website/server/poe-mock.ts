/**
 * Mock Poe (SPEC 4.4): a deterministic stream that honours the browser contract, so
 * the widget can be built and tested end to end without the bot. Only active with
 * POE_MOCK=1 and VERCEL_ENV other than "production" (see config.ts).
 *
 *   ready (sent by the handler) -> status "looking that up" -> word-by-word deltas
 *   -> block -> done (links ["https://aturi.to"] when the message mentions "at://" or "link")
 *
 * Triggers for tests: "#error" -> error upstream; "#slow" -> 3 s of pings, then the
 * answer; "#rate" -> 429 JSON before any stream.
 */

import { jsonError } from './http.js';
import { MESSAGES } from './messages.js';
import type { Emit, TurnResult } from './upstream.js';
import type { ChatInput } from './validation.js';

export const MOCK_LINK = 'https://aturi.to';
export const MOCK_STATUS = 'looking that up';

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** "#rate": the pre-stream 429 a real rate limit would give. */
export function mockPreStream(message: string): Response | null {
  if (message.includes('#rate')) {
    return jsonError(429, 'rate_limited', MESSAGES.rate_limited, { 'retry-after': '60' });
  }
  return null;
}

export function mockWantsLink(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('at://') || m.includes('link');
}

export function mockAnswer(input: Pick<ChatInput, 'message' | 'selection'>): { text: string; links: string[] } {
  const link = mockWantsLink(input.message);
  const paragraphs = [
    "hi! i'm the practice version of poe, so this answer is pretend and nothing was looked up.",
    [
      'a real answer can hold:',
      '- short paragraphs and little lists like this one',
      '- names of things as code, like `app.bsky.feed.post` or `at://atpota.to`',
    ].join('\n'),
  ];
  if (input.selection) paragraphs.push('you highlighted some text on the page, so a real answer would explain that bit.');
  if (link) paragraphs.push(`here's where i'd have looked: ${MOCK_LINK}`);
  paragraphs.push('ask me something else whenever you like. (◕‿◕)');
  return { text: paragraphs.join('\n\n'), links: link ? [MOCK_LINK] : [] };
}

export interface MockOptions {
  input: ChatInput;
  emit: Emit;
  /** Writes one ": ping" comment. */
  ping: () => void;
  signal: AbortSignal;
  sleep?: Sleep;
  /** Delay between deltas, default 35 ms (visible streaming in curl -N). */
  stepMs?: number;
}

export async function runMockTurn(opts: MockOptions): Promise<TurnResult> {
  const { input, emit, signal } = opts;
  const sleep = opts.sleep ?? realSleep;
  const stepMs = opts.stepMs ?? 35;
  let deltas = 0;
  const aborted = (): TurnResult => ({ outcome: 'aborted', code: 'client_gone', deltas, tools: 0 });

  if (input.message.includes('#slow')) {
    for (let i = 0; i < 6; i++) {
      await sleep(500, signal);
      if (signal.aborted) return aborted();
      opts.ping();
    }
  }

  emit({ event: 'status', data: { state: 'digging', label: MOCK_STATUS } });
  await sleep(250, signal);
  if (signal.aborted) return aborted();

  if (input.message.includes('#error')) {
    emit({ event: 'error', data: { code: 'upstream', message: MESSAGES.upstream } });
    return { outcome: 'error', code: 'mock_error', deltas, tools: 1 };
  }

  const { text, links } = mockAnswer(input);
  const pieces = text.match(/\S+\s*|\s+/g) ?? [text];
  for (const piece of pieces) {
    emit({ event: 'delta', data: { text: piece, block: 0 } });
    deltas++;
    await sleep(stepMs, signal);
    if (signal.aborted) return aborted();
  }
  emit({ event: 'block', data: { text, block: 0 } });
  emit({ event: 'done', data: { text, links } });
  return { outcome: 'done', deltas, tools: 1 };
}
