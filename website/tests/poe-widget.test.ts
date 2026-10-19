// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_CODES } from '../src/poe/storage.js';
import { POE_BLUESKY_URL, noteCopy, waitPhrase } from '../src/poe/copy.js';
import { mountPoe, unmountPoe } from '../src/poe/index.js';
import { faceUrl } from '../src/poe/moods.js';
import { PHONE_QUERY, type PoeWidget } from '../src/poe/ui.js';
import { resetStoresForTests } from '../src/poe/storage.js';

/* ---------- helpers ---------- */

function sse(events: Array<[string, unknown] | string>): string {
  return events.map((e) => (typeof e === 'string' ? `${e}\n\n` : `event: ${e[0]}\ndata: ${JSON.stringify(e[1])}\n\n`)).join('');
}

/** A controllable streaming response: push() chunks, then end(). */
function controlledStream() {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
    push: (text: string) => ctrl.enqueue(encoder.encode(text)),
    end: () => ctrl.close(),
  };
}

function okStream(events: Array<[string, unknown] | string>): Response {
  return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    return respond(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function setPage(page: string, nudge = 'need a hand? ask me anything about atproto.') {
  document.body.dataset.page = page;
  document.body.dataset.poeNudge = nudge;
}

function stubMatchMedia(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === PHONE_QUERY ? phone : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Waits until `check` passes (for turns started by a click, which nobody awaits). */
async function until(check: () => boolean, ms = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function pageshow(persisted: boolean): Event {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  return event;
}

const stored = () => JSON.parse(window.sessionStorage.getItem('poe:transcript') ?? '[]') as Array<Record<string, unknown>>;
const bubbles = () => Array.from(document.querySelectorAll<HTMLElement>('.poe-msg:not(.poe-msg--greeting)'));

let widget: PoeWidget;

function mount(fetchImpl?: typeof fetch, opts: { nudgeDelayMs?: number } = {}) {
  widget = mountPoe({ fetchImpl, ...opts })!;
  return widget;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

beforeEach(() => {
  document.body.innerHTML = `
    <header data-site-header><button type="button" class="ask-poe-btn" data-poe-open>ask poe</button></header>
    <main id="main">
      <input id="page-input">
      <button id="say-hi" type="button" data-poe-open>say hi to poe</button>
      <article data-poe-askable><h2>3. Labelers</h2><p id="para">a special tool called labelers here</p></article>
    </main>`;
  setPage('home');
  stubMatchMedia(false);
  resetStoresForTests();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  unmountPoe();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ---------- tests ---------- */

describe('mount', () => {
  it('adds the corner potato and a hidden dialog, once', () => {
    mount();
    const potato = $<HTMLButtonElement>('.poe-potato');
    expect(potato.getAttribute('aria-label')).toBe('ask poe');
    expect(potato.getAttribute('aria-keyshortcuts')).toBe('/');
    expect(potato.getAttribute('aria-expanded')).toBe('false');
    expect(potato.querySelector('img')!.getAttribute('alt')).toBe('');
    expect(potato.querySelector('img')!.getAttribute('src')).toBe(faceUrl('resting'));
    const panel = $('#poe-panel');
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toBe('poe');
    expect(mountPoe()).toBe(widget);
    expect(document.querySelectorAll('#poe-root')).toHaveLength(1);
    for (const opener of Array.from(document.querySelectorAll('[data-poe-open]'))) {
      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(opener.getAttribute('aria-controls')).toBe('poe-panel');
    }
  });

  it('shows the page context chip and the mock copy', () => {
    mount();
    expect($('.poe-context').textContent).toBe("you're on: atpota.to home");
    expect($('.poe-msg--greeting').textContent).toContain("hi! i'm poe. paste an at:// link or a handle, or ask me anything about atproto and bluesky.");
    expect(Array.from(document.querySelectorAll('.poe-chip')).map((c) => c.textContent)).toEqual(["what's a labeler?", 'can my domain be my handle?', 'what is an at:// link?']);
    expect($('.poe-foot').textContent).toBe('poe can get things wrong, so it shows where it looked. press / on any page to open it.');
    // touch screens have no "/" to press: that part is .only-hover (display: none on touch)
    const hint = $('.poe-foot .only-hover');
    expect(hint.textContent).toBe(' press / on any page to open it.');
    expect(hint.querySelector('kbd')!.textContent).toBe('/');
    const header = readFileSync(join(process.cwd(), 'src/partials/header.html'), 'utf8');
    expect(header).toMatch(/<kbd class="kbd only-hover" aria-hidden="true">\/<\/kbd>/);
    expect(Array.from(document.querySelectorAll('.poe-textbtn')).map((b) => b.textContent)).toEqual(['new chat']);
  });

  it('uses the guide context and chips on the guide page', () => {
    setPage('guide', 'stuck on a word? highlight it and ask me.');
    document.querySelector('main')!.insertAdjacentHTML('afterbegin', '<h1 class="guide__title">How to use Bluesky to grow your brand</h1>');
    mount();
    expect($('.poe-context').textContent).toBe('reading: how to use bluesky to grow your brand');
    expect($('.poe-context svg')).not.toBeNull();
    expect(Array.from(document.querySelectorAll('.poe-chip')).map((c) => c.textContent)).toEqual(['explain starter packs', "what's a custom feed?", 'summarize this section']);
  });
});

describe('opening and closing', () => {
  it('opens from the potato, focuses the input, hides the potato, and Esc returns focus', () => {
    mount();
    const potato = $<HTMLButtonElement>('.poe-potato');
    potato.focus();
    potato.click();
    expect(widget.opened).toBe(true);
    expect($('#poe-panel').hidden).toBe(false);
    expect($('#poe-root').dataset.open).toBe('true');
    expect(document.activeElement).toBe($('#poe-input'));
    expect(potato.getAttribute('aria-expanded')).toBe('true');
    expect($('.poe-panel__potato').getAttribute('src')).toBe(faceUrl('curious'));
    const esc = press('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(widget.opened).toBe(false);
    expect(document.activeElement).toBe(potato);
  });

  it('opens from any [data-poe-open], marks them all expanded, and toggles closed', () => {
    mount();
    const hi = $<HTMLButtonElement>('#say-hi');
    hi.click();
    expect(widget.opened).toBe(true);
    for (const opener of Array.from(document.querySelectorAll('[data-poe-open]'))) expect(opener.getAttribute('aria-expanded')).toBe('true');
    hi.click();
    expect(widget.opened).toBe(false);
    for (const opener of Array.from(document.querySelectorAll('[data-poe-open]'))) expect(opener.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the window "poe:open" event', () => {
    mount();
    window.dispatchEvent(new CustomEvent('poe:open'));
    expect(widget.opened).toBe(true);
  });

  it('opens on "/" outside inputs and returns focus to where you were', () => {
    mount();
    const hi = $<HTMLButtonElement>('#say-hi');
    hi.focus();
    const ev = press('/');
    expect(ev.defaultPrevented).toBe(true);
    expect(widget.opened).toBe(true);
    expect(document.activeElement).toBe($('#poe-input'));
    press('Escape');
    expect(document.activeElement).toBe(hi);
  });

  it('opens on "/" with nothing focused and closes back to the page', () => {
    mount();
    (document.activeElement as HTMLElement | null)?.blur();
    press('/', {}, document.body);
    expect(widget.opened).toBe(true);
    press('Escape');
    expect(widget.opened).toBe(false);
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  it('ignores "/" while typing in a page input and with modifiers', () => {
    mount();
    const input = $<HTMLInputElement>('#page-input');
    input.focus();
    const ev = press('/');
    expect(ev.defaultPrevented).toBe(false);
    expect(widget.opened).toBe(false);
    input.blur();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      press('/', mod, document.body);
      expect(widget.opened).toBe(false);
    }
  });

  it('"/" inside the open panel moves focus to the input instead of reopening', () => {
    mount();
    widget.open({ via: 'keyboard' });
    $<HTMLButtonElement>('.poe-close').focus();
    const ev = press('/');
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('#poe-input'));
  });

  it('the close button closes and returns focus to the opener', () => {
    mount();
    const hi = $<HTMLButtonElement>('#say-hi');
    hi.focus();
    hi.click();
    $<HTMLButtonElement>('.poe-close').click();
    expect(widget.opened).toBe(false);
    expect(document.activeElement).toBe(hi);
  });

  it('on phones: modal sheet with scrim, inert page, scroll lock and a Tab trap', async () => {
    stubMatchMedia(true);
    mount();
    const hi = $<HTMLButtonElement>('#say-hi');
    hi.focus();
    hi.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); // a tap
    const panel = $('#poe-panel');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect($('.poe-scrim').hidden).toBe(false);
    expect($('main').hasAttribute('inert')).toBe(true);
    expect($('header').hasAttribute('inert')).toBe(true);
    expect($('#poe-root').hasAttribute('inert')).toBe(false);
    expect(document.documentElement.classList.contains('poe-locked')).toBe(true);
    // tap-opened on a phone: focus goes to the dialog, not the input (no keyboard pop-up)
    expect(document.activeElement).toBe(panel);

    const focusables = Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.closest('[hidden]'));
    const last = focusables[focusables.length - 1]!;
    last.focus();
    const tab = press('Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);

    $<HTMLElement>('.poe-scrim').click();
    expect(widget.opened).toBe(false);
    await new Promise((r) => setTimeout(r, 260));
    expect(panel.hidden).toBe(true);
    expect($('.poe-scrim').hidden).toBe(true);
    expect($('main').hasAttribute('inert')).toBe(false);
    expect(document.documentElement.classList.contains('poe-locked')).toBe(false);
    expect(document.activeElement).toBe(hi);

    // a keyboard "/" on a phone (hardware keyboard) puts the cursor in the input
    hi.focus();
    press('/');
    expect(document.activeElement).toBe($('#poe-input'));
  });

  it('keeps the phone sheet above the on-screen keyboard (visualViewport)', () => {
    stubMatchMedia(true);
    const vv = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    try {
      mount();
      widget.open({ via: 'keyboard' });
      const panel = $('#poe-panel');
      expect(panel.style.getPropertyValue('--poe-kb')).toBe('');
      vv.height = window.innerHeight - 300;
      vv.dispatchEvent(new Event('resize'));
      expect(panel.style.getPropertyValue('--poe-kb')).toBe('300px');
      vv.height = window.innerHeight;
      vv.dispatchEvent(new Event('resize'));
      expect(panel.style.getPropertyValue('--poe-kb')).toBe('');
      vv.height = window.innerHeight - 200;
      vv.dispatchEvent(new Event('resize'));
      widget.close();
      expect(panel.style.getPropertyValue('--poe-kb')).toBe('');
    } finally {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  it('closes the phone nav sheet before opening', () => {
    mount();
    const toggle = document.createElement('button');
    toggle.setAttribute('data-nav-toggle', '');
    toggle.setAttribute('aria-expanded', 'true');
    const clicked = vi.fn(() => toggle.setAttribute('aria-expanded', 'false'));
    toggle.addEventListener('click', clicked);
    $('header').appendChild(toggle);
    widget.open({ via: 'keyboard' });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

describe('a turn', () => {
  it('streams plain text, then renders the final answer safely with its links', async () => {
    const stream = controlledStream();
    const { fn, calls } = fakeFetch(() => stream.response);
    mount(fn);
    widget.open({ via: 'keyboard' });
    const input = $<HTMLInputElement>('#poe-input');
    input.value = '  what is at://did:plc:abc ?  ';
    const sending = widget.send(input.value, { fromInput: true });
    await flush();

    expect(calls[0]!.body).toEqual({ message: 'what is at://did:plc:abc ?', path: '/' });
    expect(input.value).toBe('');
    expect($('.poe-msg--you .poe-msg__text').textContent).toBe('what is at://did:plc:abc ?');
    expect($('.poe-send').getAttribute('aria-disabled')).toBe('true');
    expect($('.poe-chips').hidden).toBe(true);
    expect($('.poe-status').hidden).toBe(false);
    expect($('.poe-status__text').textContent).toBe('digging…');
    expect($('.poe-panel__potato').getAttribute('src')).toBe(faceUrl('digging'));

    stream.push(sse([['ready', { conversation: 'new' }], ['status', { state: 'digging', label: 'resolving a handle' }]]));
    await flush();
    await flush();
    expect($('.poe-status__text').textContent).toBe('resolving a handle…');

    stream.push(sse([['delta', { text: 'see <b>https://aturi.to/x', block: 0 }]]));
    await flush();
    await flush();
    const streaming = $('.poe-msg.is-streaming .poe-msg__body');
    expect(streaming.textContent).toBe('see <b>https://aturi.to/x');
    expect(streaming.querySelector('a, b')).toBeNull();
    expect($('.poe-status').hidden).toBe(true);

    // a second submit while busy is ignored
    expect(await widget.send('another')).toBe(false);

    stream.push(sse([['done', { text: 'see <b> https://aturi.to/x and https://evil.example (◕‿◕)', links: ['https://aturi.to/x'] }]]));
    stream.end();
    await sending;

    const bubble = $('.poe-msg--poe:not(.poe-msg--greeting)');
    expect(bubble.classList.contains('is-streaming')).toBe(false);
    const links = Array.from(bubble.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://aturi.to/x']);
    expect(bubble.querySelector('b')).toBeNull();
    expect(bubble.querySelector('.poe-url')!.textContent).toBe('https://evil.example');
    expect(bubble.querySelector('[aria-hidden="true"].poe-face')!.textContent).toBe('(◕‿◕)');
    expect($('.poe-send').hasAttribute('aria-disabled')).toBe(false);
    expect($('.poe-panel__potato').getAttribute('src')).toBe(faceUrl('found'));
    expect($<HTMLInputElement>('#poe-input').placeholder).toBe('ask a follow-up');

    await new Promise((r) => setTimeout(r, 80));
    expect($('[aria-live="polite"]').textContent).toBe('poe says: see <b> https://aturi.to/x and https://evil.example');

    const stored = JSON.parse(window.sessionStorage.getItem('poe:transcript')!);
    expect(stored).toEqual([
      { role: 'you', text: 'what is at://did:plc:abc ?' },
      { role: 'poe', text: 'see <b> https://aturi.to/x and https://evil.example (◕‿◕)', links: ['https://aturi.to/x'] },
    ]);
  });

  it('uses the last non-empty block as the answer when done has no text', async () => {
    const { fn } = fakeFetch(() =>
      okStream([
        ['delta', { text: 'looking it up', block: 0 }],
        ['block', { text: 'looking it up', block: 0 }],
        ['block', { text: null, block: 1 }],
        ['delta', { text: 'the answer', block: 2 }],
        ['done', { text: '', links: [] }],
      ]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('q');
    const answers = document.querySelectorAll('.poe-msg--poe:not(.poe-msg--greeting)');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.textContent).toContain('the answer');
  });

  it('shows the not_configured message with a link to poe on bluesky, and the dead face', async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'not_configured', message: 'x' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('hi');
    const note = $('.poe-msg--note');
    expect(note.dataset.code).toBe('not_configured');
    // also what the kill switch answers, so it must not say "not set up yet"
    expect(note.textContent).toContain("poe isn't answering on the website right now. you can ask @poe.atpota.to on bluesky in the meantime.");
    const a = note.querySelector('a')!;
    expect(a.textContent).toBe('@poe.atpota.to');
    expect(a.getAttribute('href')).toBe('https://bsky.app/profile/poe.atpota.to');
    expect($('.poe-panel__potato').getAttribute('src')).toBe(faceUrl('offline'));
    expect($('.poe-send').hasAttribute('aria-disabled')).toBe(false);
  });

  it('shows a slow-down message for rate_limited and the scawy face for other errors', async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '300' } }));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('hi');
    expect($('.poe-msg--note').textContent).toContain('try again in about 5 minutes');
    expect($('.poe-panel__potato').getAttribute('src')).toBe(faceUrl('error'));
  });

  it('a daily cap says hours, not "a short break in about 1440 minutes", and links poe on bluesky', async () => {
    const { fn } = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '72000' } }));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('hi');
    const note = $('.poe-msg--note');
    expect(note.textContent).toContain("that's all the questions i can take from you for now. try again in about 20 hours, or ask @poe.atpota.to on bluesky.");
    expect(note.textContent).not.toMatch(/in a row|short break|minutes/);
    expect(note.querySelector('a')!.getAttribute('href')).toBe(POE_BLUESKY_URL);
  });

  it('offers "start a new chat" on conversation_over, which resets the chat', async () => {
    const { fn, calls } = fakeFetch((call) => (call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : okStream([['error', { code: 'conversation_over', message: 'x' }]])));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('hi');
    const btn = $<HTMLButtonElement>('.poe-msg--note button[data-action="new-chat"]');
    expect(btn.textContent).toBe('start a new chat');
    btn.click();
    await flush();
    expect(calls.some((c) => c.init.method === 'DELETE')).toBe(true);
    expect(document.querySelectorAll('.poe-msg:not(.poe-msg--greeting)')).toHaveLength(0);
    expect(window.sessionStorage.getItem('poe:transcript')).toBeNull();
  });

  it('never saves retried-step deltas as the answer when the turn then fails', async () => {
    // eve re-runs a failed step with the same block index; its deltas start over.
    const { fn } = fakeFetch(() =>
      okStream([
        ['delta', { text: 'a starter pack is ', block: 0 }],
        ['delta', { text: 'a starter pack is a list', block: 0 }],
        ['error', { code: 'upstream', message: 'x' }],
      ]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('q');
    expect(stored()).toEqual([{ role: 'you', text: 'q' }, { role: 'note', code: 'upstream' }]);
    // what streamed stays on screen for this page only
    expect($('.poe-msg--partial')).not.toBeNull();
    unmountPoe();
    mount(fn);
    widget.open({ via: 'keyboard' });
    expect($('.poe-msg--partial')).toBeNull();
    expect(bubbles().map((b) => b.className)).toEqual(['poe-msg poe-msg--you', 'poe-msg poe-msg--poe poe-msg--note']);
  });

  it('keeps block-confirmed text as the answer when the turn fails', async () => {
    const { fn } = fakeFetch(() =>
      okStream([
        ['delta', { text: 'let me check', block: 0 }],
        ['block', { text: 'let me check', block: 0 }],
        ['error', { code: 'upstream', message: 'x' }],
      ]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('q');
    expect(stored()).toEqual([
      { role: 'you', text: 'q' },
      { role: 'poe', text: 'let me check', links: [] },
      { role: 'note', code: 'upstream' },
    ]);
    expect($('.poe-msg--partial')).toBeNull();
  });

  it('a delta after a block event starts the block over instead of appending to it', async () => {
    const { fn } = fakeFetch(() =>
      okStream([
        ['delta', { text: 'hello world', block: 0 }],
        ['block', { text: 'hello world', block: 0 }],
        ['delta', { text: 'hello', block: 0 }], // the step ran again
        ['delta', { text: ' world!', block: 0 }],
        ['done', { text: '', links: [] }],
      ]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('q');
    expect(stored()[1]).toEqual({ role: 'poe', text: 'hello world!', links: [] });
    expect($('.poe-msg--poe:not(.poe-msg--greeting) .poe-msg__body').textContent).toBe('hello world!');
  });

  it('keeps partial text when the stream is cut off, and adds a note', async () => {
    const { fn } = fakeFetch(() => okStream([['delta', { text: 'half an answer https://aturi.to', block: 0 }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('q');
    const bubble = $('.poe-msg--poe:not(.poe-msg--greeting):not(.poe-msg--note)');
    expect(bubble.textContent).toContain('half an answer');
    expect(bubble.querySelector('a')).toBeNull(); // no links without done
    expect($('.poe-msg--note').dataset.code).toBe('cut_off');
  });

  it('a question right after "new chat" waits for the DELETE, so it never carries the old conversation', async () => {
    let releaseDelete!: () => void;
    const { fn, calls } = fakeFetch((call) =>
      call.init.method === 'DELETE'
        ? new Promise<Response>((resolve) => {
            releaseDelete = () => resolve(new Response(null, { status: 204 }));
          })
        : okStream([['done', { text: 'ok', links: [] }]]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    const resetting = widget.newChat();
    await flush();
    $<HTMLButtonElement>('.poe-chip').click(); // a quick tap on a suggestion
    await flush();
    await flush();
    expect(calls.map((c) => c.init.method)).toEqual(['DELETE']);
    expect($('.poe-msg--you .poe-msg__text').textContent).toBe("what's a labeler?"); // shown at once
    expect(widget.isBusy).toBe(true);
    releaseDelete();
    await resetting;
    await until(() => !widget.isBusy);
    expect(calls.map((c) => c.init.method)).toEqual(['DELETE', 'POST']);
  });

  it('the new chat button sends DELETE, clears the transcript and is disabled while busy', async () => {
    const stream = controlledStream();
    const { fn, calls } = fakeFetch((call) => (call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : stream.response));
    mount(fn);
    widget.open({ via: 'keyboard' });
    const sending = widget.send('q');
    await flush();
    $<HTMLButtonElement>('.poe-actions .poe-textbtn').click();
    await flush();
    expect(calls.filter((c) => c.init.method === 'DELETE')).toHaveLength(0);
    stream.push(sse([['done', { text: 'a', links: [] }]]));
    stream.end();
    await sending;
    $<HTMLButtonElement>('.poe-actions .poe-textbtn').click();
    await flush();
    expect(calls.filter((c) => c.init.method === 'DELETE')).toHaveLength(1);
    expect(document.querySelectorAll('.poe-msg:not(.poe-msg--greeting)')).toHaveLength(0);
  });

  it('aborts only on page unload and remembers the interruption', async () => {
    const stream = controlledStream();
    const { fn } = fakeFetch((call) => {
      call.init.signal?.addEventListener('abort', () => stream.end());
      return stream.response;
    });
    mount(fn);
    widget.open({ via: 'keyboard' });
    const sending = widget.send('q');
    await flush();
    widget.close();
    await flush();
    expect(widget.isBusy).toBe(true); // closing the panel does not abort
    window.dispatchEvent(new Event('pagehide'));
    await sending;
    const stored = JSON.parse(window.sessionStorage.getItem('poe:transcript')!);
    expect(stored).toEqual([{ role: 'you', text: 'q' }, { role: 'note', code: 'interrupted' }]);
  });

  it('says so when the server started a fresh conversation under an old transcript (ready: new)', async () => {
    window.sessionStorage.setItem(
      'poe:transcript',
      JSON.stringify([
        { role: 'you', text: 'name two labelers' },
        { role: 'poe', text: 'one and two', links: [] },
      ]),
    );
    const { fn } = fakeFetch(() =>
      okStream([
        ['ready', { conversation: 'new' }],
        ['delta', { text: 'the second', block: 0 }],
        ['done', { text: 'the second one?', links: [] }],
      ]),
    );
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('and the second one?');
    const kinds = () => bubbles().map((b) => (b.classList.contains('poe-msg--you') ? 'you' : (b.dataset.code ?? 'poe')));
    expect(kinds()).toEqual(['you', 'poe', 'you', 'fresh_start', 'poe']);
    expect($('[data-code="fresh_start"]').textContent).toContain("i lost track of our earlier chat, so we're starting fresh.");
    expect(stored()[3]).toEqual({ role: 'note', code: 'fresh_start' });

    // once is enough (cookies blocked: every turn is "new")
    await widget.send('again?');
    expect(kinds().filter((k) => k === 'fresh_start')).toHaveLength(1);

    // survives a page change
    unmountPoe();
    mount(fn);
    widget.open({ via: 'keyboard' });
    expect($('[data-code="fresh_start"]')).not.toBeNull();
  });

  it('no fresh-start note on the first question, or when the conversation continued', async () => {
    const { fn } = fakeFetch(() => okStream([['ready', { conversation: 'new' }], ['done', { text: 'hi', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('hello');
    unmountPoe();
    const cont = fakeFetch(() => okStream([['ready', { conversation: 'continued' }], ['done', { text: 'more', links: [] }]]));
    mount(cont.fn);
    widget.open({ via: 'keyboard' });
    await widget.send('more');
    expect(document.querySelector('[data-code="fresh_start"]')).toBeNull();
  });

  it('catches up with storage after a back/forward cache restore, instead of overwriting the newer chat', async () => {
    const { fn } = fakeFetch(() => okStream([['done', { text: 'answer', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    await widget.send('first question');
    // the reader went to the guide, asked there, and pressed back
    const later = [
      { role: 'you', text: 'first question' },
      { role: 'poe', text: 'answer', links: [] },
      { role: 'you', text: 'second question on guide' },
      { role: 'poe', text: 'guide answer', links: [] },
    ];
    window.sessionStorage.setItem('poe:transcript', JSON.stringify(later));
    window.dispatchEvent(pageshow(false)); // a normal load: nothing to do
    expect(bubbles()).toHaveLength(2);
    window.dispatchEvent(pageshow(true));
    expect(bubbles()).toHaveLength(4);
    expect(bubbles()[3]!.textContent).toContain('guide answer');

    await widget.send('third question');
    expect(stored().map((e) => e.text)).toEqual(['first question', 'answer', 'second question on guide', 'guide answer', 'third question', 'answer']);
  });

  it('a turn interrupted by leaving the page does not overwrite the next page\'s chat when the page comes back', async () => {
    const stream = controlledStream();
    const { fn } = fakeFetch((call) => {
      if (call.init.method === 'POST') call.init.signal?.addEventListener('abort', () => stream.end());
      return stream.response;
    });
    mount(fn);
    widget.open({ via: 'keyboard' });
    const sending = widget.send('q on home');
    await flush();
    stream.push(sse([['delta', { text: 'half an', block: 0 }]]));
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()).toEqual([{ role: 'you', text: 'q on home' }, { role: 'note', code: 'interrupted' }]);
    const guide = [...stored(), { role: 'you', text: 'on the guide' }, { role: 'poe', text: 'guide answer', links: [] }];
    window.sessionStorage.setItem('poe:transcript', JSON.stringify(guide));
    window.dispatchEvent(pageshow(true)); // restored before the aborted turn settled
    await sending;
    expect(stored()).toEqual(guide);
    expect(bubbles().map((b) => b.textContent)).toEqual([
      expect.stringContaining('q on home'),
      expect.stringContaining('i lost that answer'),
      expect.stringContaining('on the guide'),
      expect.stringContaining('guide answer'),
    ]); // and no leftover half-streamed bubble
  });

  it('restores the transcript from sessionStorage on the next page', async () => {
    window.sessionStorage.setItem(
      'poe:transcript',
      JSON.stringify([
        { role: 'you', text: 'what is this?', quote: 'labelers' },
        { role: 'poe', text: 'a labeler https://aturi.to', links: ['https://aturi.to'] },
        { role: 'note', code: 'interrupted' },
        { role: 'poe', text: '<img src=x onerror=alert(1)>', links: [] },
      ]),
    );
    mount();
    widget.open({ via: 'keyboard' });
    const you = $('.poe-msg--you');
    expect(you.querySelector('.poe-msg__quote')!.textContent).toBe('"labelers"');
    expect(you.querySelector('.poe-msg__text')!.textContent).toBe('what is this?');
    expect($('.poe-msg--poe:not(.poe-msg--greeting) a')!.getAttribute('href')).toBe('https://aturi.to');
    expect($('.poe-msg--note').textContent).toContain('i lost that answer when the page changed');
    expect(document.querySelector('#poe-root img[src="x"]')).toBeNull();
    expect($<HTMLInputElement>('#poe-input').placeholder).toBe('ask a follow-up');
  });

  it('keeps at most 20 bubbles', async () => {
    const { fn } = fakeFetch(() => okStream([['done', { text: 'ok', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    for (let i = 0; i < 12; i++) await widget.send(`q${i}`);
    expect(document.querySelectorAll('.poe-msg:not(.poe-msg--greeting)')).toHaveLength(20);
    const stored = JSON.parse(window.sessionStorage.getItem('poe:transcript')!);
    expect(stored).toHaveLength(20);
    expect(stored[0]).toEqual({ role: 'you', text: 'q2' });
  });

  it('using a chip keeps focus in the panel (input on desktop, log on phones) instead of dropping it to <body>', async () => {
    const { fn } = fakeFetch(() => okStream([['done', { text: 'ok', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    let chip = $<HTMLButtonElement>('.poe-chip');
    chip.focus();
    chip.click();
    expect(chip.isConnected).toBe(false); // re-rendered while busy
    expect(document.activeElement).toBe($('#poe-input'));
    await until(() => !widget.isBusy);
    expect(document.activeElement).toBe($('#poe-input'));

    unmountPoe();
    window.sessionStorage.clear();
    stubMatchMedia(true);
    mount(fn);
    widget.open({ via: 'pointer' });
    chip = $<HTMLButtonElement>('.poe-chip');
    chip.focus();
    chip.click();
    expect(document.activeElement).toBe($('.poe-log')); // no on-screen keyboard pop-up
    await until(() => !widget.isBusy);
    expect($('#poe-panel').contains(document.activeElement)).toBe(true);
  });

  it('a chip sends its text and then disappears from the suggestions', async () => {
    const { fn, calls } = fakeFetch(() => okStream([['done', { text: 'ok', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    $<HTMLButtonElement>('.poe-chip').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]!.body!.message).toBe("what's a labeler?");
    expect(Array.from(document.querySelectorAll('.poe-chips .poe-chip')).map((c) => c.textContent)).toEqual(['can my domain be my handle?', 'what is an at:// link?']);
  });

  it('"summarize this section" sends the current section as the selection', async () => {
    setPage('guide');
    const { fn, calls } = fakeFetch(() => okStream([['done', { text: 'ok', links: [] }]]));
    mount(fn);
    widget.open({ via: 'keyboard' });
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>('.poe-chip')).find((c) => c.textContent === 'summarize this section')!;
    chip.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]!.body).toEqual({ message: 'summarize this section', path: '/', selection: '3. Labelers a special tool called labelers here' });
    expect($('.poe-msg--you .poe-msg__quote').textContent).toBe('"3. Labelers"');
  });
});

describe('note copy', () => {
  it('waitPhrase reads naturally', () => {
    expect(waitPhrase(20)).toBe('about a minute');
    expect(waitPhrase(300)).toBe('about 5 minutes');
    expect(waitPhrase(3500)).toBe('about 59 minutes');
    expect(waitPhrase(3600)).toBe('about an hour');
    expect(waitPhrase(5400)).toBe('about 2 hours');
    expect(waitPhrase(86_400)).toBe('about 24 hours');
  });

  it('rate_limited: a short break for the burst rule, hours and a link for a daily cap', () => {
    expect(noteCopy('rate_limited', 300).text).toBe("that's a lot of questions in a row, so i need a short break. try again in about 5 minutes.");
    expect(noteCopy('rate_limited').text).toBe("that's a lot of questions in a row, so i need a short break. try again in a few minutes.");
    for (const [seconds, phrase] of [
      [3600, 'about an hour'],
      [18_000, 'about 5 hours'],
      [86_400, 'about 24 hours'],
    ] as const) {
      const copy = noteCopy('rate_limited', seconds);
      expect(copy.text).toContain(`try again in ${phrase}, or ask @poe.atpota.to on bluesky.`);
      expect(copy.text).not.toMatch(/in a row|short break|minutes|tomorrow/);
      expect(copy.linkHref).toBe(POE_BLUESKY_URL);
      expect(copy.text).toContain(copy.linkText!);
    }
  });

  it('has copy for every stored note code', () => {
    for (const code of NOTE_CODES) expect(noteCopy(code).text, code).toBeTruthy();
    expect(noteCopy('fresh_start').text).not.toBe(noteCopy('upstream').text);
    expect(noteCopy('not_configured').text).not.toMatch(/set up|yet/);
  });
});

describe('highlight-to-ask', () => {
  function selectWord() {
    const text = document.getElementById('para')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 22);
    range.setEnd(text, 30);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  it('shows the pill for an askable selection and asks "what does this mean?" with it', async () => {
    const { fn, calls } = fakeFetch(() => okStream([['done', { text: 'a labeler labels things', links: [] }]]));
    mount(fn);
    selectWord();
    await new Promise((r) => setTimeout(r, 250));
    const pill = $<HTMLButtonElement>('.poe-pill');
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe('ask poe about this');

    // keyboard reachable: Tab lands on the pill
    (document.activeElement as HTMLElement | null)?.blur();
    const tab = press('Tab', {}, document.body);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pill);

    pill.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(widget.opened).toBe(true);
    expect(calls[0]!.body).toEqual({ message: 'what does this mean?', path: '/', selection: 'labelers' });
    expect($('.poe-msg--you .poe-msg__quote').textContent).toBe('"labelers"');
    expect(pill.hidden).toBe(true);
  });

  it('hides the pill on scroll and when the selection goes away', async () => {
    mount();
    selectWord();
    await new Promise((r) => setTimeout(r, 250));
    expect($('.poe-pill').hidden).toBe(false);
    window.dispatchEvent(new Event('scroll'));
    expect($('.poe-pill').hidden).toBe(true);
    selectWord();
    await new Promise((r) => setTimeout(r, 250));
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 250));
    expect($('.poe-pill').hidden).toBe(true);
  });

  it('never shows for selections outside [data-poe-askable]', async () => {
    mount();
    const btn = document.getElementById('say-hi')!.firstChild!;
    const range = document.createRange();
    range.setStart(btn, 0);
    range.setEnd(btn, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => setTimeout(r, 250));
    expect($('.poe-pill').hidden).toBe(true);
  });
});

describe('nudge', () => {
  it('shows once per visit after the idle delay, with the wink face, and hides on tap', () => {
    vi.useFakeTimers();
    mount(undefined, { nudgeDelayMs: 4000 });
    const nudge = $('.poe-nudge');
    vi.advanceTimersByTime(3900);
    expect(nudge.hidden).toBe(true);
    vi.advanceTimersByTime(200);
    expect(nudge.hidden).toBe(false);
    expect(nudge.textContent).toContain('need a hand? ask me anything about atproto.');
    expect($('.poe-potato img').getAttribute('src')).toBe(faceUrl('nudge'));
    expect(window.sessionStorage.getItem('poe:nudged')).toBe('1');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(nudge.hidden).toBe(true);
    expect($('.poe-potato img').getAttribute('src')).toBe(faceUrl('resting'));

    unmountPoe();
    mount(undefined, { nudgeDelayMs: 4000 });
    vi.advanceTimersByTime(10_000);
    expect($('.poe-nudge').hidden).toBe(true);
  });

  it('keeps a trailing kaomoji in the nudge out of the screen reader', () => {
    vi.useFakeTimers();
    setPage('home', 'hi! ask me anything about atproto (◕‿◕)');
    mount(undefined, { nudgeDelayMs: 10 });
    vi.advanceTimersByTime(20);
    const text = $('.poe-nudge__text');
    expect(text.textContent).toBe('hi! ask me anything about atproto (◕‿◕)');
    const face = text.querySelector('.poe-face');
    expect(face?.getAttribute('aria-hidden')).toBe('true');
    expect(face?.textContent).toBe('(◕‿◕)');
  });

  it('activity resets the idle timer', () => {
    vi.useFakeTimers();
    mount(undefined, { nudgeDelayMs: 4000 });
    vi.advanceTimersByTime(3000);
    window.dispatchEvent(new Event('wheel'));
    vi.advanceTimersByTime(3000);
    expect($('.poe-nudge').hidden).toBe(true);
    vi.advanceTimersByTime(1100);
    expect($('.poe-nudge').hidden).toBe(false);
  });

  it('waits while another modal dialog is open', () => {
    vi.useFakeTimers();
    mount(undefined, { nudgeDelayMs: 10 });
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    // jsdom has no showModal, so stand in for a dialog opened with it.
    vi.spyOn(dialog, 'matches').mockImplementation((sel) => sel === ':modal');
    document.body.append(dialog);
    vi.advanceTimersByTime(50);
    expect($('.poe-nudge').hidden).toBe(true);
    dialog.remove();
    vi.advanceTimersByTime(20);
    expect($('.poe-nudge').hidden).toBe(false);
  });

  it('the dismiss button hides it and hands focus to the potato', () => {
    vi.useFakeTimers();
    mount(undefined, { nudgeDelayMs: 10 });
    vi.advanceTimersByTime(20);
    const close = $<HTMLButtonElement>('.poe-nudge__close');
    expect(close.getAttribute('aria-label')).toBe('dismiss tip');
    close.focus();
    close.click();
    expect($('.poe-nudge').hidden).toBe(true);
    expect(document.activeElement).toBe($('.poe-potato'));
  });

  it('never shows when the panel was opened, or while typing', () => {
    vi.useFakeTimers();
    mount(undefined, { nudgeDelayMs: 10 });
    widget.open({ via: 'keyboard' });
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(true);
    unmountPoe();

    mount(undefined, { nudgeDelayMs: 10 });
    $<HTMLInputElement>('#page-input').focus();
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(true);
    $<HTMLInputElement>('#page-input').blur();
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(false);
  });

  it('skips the homepage greeting on phones under 420px but keeps the guide tip', () => {
    vi.useFakeTimers();
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    mount(undefined, { nudgeDelayMs: 10 });
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(true);
    unmountPoe();
    window.sessionStorage.clear();
    resetStoresForTests();

    setPage('guide', 'stuck on a word? highlight it and ask me.');
    mount(undefined, { nudgeDelayMs: 10 });
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(false);
    expect($('.poe-nudge').textContent).toContain('stuck on a word?');
    width.mockRestore();
  });

  it('does nothing without data-poe-nudge', () => {
    vi.useFakeTimers();
    delete document.body.dataset.poeNudge;
    mount(undefined, { nudgeDelayMs: 10 });
    vi.advanceTimersByTime(100);
    expect($('.poe-nudge').hidden).toBe(true);
  });
});

describe('moods', () => {
  it('the corner potato is curious (kawaii) on hover and focus', () => {
    mount();
    const potato = $<HTMLButtonElement>('.poe-potato');
    const img = potato.querySelector('img')!;
    const enter = new Event('pointerenter');
    Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
    potato.dispatchEvent(enter);
    expect(img.getAttribute('src')).toBe(faceUrl('curious'));
    potato.dispatchEvent(new Event('pointerleave'));
    expect(img.getAttribute('src')).toBe(faceUrl('resting'));
    potato.focus();
    expect(img.getAttribute('src')).toBe(faceUrl('curious'));
    potato.blur();
    expect(img.getAttribute('src')).toBe(faceUrl('resting'));
  });
});

describe('source rules', () => {
  // jsdom gives import.meta.url a non-file scheme; vitest runs from the website root.
  const dir = join(process.cwd(), 'src/poe');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('never uses innerHTML, outerHTML, insertAdjacentHTML, document.write or eval in the widget', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|createContextualFragment|DOMParser/);
    }
  });
});
