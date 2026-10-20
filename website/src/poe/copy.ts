/**
 * Every visible string the widget owns. Lowercase brand voice, no em dashes, no
 * emoji. Mock copy (H-Desktop, H-Mobile, H-Poe-*) is reused verbatim.
 */

import type { NoteCode } from './storage';

export const COPY = {
  askPoe: 'ask poe',
  title: 'poe',
  subtitle: 'a potato who reads the atmosphere for you',
  close: 'close poe',
  greeting: "hi! i'm poe. paste an at:// link or a handle, or ask me anything about atproto and bluesky.",
  placeholder: 'ask poe something',
  placeholderFollowUp: 'ask a follow-up',
  inputLabel: 'ask poe',
  send: 'send',
  footnoteLead: 'poe can get things wrong, so it shows where it looked.',
  // The "/" hint only shows where there is a keyboard (.only-hover).
  footnoteBefore: ' press ',
  footnoteAfter: ' on any page to open it.',
  newChat: 'new chat',
  dismissNudge: 'dismiss tip',
  conversation: 'conversation with poe',
  suggestions: 'suggestions',
  you: 'you said:',
  youAbout: 'you asked about',
  poeSaid: 'poe said:',
  digging: 'digging',
  pill: 'ask poe about this',
  selectionQuestion: 'what does this mean?',
  summarize: 'summarize this section',
  startNewChat: 'start a new chat',
  newChatAnnounce: 'started a new chat with poe.',
  answerAnnounce: 'poe says: ',
} as const;

/** What Poe says while it starts on a question, before any tool reports in (the widget adds "…"). */
export const DIGGING_LINES: readonly string[] = [
  COPY.digging,
  'peeling that open',
  'checking under the soil',
  'asking the other potatoes',
  'rummaging in the root cellar',
  'mashing the firehose',
];

export const CHIPS_DEFAULT = ["what's a labeler?", 'can my domain be my handle?', 'what is an at:// link?'] as const;
export const CHIPS_GUIDE = ['explain starter packs', "what's a custom feed?", COPY.summarize] as const;

export function contextLabel(page: string, guideTitle: string | null): { prefix: string; text: string; icon: 'book' | null } {
  if (page === 'guide') {
    const title = (guideTitle ?? 'how to use bluesky to grow your brand').trim().toLowerCase();
    return { prefix: 'reading: ', text: title, icon: 'book' };
  }
  if (page === 'home') return { prefix: "you're on: ", text: 'atpota.to home', icon: null };
  if (page === 'notfound') return { prefix: "you're on: ", text: 'a page that went missing', icon: null };
  return { prefix: "you're on: ", text: 'atpota.to', icon: null };
}

export const POE_BLUESKY_URL = 'https://bsky.app/profile/poe.atpota.to';

export interface NoteCopy {
  text: string;
  /** Optional inline link placed at the "@poe.atpota.to" mention. */
  linkText?: string;
  linkHref?: string;
  /** Offer a "start a new chat" button. */
  offerNewChat?: boolean;
}

/** The burst rule (8 per 10 minutes) and the firewall never ask for longer; a longer wait means a daily cap. */
export const SHORT_BREAK_MAX_S = 600;

/** "about a minute", "about 7 minutes", "about an hour", "about 20 hours". */
export function waitPhrase(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  if (m < 60) return m === 1 ? 'about a minute' : `about ${m} minutes`;
  const h = Math.round(seconds / 3600);
  return h <= 1 ? 'about an hour' : `about ${h} hours`;
}

export function noteCopy(code: NoteCode, retryAfter?: number): NoteCopy {
  switch (code) {
    case 'not_configured':
      // Also what the kill switch (POE_CHAT_DISABLED) answers, so it must be true after launch too.
      return {
        text: "poe isn't answering on the website right now. you can ask @poe.atpota.to on bluesky in the meantime.",
        linkText: '@poe.atpota.to',
        linkHref: POE_BLUESKY_URL,
      };
    case 'rate_limited':
      if (retryAfter && retryAfter > SHORT_BREAK_MAX_S) {
        // A daily cap: not "in a row", and not a short break. No "tomorrow": the window is a rolling 24 hours.
        return {
          text: `that's all the questions i can take from you for now. try again in ${waitPhrase(retryAfter)}, or ask @poe.atpota.to on bluesky.`,
          linkText: '@poe.atpota.to',
          linkHref: POE_BLUESKY_URL,
        };
      }
      return {
        text: retryAfter
          ? `that's a lot of questions in a row, so i need a short break. try again in ${waitPhrase(retryAfter)}.`
          : "that's a lot of questions in a row, so i need a short break. try again in a few minutes.",
      };
    case 'bad_request':
      return { text: "i couldn't read that one. try asking it a different way, in under 1000 characters." };
    case 'timeout':
      return { text: 'that took too long, so i stopped digging. try again, or ask something smaller?' };
    case 'conversation_over':
      return { text: "this chat has run its course. start a new one and i'm all yours.", offerNewChat: true };
    case 'busy':
      return { text: "i'm still working on your last question. give me a moment, then ask again." };
    case 'offline':
      return { text: "looks like you're offline. i'll be here when you're back." };
    case 'network':
      return { text: "i couldn't get through just now. check your connection and try again?" };
    case 'interrupted':
      return { text: 'i lost that answer when the page changed. ask me again?' };
    case 'cut_off':
      return { text: 'my answer got cut off. try asking again?' };
    case 'empty':
      return { text: 'i came up empty on that one. try asking another way?' };
    case 'fresh_start':
      // The proxy started a new conversation (the cookie ran out, or "new chat" in another tab).
      return { text: "i lost track of our earlier chat, so we're starting fresh. i won't remember what's above." };
    case 'upstream':
    default:
      return { text: 'something went wrong on my side. try again in a moment?' };
  }
}
