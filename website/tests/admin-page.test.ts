// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth, Session, StartResult } from '../src/blog/auth.js';
import { ADMIN_COPY, AdminApi, init, POE_ADMIN_LXM, type Overview } from '../src/scripts/admin.js';

const DID = 'did:plc:adminadminadminadminadmi';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const TOKEN = 'aaa.bbb.ccc';
// Relative to the website folder, where vitest runs.
const PAGE = readFileSync('admin/index.html', 'utf8');
const main = () => PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

function fakeSession(): Session & { asked: URL[] } {
  const asked: URL[] = [];
  return {
    did: DID, pds: 'https://pds.example', asked,
    fetch: vi.fn(async (path: string) => {
      asked.push(new URL(path, 'https://pds.example'));
      return Response.json({ token: TOKEN });
    }),
    signOut: vi.fn(async () => undefined),
  };
}

function auth(session: Session | null, eager = true): Auth {
  const result: StartResult = { session, callback: false, error: null };
  return { mode: 'site', eager, start: vi.fn(async () => result), warm: () => undefined, prepare: vi.fn(), go: vi.fn() };
}

const OVERVIEW: Overview = {
  me: { did: DID, handle: 'dame.is' },
  admins: [DID],
  state: { stage: 4, posting: true, killSwitch: false, nap: { active: false, until: null }, dms: true,
    activity: { replies24h: 3, replies7d: 20, matched24h: { posted: 3 } }, dispatch: { drafts: 'on', draft: null },
    memory: { people: 2, digest: { enabled: true, last: null } },
    recent: [{ postedAt: '2026-11-02T10:00:00Z', author: 'someone.example', asked: 'what is a pds?', reply: '<b>a home</b> for your data', replyUrl: 'https://bsky.app/profile/x/post/y' }] },
  guidance: { active: [{ id: 9, kind: 'rule', text: 'give the headliner its own heading', arenas: ['dispatch'], authorDid: DID,
    addedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', removedAt: null, published: null }], retired: [] },
  people: { people: [{ did: 'did:plc:cccccccccccccccccccccccc', notes: 2, heldBack: 0, updatedAt: '2026-11-01T00:00:00Z', published: true, publishNote: null }] },
  memory: { slots: [
    { slot: 'life', scope: 'poe-life', about: "Poe's journal", notes: [{ index: 4, text: '[2026-11-01] <img src=x onerror=alert(1)> saw a storm' }], characters: 40,
      archive: [{ month: '2026-09', notes: ['[2026-09-01] old note'], summary: 'a month of launches' }] },
    { slot: 'operator-notes', scope: DID, about: 'one operator', notes: [{ index: 0, text: 'likes short answers' }], characters: 19 },
  ] },
};

function site(answer: (url: string, init: RequestInit) => Response = () => Response.json(OVERVIEW)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return answer(String(input), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function mount(a: Auth | null, fetchImpl: typeof fetch = site().fetchImpl, confirm = () => true) {
  document.body.innerHTML = main();
  await init({ auth: a, fetchImpl, now: () => NOW, confirm });
  const root = document.querySelector<HTMLElement>('[data-admin-page]')!;
  return { root, $: <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!, $$: (s: string) => [...root.querySelectorAll<HTMLElement>(s)] };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('admin page', () => {
  it('says it only works on atpota.to where there is no sign-in, and asks a signed-out reader to sign in', async () => {
    expect((await mount(null)).root.dataset.state).toBe('unavailable');
    const { root, $ } = await mount(auth(null, false));
    expect(root.dataset.state).toBe('signed-out');
    expect($('[data-admin-signin]').hidden).toBe(false);
    expect($('[data-admin-body]').hidden).toBe(true);
  });

  it('asks the PDS for a short-lived token for the admin method, and reuses it', async () => {
    const session = fakeSession();
    const { fetchImpl, calls } = site();
    const api = new AdminApi(session, fetchImpl, () => NOW);
    await api.get({ view: 'overview' });
    await api.get({ view: 'digest' });
    expect(session.asked).toHaveLength(1);
    expect(session.asked[0]!.searchParams.get('lxm')).toBe(POE_ADMIN_LXM);
    expect(session.asked[0]!.searchParams.get('aud')).toBe('did:web:atpota.to');
    expect(Number(session.asked[0]!.searchParams.get('exp'))).toBe(NOW / 1000 + 300);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('tells a signed-in reader who is not an admin that the page is not for them', async () => {
    const { fetchImpl } = site(() => new Response(JSON.stringify({ error: { message: 'no' } }), { status: 403 }));
    const { root, $ } = await mount(auth(fakeSession()), fetchImpl);
    expect(root.dataset.state).toBe('refused');
    expect($('[data-admin-lede]').textContent).toBe(ADMIN_COPY.refused);
    expect($('[data-admin-body]').hidden).toBe(true);
  });

  it('shows the state, every memory, guidance, people and replies, as text only', async () => {
    const { root, $, $$ } = await mount(auth(fakeSession()));
    expect(root.dataset.state).toBe('ready');
    expect($('[data-admin-lede]').textContent).toBe(ADMIN_COPY.ready('@dame.is'));
    expect($('[data-admin-state-body]').textContent).toContain('awake and posting');
    const slots = $$('.admin-slot');
    expect(slots.map((s) => s.dataset.slot)).toEqual(['life', 'operator-notes']);
    expect(slots[0]!.textContent).toContain('<img src=x onerror=alert(1)> saw a storm');
    expect(root.querySelector('img')).toBeNull();
    expect(slots[0]!.textContent).toContain('a month of launches');
    expect($('[data-panel="guidance"]').textContent).toContain('give the headliner its own heading');
    expect($('[data-panel="people"]').textContent).toContain('did:plc:cccccccccccccccccccccccc');
    expect($('[data-panel="replies"]').textContent).toContain('<b>a home</b> for your data');
    expect(root.querySelector('b')).toBeNull();
  });

  it('switches sections with the tabs', async () => {
    const { $ } = await mount(auth(fakeSession()));
    $<HTMLButtonElement>('[data-tab="guidance"]').click();
    expect($('[data-panel="guidance"]').hidden).toBe(false);
    expect($('[data-panel="memory"]').hidden).toBe(true);
    expect($('[data-tab="guidance"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('removes a note only after asking, and edits one keeping its place', async () => {
    const { fetchImpl, calls } = site((url, init) => (init.method === 'POST' ? Response.json({}) : Response.json(OVERVIEW)));
    let answer = false;
    const { $$ } = await mount(auth(fakeSession()), fetchImpl, () => answer);
    const note = $$('.admin-slot')[1]!.querySelector<HTMLElement>('.admin-note')!;
    const remove = [...note.querySelectorAll('button')].find((b) => b.textContent === 'remove')!;
    remove.click();
    await flush();
    expect(calls.some((c) => c.init.method === 'POST')).toBe(false);
    answer = true;
    remove.click();
    await flush();
    const sent = calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(String(c.init.body)));
    expect(sent).toEqual([{ target: 'memory', call: { action: 'remove', slot: 'operator-notes', did: DID, index: 0 } }]);

    const fresh = document.querySelectorAll<HTMLElement>('.admin-slot')[0]!.querySelector<HTMLElement>('.admin-note')!;
    [...fresh.querySelectorAll('button')].find((b) => b.textContent === 'edit')!.click();
    const input = fresh.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(input.value).toBe('<img src=x onerror=alert(1)> saw a storm');
    input.value = 'saw a big storm';
    [...fresh.querySelectorAll('button')].find((b) => b.textContent === 'save')!.click();
    await flush();
    const edits = calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(String(c.init.body)));
    expect(edits.at(-1)).toEqual({ target: 'memory', call: { action: 'edit', slot: 'life', index: 4, text: 'saw a big storm' } });
  });

  it('adds guidance for the arenas ticked', async () => {
    const { fetchImpl, calls } = site((url, init) => (init.method === 'POST' ? Response.json({ id: 10 }) : Response.json(OVERVIEW)));
    const { $ } = await mount(auth(fakeSession()), fetchImpl);
    const form = $('[data-panel="guidance"]').querySelector<HTMLFormElement>('form')!;
    form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'check the code before framing an argument';
    form.querySelector<HTMLInputElement>('input[value="bluesky"]')!.checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const sent = calls.filter((c) => c.init.method === 'POST').map((c) => JSON.parse(String(c.init.body)));
    expect(sent).toEqual([{ target: 'guidance', action: 'add', kind: 'rule', text: 'check the code before framing an argument', arenas: ['bluesky', 'dispatch'] }]);
  });
});
