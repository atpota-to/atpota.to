/**
 * The stream's chat on screen: the streamer's stream.place chat as it comes in from
 * Jetstream (chat.ts), in one of three styles (config.ts WIDGET_STYLES, data-style):
 *
 *   corner   a little box of the last CORNER_SHOWN messages, in any slot
 *   side     a strip down the left or right edge, the whole height (or short of Poe on
 *            its side), as many as fit, the newest at the bottom
 *   pop      no box: each message pops up and fades away after POP_MS, a few at a time
 *
 * Chat is other people's words, so it goes in through textContent only, one line each and
 * at most TEXT_MAX characters, links as plain text, avatars only from Bluesky's CDN. What
 * stream.place hides stays hidden here: a message its writer deleted, one the streamer
 * hid (place.stream.chat.gate), and everything from someone the streamer blocks
 * (app.bsky.graph.block in their repo, read every BLOCKS_MS) or told Poe to ignore.
 */

import { line } from './records';
import { listPublic } from './store';
import type { Who } from './chat';

export const KEEP = 40;
export const CORNER_SHOWN = 6;
export const POP_SHOWN = 4;
export const POP_MS = 20_000;
export const POP_FADE_MS = 900;
export const TEXT_MAX = 300;
export const BLOCKS_MS = 10 * 60_000;
export const BLOCKS_MAX = 2000;
export const DEMO_MS = 3500;
/** How many colours handles take turns in (overlay.css .ov-chat [data-hue]). */
export const HUES = 6;

export const DEMO_CHAT: ReadonlyArray<readonly [string, string]> = [
  ['dame.is', 'hello hello! (◕‿◕)'],
  ['poe.atpota.to', 'the atmosphere is breezy today'],
  ['alice.mosphere.at', 'first time here, love the potato'],
  ['zschamis.com', '!weather'],
  ['xan.lol', 'what are we building today?'],
  ['plumber.flushes.app', 'just flushed. back to the stream'],
];

/** A colour for someone, the same every time. */
export function hueOf(did: string): number {
  let h = 0;
  for (const c of did) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % HUES;
}

export interface OnscreenChat {
  add(m: { did: string; rkey: string; text: string }, who: Who): void;
  /** Its writer deleted it, or the streamer hid it. */
  remove(did: string, rkey: string, forGood?: boolean): void;
  /** Accounts whose messages never show (the streamer's ignore list, as DIDs). */
  setSkip(dids: Set<string>): void;
  /** Starts reading the streamer's blocks, and keeps them current. */
  watchBlocks(streamer: string): void;
  demo(on: boolean): void;
}

export function mountOnscreenChat(el: HTMLElement, opts: { win?: Window; fetchImpl?: typeof fetch; now?: () => number } = {}): OnscreenChat {
  const win = opts.win ?? window;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const doc = el.ownerDocument;
  const list = el.querySelector<HTMLElement>('[data-ov-chat-list]')!;
  const empty = el.querySelector<HTMLElement>('[data-ov-chat-empty]');
  let skip = new Set<string>();
  let blocked = new Set<string>();
  const hidden = new Set<string>();
  let demoTimer: number | undefined;

  const key = (did: string, rkey: string) => `${did}/${rkey}`;
  const refresh = () => {
    if (empty) empty.hidden = list.childElementCount > 0;
    el.dataset.state = list.childElementCount > 0 ? 'ready' : 'empty';
  };
  const drop = (pred: (li: HTMLElement) => boolean) => {
    for (const li of [...list.children] as HTMLElement[]) if (pred(li)) li.remove();
    refresh();
  };

  const chat: OnscreenChat = {
    add(m, who) {
      const text = line(m.text, TEXT_MAX);
      const k = key(m.did, m.rkey);
      if (!text || skip.has(m.did) || blocked.has(m.did) || hidden.has(k) || [...list.children].some((li) => (li as HTMLElement).dataset.key === k)) return;
      const li = doc.createElement('li');
      li.className = 'ov-chat__msg';
      li.dataset.key = k;
      li.dataset.did = m.did;
      li.dataset.hue = String(hueOf(m.did));
      if (who.avatar) {
        const img = doc.createElement('img');
        img.className = 'ov-chat__avatar';
        img.alt = '';
        img.src = who.avatar;
        img.referrerPolicy = 'no-referrer';
        li.append(img);
      } else {
        const blank = doc.createElement('span');
        blank.className = 'ov-chat__avatar ov-chat__avatar--blank';
        li.append(blank);
      }
      const words = doc.createElement('p');
      words.className = 'ov-chat__words';
      const name = doc.createElement('strong');
      name.className = 'ov-chat__who';
      name.textContent = who.handle ?? 'someone';
      const said = doc.createElement('span');
      said.className = 'ov-chat__text';
      said.textContent = text;
      words.append(name, ' ', said);
      li.append(words);
      list.append(li);
      while (list.childElementCount > KEEP) list.firstElementChild!.remove();
      // a popped-up message fades (is-old), then gives up its place (is-gone)
      win.setTimeout(() => li.classList.add('is-old'), POP_MS);
      win.setTimeout(() => li.classList.add('is-gone'), POP_MS + POP_FADE_MS);
      refresh();
    },
    remove(did, rkey, forGood = false) {
      const k = key(did, rkey);
      if (forGood) hidden.add(k);
      drop((li) => li.dataset.key === k);
    },
    setSkip(dids) {
      skip = dids;
      drop((li) => skip.has(li.dataset.did ?? ''));
    },
    watchBlocks(streamer) {
      const read = async () => {
        const recs = await listPublic(streamer, 'app.bsky.graph.block', BLOCKS_MAX, fetchImpl);
        if (recs) {
          blocked = new Set(recs.map((r) => r.value.subject).filter((s): s is string => typeof s === 'string' && s.startsWith('did:')));
          drop((li) => blocked.has(li.dataset.did ?? ''));
        }
        win.setTimeout(() => void read(), BLOCKS_MS);
      };
      void read();
    },
    demo(on) {
      win.clearInterval(demoTimer);
      if (!on) return;
      let i = 0;
      const next = () => {
        const [handle, text] = DEMO_CHAT[i % DEMO_CHAT.length]!;
        chat.add({ did: `did:example:${handle}`, rkey: String(i++), text }, { handle: `@${handle}`, avatar: null });
      };
      next();
      next();
      demoTimer = win.setInterval(next, DEMO_MS);
    },
  };
  refresh();
  return chat;
}
