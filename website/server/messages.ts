/**
 * Every message a visitor can see from the proxy. Lowercase, friendly, no internals.
 * The `code` that travels with each message is what the widget acts on.
 */

export type ErrorCode =
  | 'not_configured'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream'
  | 'timeout'
  | 'conversation_over'
  | 'busy';

export const ERROR_CODES: readonly ErrorCode[] = [
  'not_configured',
  'rate_limited',
  'bad_request',
  'upstream',
  'timeout',
  'conversation_over',
  'busy',
];

export const MESSAGES = {
  not_configured: "poe isn't answering on the website right now. you can ask @poe.atpota.to on bluesky in the meantime.",
  disabled: 'poe is taking a nap right now. you can ask @poe.atpota.to on bluesky in the meantime.',
  rate_limited: "that's a lot of questions in a short time. give poe a few minutes to catch up.",
  bad_request: "poe couldn't read that message. try sending it again.",
  message_empty: 'type a question for poe first.',
  message_too_long: 'that message is a bit long for poe. try keeping it under 1000 characters.',
  selection_too_long: 'that highlight is a bit long for poe. try a shorter piece of text.',
  too_large: 'that request is too big for poe.',
  method: 'poe only answers chat messages here.',
  origin: 'poe only answers questions asked on atpota.to.',
  upstream: 'poe tripped over a root. try again in a moment.',
  timeout: 'poe is still digging. ask again in a minute.',
  conversation_over: 'this chat has run its course. start a new chat to keep going.',
  busy: 'poe is still answering your last message.',
  forget_unavailable: "poe can't forget anyone from the website right now. try again a little later.",
  forget_sign_in: "poe couldn't tell it's you. sign in again, then ask once more.",
  forget_failed: "poe couldn't finish forgetting just now. try again in a moment.",
} as const;

/** Default message for an error code relayed from the bot. */
export function messageForCode(code: ErrorCode): string {
  switch (code) {
    case 'not_configured':
      return MESSAGES.not_configured;
    case 'rate_limited':
      return MESSAGES.rate_limited;
    case 'bad_request':
      return MESSAGES.bad_request;
    case 'timeout':
      return MESSAGES.timeout;
    case 'conversation_over':
      return MESSAGES.conversation_over;
    case 'busy':
      return MESSAGES.busy;
    case 'upstream':
    default:
      return MESSAGES.upstream;
  }
}
