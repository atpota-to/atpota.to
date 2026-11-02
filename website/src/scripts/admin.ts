/**
 * The admin page (admin/index.html): how Poe is doing, everything it remembers, the standing
 * guidance it follows, and the few things the people who run it can change from here.
 *
 * Signing in is the header's, like the settings page. Every call to /api/admin carries an
 * atproto service-auth token from the reader's own PDS, addressed to atpota.to for
 * to.atpota.poe.admin (server/admin.ts verifies it and checks the DID is an admin's or
 * Poe's). A token is reused until a minute before it lapses.
 *
 * Notes and guidance can hold anything anyone ever told Poe, so the DOM is built with
 * createElement and textContent only.
 */

import { SESSION_EVENT, sharedAuth, type Auth, type Session, type SessionEventDetail } from '../blog/auth';
import { el, isBusy, setBusy } from '../blog/signin';

export const POE_SERVICE_DID = 'did:web:atpota.to';
export const POE_ADMIN_LXM = 'to.atpota.poe.admin';
export const ADMIN_TOKEN_LIFETIME_S = 300;
const SIGNIN_EVENT = 'account:signin';
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const ARENAS = ['bluesky', 'website', 'weather', 'dispatch', 'operator-dm'] as const;
const KINDS = ['rule', 'style', 'lesson'] as const;

export const ADMIN_COPY = {
  checking: 'checking who you are…',
  unavailable: "the admin page needs a bluesky sign-in, which only works on atpota.to itself.",
  signedOut: "sign in with the account you run poe with.",
  refused: 'this page is only for the people who run poe.',
  needsSignIn: 'sign in again: your sign-in is from before the admin page asked for its own permission.',
  notConfigured: "the admin page isn't set up on this deployment yet.",
  failed: "couldn't reach poe just now. try again in a moment.",
  ready: (who: string) => `signed in as ${who}.`,
} as const;

export interface Note { index: number; text: string }
export interface ArchiveMonth { month: string; notes: string[]; summary: string | null }
export interface SlotView { slot: string; scope: string; about: string; notes: Note[]; characters: number; archive?: ArchiveMonth[] }
export interface GuidanceItem {
  id: number; kind: string; text: string; arenas: string[]; authorDid: string | null;
  addedAt: string; updatedAt: string; removedAt: string | null; published: boolean | null;
}
export interface Person { did: string; notes: number; heldBack: number; updatedAt: string; published: boolean; publishNote: string | null }
export interface Version { id: number; slot: string; scope: string; content: string; source: string; at: string }
type Failed = { error: string };
export interface Overview {
  me: { did: string; handle: string | null };
  admins: string[];
  state: Record<string, any> | Failed;
  guidance: { active: GuidanceItem[]; retired: GuidanceItem[] } | Failed;
  people: { people: Person[] } | Failed;
  memory: { slots: SlotView[] } | Failed;
}

export type ApiResult<T = any> = { ok: true; body: T } | { ok: false; status: number; message: string };

const failed = (part: unknown): part is Failed => !!part && typeof part === 'object' && 'error' in part;

/** /api/admin, with a fresh admin token on every call. */
export class AdminApi {
  private cached: { value: string; exp: number } | null = null;

  constructor(private session: Session, private fetchImpl: typeof fetch, private now: () => number = () => Date.now()) {}

  /** A token for the admin method, or why there isn't one. Never throws. */
  async token(): Promise<string | 'needs-sign-in' | null> {
    const nowS = Math.floor(this.now() / 1000);
    if (this.cached && this.cached.exp - 60 > nowS) return this.cached.value;
    const ask = (exp: number | null) => {
      const params = new URLSearchParams({ aud: POE_SERVICE_DID, lxm: POE_ADMIN_LXM });
      if (exp !== null) params.set('exp', String(exp));
      return this.session.fetch(`/xrpc/com.atproto.server.getServiceAuth?${params}`, { method: 'GET' });
    };
    try {
      let exp = nowS + ADMIN_TOKEN_LIFETIME_S;
      let res = await ask(exp);
      if (res.status === 400) {
        const code = ((await res.clone().json().catch(() => null)) as { error?: unknown } | null)?.error;
        // This device's clock is off: let the PDS pick, and assume its shortest lifetime.
        if (code === 'BadExpiration') {
          res = await ask(null);
          exp = nowS + 60;
        }
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) return 'needs-sign-in';
      if (!res.ok) return null;
      const value = ((await res.json().catch(() => null)) as { token?: unknown } | null)?.token;
      if (typeof value !== 'string' || value.length > 4096 || !TOKEN_RE.test(value)) return null;
      this.cached = { value, exp };
      return value;
    } catch {
      return null;
    }
  }

  private async call(path: string, init: RequestInit): Promise<ApiResult> {
    const token = await this.token();
    if (token === 'needs-sign-in') return { ok: false, status: 401, message: ADMIN_COPY.needsSignIn };
    if (!token) return { ok: false, status: 0, message: ADMIN_COPY.failed };
    let res: Response;
    try {
      res = await this.fetchImpl(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
        credentials: 'same-origin',
      });
    } catch {
      return { ok: false, status: 0, message: ADMIN_COPY.failed };
    }
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, body };
    if (res.status === 401) this.cached = null;
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return { ok: false, status: res.status, message: typeof message === 'string' && message.length <= 300 ? message : ADMIN_COPY.failed };
  }

  get(params: Record<string, string>): Promise<ApiResult> {
    return this.call(`/api/admin?${new URLSearchParams(params)}`, { method: 'GET' });
  }

  post(body: Record<string, unknown>): Promise<ApiResult> {
    return this.call('/api/admin', { method: 'POST', body: JSON.stringify(body) });
  }
}

const SLOT_LABELS: Record<string, string> = {
  life: "poe's life journal",
  'operator-dm-life': "poe's DM journal",
  self: 'what poe knows about itself',
  'operator-notes': 'notes about',
  person: 'notes about',
};

const ARENA_LABELS: Record<string, string> = {
  bluesky: 'bluesky replies', website: 'website chat', weather: 'weather posts', dispatch: 'the dispatch', 'operator-dm': 'DMs',
};

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' utc' : '');
const notesIn = (content: string) => content.split('\n').filter((l) => /^\d+: /.test(l)).length;

export interface AdminOptions {
  doc?: Document;
  win?: Window;
  auth?: Auth | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Asks before anything that removes or overwrites. Defaults to window.confirm. */
  confirm?: (question: string) => boolean;
}

export async function init(opts: AdminOptions = {}): Promise<void> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const root = doc.querySelector<HTMLElement>('[data-admin-page]');
  if (!root || root.dataset.adminReady === 'true') return;
  root.dataset.adminReady = 'true';
  const auth = opts.auth === undefined ? sharedAuth(win) : opts.auth;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => win.fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const ask = opts.confirm ?? ((q: string) => win.confirm(q));

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const lede = q<HTMLElement>('[data-admin-lede]');
  const signin = q<HTMLButtonElement>('[data-admin-signin]');
  const body = q<HTMLElement>('[data-admin-body]');
  const stateBody = q<HTMLElement>('[data-admin-state-body]');
  const pageStatus = q<HTMLElement>('[data-admin-status]');
  const panels = Object.fromEntries(['memory', 'guidance', 'people', 'replies', 'digest']
    .map((name) => [name, q<HTMLElement>(`[data-panel="${name}"]`)])) as Record<string, HTMLElement>;

  let api: AdminApi | null = null;
  let overview: Overview | null = null;

  signin.addEventListener('click', () => win.dispatchEvent(new Event(SIGNIN_EVENT)));

  function setState(state: 'checking' | 'unavailable' | 'signed-out' | 'refused' | 'ready', text: string): void {
    root!.dataset.state = state;
    lede.textContent = text;
    signin.hidden = state !== 'signed-out' && !(state === 'refused' && text === ADMIN_COPY.needsSignIn);
    body.hidden = state !== 'ready';
  }

  const say = (text: string) => { pageStatus.textContent = text; };

  /** Run a change, then show the answer and reload everything. */
  async function change(button: HTMLButtonElement | null, call: Record<string, unknown>, done: string): Promise<boolean> {
    if (!api || (button && isBusy(button))) return false;
    if (button) setBusy(button, true);
    const result = await api.post(call);
    if (button) setBusy(button, false);
    if (!result.ok) {
      say(result.message);
      return false;
    }
    say(done);
    await load();
    return true;
  }

  // ---------- tabs ----------
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const other of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) other.setAttribute('aria-pressed', String(other === tab));
      for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== tab.dataset.tab;
    });
  }

  // ---------- nap ----------
  const napForm = q<HTMLFormElement>('[data-admin-nap]');
  const napStatus = q<HTMLElement>('[data-admin-nap-status]');
  napForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = napForm.querySelector<HTMLInputElement>('input')!;
    const button = napForm.querySelector<HTMLButtonElement>('button')!;
    if (!api || isBusy(button) || !input.value.trim()) return;
    setBusy(button, true);
    const result = await api.post({ target: 'nap', text: input.value.trim() });
    setBusy(button, false);
    napStatus.textContent = result.ok ? String((result.body as { message?: unknown }).message ?? 'done') : result.message;
    if (result.ok) {
      input.value = '';
      await load();
    }
  });

  // ---------- state ----------
  function renderState(state: Overview['state']): void {
    stateBody.replaceChildren();
    if (failed(state)) {
      stateBody.append(el(doc, 'p', { class: 'admin-muted' }, `the droplet didn't answer (${state.error}).`));
      return;
    }
    const posting = state.killSwitch ? `kill switch on (${state.killSwitch})`
      : state.nap?.active ? `napping until ${day(state.nap.until)}`
        : state.posting ? 'awake and posting' : `stage ${state.stage}, not posting`;
    const facts: [string, string][] = [
      ['poe is', posting],
      ['replies', `${state.activity?.replies24h ?? 0} today, ${state.activity?.replies7d ?? 0} this week`],
      ['mentions today', Object.entries(state.activity?.matched24h ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'],
      ['dms', state.dms ? 'on' : 'off'],
      ['dispatch', state.dispatch?.draft ? `draft "${state.dispatch.draft.title ?? 'untitled'}" is ${state.dispatch.draft.status}` : `drafts ${state.dispatch?.drafts ?? 'off'}`],
      ['weekly digest', state.memory?.digest?.enabled ? `on${state.memory.digest.last ? `, last ${state.memory.digest.last.status} ${day(state.memory.digest.last.updated_at)}` : ''}` : 'off'],
      ['people with notes', String(state.memory?.people ?? 0)],
    ];
    const list = el(doc, 'dl', { class: 'admin-facts' });
    for (const [k, v] of facts) list.append(el(doc, 'dt', {}, k), el(doc, 'dd', {}, v));
    stateBody.append(list);
    if (state.dispatch?.draft?.preview) {
      stateBody.append(el(doc, 'a', { class: 'admin-link', href: state.dispatch.draft.preview, rel: 'noreferrer' }, 'read the draft'));
    }
  }

  // ---------- memory ----------
  function slotTitle(view: SlotView): string {
    const label = SLOT_LABELS[view.slot] ?? view.slot;
    return view.slot === 'operator-notes' || view.slot === 'person' ? `${label} ${view.scope}` : label;
  }

  function where(view: SlotView): { slot: string; did?: string } {
    return view.slot === 'operator-notes' || view.slot === 'person' ? { slot: view.slot, did: view.scope } : { slot: view.slot };
  }

  function slotCard(view: SlotView): HTMLElement {
    const card = el(doc, 'article', { class: 'tile admin-slot', 'data-slot': view.slot, 'data-scope': view.scope });
    card.append(
      el(doc, 'h3', { class: 'admin-slot__title' }, slotTitle(view)),
      el(doc, 'p', { class: 'admin-muted' }, `${view.about ? `${view.about} · ` : ''}${count(view.notes.length, 'note')}, ${count(view.characters, 'character')}`),
    );
    const list = el(doc, 'ol', { class: 'admin-notes' });
    if (!view.notes.length) list.append(el(doc, 'li', { class: 'admin-muted' }, 'nothing here yet.'));
    for (const note of view.notes) list.append(noteItem(view, note));
    card.append(list);

    const add = el(doc, 'form', { class: 'admin-add' });
    const text = el(doc, 'textarea', { class: 'admin-input', rows: '2', maxlength: '2000', 'aria-label': `add a note to ${slotTitle(view)}` });
    const addButton = el(doc, 'button', { type: 'submit', class: 'btn btn--outline btn--sm' }, 'add a note');
    add.append(text, addButton);
    add.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!text.value.trim()) return;
      void change(addButton, { target: 'memory', call: { action: 'add', ...where(view), text: text.value } }, 'note added.');
    });
    card.append(add);

    if (view.archive?.length) card.append(archiveBlock(view));
    card.append(historyBlock(view));
    return card;
  }

  function noteItem(view: SlotView, note: Note): HTMLElement {
    const item = el(doc, 'li', { class: 'admin-note' });
    const show = () => {
      const edit = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'edit');
      const remove = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'remove');
      item.replaceChildren(
        el(doc, 'span', { class: 'admin-note__index' }, `#${note.index}`),
        el(doc, 'span', { class: 'admin-note__text' }, note.text),
        el(doc, 'span', { class: 'admin-note__actions' }),
      );
      item.lastElementChild!.append(edit, remove);
      edit.addEventListener('click', () => editing());
      remove.addEventListener('click', () => {
        if (!ask(`remove note #${note.index} from ${slotTitle(view)}?`)) return;
        void change(remove, { target: 'memory', call: { action: 'remove', ...where(view), index: note.index } }, 'note removed.');
      });
    };
    const editing = () => {
      const input = el(doc, 'textarea', { class: 'admin-input', rows: '3', maxlength: '2000', 'aria-label': `note #${note.index}` });
      input.value = note.text.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '');
      const save = el(doc, 'button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'save');
      const cancel = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'cancel');
      item.replaceChildren(el(doc, 'span', { class: 'admin-note__index' }, `#${note.index}`), input, save, cancel);
      cancel.addEventListener('click', show);
      save.addEventListener('click', () => {
        void change(save, { target: 'memory', call: { action: 'edit', ...where(view), index: note.index, text: input.value } }, 'note saved.');
      });
      input.focus();
    };
    show();
    return item;
  }

  function archiveBlock(view: SlotView): HTMLElement {
    const details = el(doc, 'details', { class: 'admin-archive' });
    const total = view.archive!.reduce((n, m) => n + m.notes.length, 0);
    details.append(el(doc, 'summary', {}, `the archive: ${count(total, 'older note')} in ${count(view.archive!.length, 'month')}`));
    for (const month of view.archive!) {
      const block = el(doc, 'section', { class: 'admin-month' });
      block.append(el(doc, 'h4', {}, month.month));
      if (month.summary) block.append(el(doc, 'p', { class: 'admin-summary' }, month.summary));
      const list = el(doc, 'ul', { class: 'admin-notes' });
      for (const text of month.notes) {
        const remove = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'remove');
        remove.addEventListener('click', () => {
          if (!ask('remove this archived note?')) return;
          void change(remove, { target: 'memory', call: { action: 'remove-archived', ...where(view), month: month.month, text } }, 'archived note removed.');
        });
        const li = el(doc, 'li', { class: 'admin-note admin-note--plain' });
        li.append(el(doc, 'span', { class: 'admin-note__text' }, text), remove);
        list.append(li);
      }
      block.append(list);
      details.append(block);
    }
    return details;
  }

  function historyBlock(view: SlotView): HTMLElement {
    const wrap = el(doc, 'div', { class: 'admin-history' });
    const open = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'history');
    const list = el(doc, 'ol', { class: 'admin-versions' });
    wrap.append(open, list);
    open.addEventListener('click', async () => {
      if (!api || isBusy(open)) return;
      setBusy(open, true);
      const result = await api.get({ view: 'history', slot: view.slot, scope: view.scope });
      setBusy(open, false);
      list.replaceChildren();
      if (!result.ok) return void list.append(el(doc, 'li', { class: 'admin-muted' }, result.message));
      const versions = (result.body as { versions?: Version[] }).versions ?? [];
      if (!versions.length) list.append(el(doc, 'li', { class: 'admin-muted' }, 'no history kept yet.'));
      versions.forEach((v, i) => {
        const li = el(doc, 'li', { class: 'admin-version' });
        li.append(el(doc, 'span', {}, `${day(v.at)} · ${v.source} · ${count(notesIn(v.content), 'note')}${i === 0 ? ' · current' : ''}`));
        const peek = el(doc, 'details', {});
        peek.append(el(doc, 'summary', {}, 'show'), el(doc, 'pre', { class: 'admin-pre' }, v.content));
        li.append(peek);
        if (i > 0) {
          const restore = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm' }, 'restore this version');
          restore.addEventListener('click', () => {
            if (!ask(`put ${slotTitle(view)} back to how it was on ${day(v.at)}? the current notes will be replaced (they stay in the history).`)) return;
            void change(restore, { target: 'restore', ...where(view), versionId: v.id }, 'restored.');
          });
          li.append(restore);
        }
        list.append(li);
      });
    });
    return wrap;
  }

  function renderMemory(memory: Overview['memory']): void {
    const panel = panels.memory;
    panel.replaceChildren();
    if (failed(memory)) return void panel.append(el(doc, 'p', { class: 'admin-muted' }, `poe's memory didn't answer (${memory.error}).`));
    for (const view of memory.slots) panel.append(slotCard(view));
  }

  // ---------- guidance ----------
  function arenaBoxes(name: string, checked: readonly string[]): HTMLElement {
    const box = el(doc, 'fieldset', { class: 'admin-arenas' });
    box.append(el(doc, 'legend', {}, 'where it applies'));
    for (const arena of ARENAS) {
      const label = el(doc, 'label', { class: 'admin-check' });
      const input = el(doc, 'input', { type: 'checkbox', name, value: arena });
      input.checked = checked.includes(arena);
      label.append(input, doc.createTextNode(` ${ARENA_LABELS[arena]}`));
      box.append(label);
    }
    return box;
  }

  const checkedIn = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);

  function guidanceItem(item: GuidanceItem, retired: boolean): HTMLElement {
    const li = el(doc, 'li', { class: 'tile admin-guidance' });
    const show = () => {
      li.replaceChildren(
        el(doc, 'p', { class: 'admin-guidance__meta' },
          `#${item.id} · ${item.kind}${item.kind === 'lesson' ? (item.published ? ' (public)' : ' (publishing)') : ''} · ${item.arenas.map((a) => ARENA_LABELS[a] ?? a).join(', ')} · ${day(retired ? item.removedAt : item.updatedAt)}`),
        el(doc, 'p', { class: 'admin-guidance__text' }, item.text),
      );
      const actions = el(doc, 'div', { class: 'admin-row' });
      if (retired) {
        const restore = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm' }, 'restore');
        restore.addEventListener('click', () => void change(restore, { target: 'guidance', action: 'restore', id: item.id }, 'guidance restored.'));
        actions.append(restore);
      } else {
        const edit = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'edit');
        const retire = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'retire');
        edit.addEventListener('click', editing);
        retire.addEventListener('click', () => {
          if (!ask(`retire guidance #${item.id}? poe stops following it (you can restore it).`)) return;
          void change(retire, { target: 'guidance', action: 'retire', id: item.id }, 'guidance retired.');
        });
        actions.append(edit, retire);
      }
      li.append(actions);
    };
    const editing = () => {
      const text = el(doc, 'textarea', { class: 'admin-input', rows: '2', maxlength: '600', 'aria-label': `guidance #${item.id}` });
      text.value = item.text;
      const boxes = arenaBoxes(`arenas-${item.id}`, item.arenas);
      const save = el(doc, 'button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'save');
      const cancel = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'cancel');
      li.replaceChildren(text, boxes, save, cancel);
      cancel.addEventListener('click', show);
      save.addEventListener('click', () => void change(save,
        { target: 'guidance', action: 'edit', id: item.id, text: text.value, arenas: checkedIn(boxes, `arenas-${item.id}`) }, 'guidance saved.'));
    };
    show();
    return li;
  }

  function renderGuidance(guidance: Overview['guidance']): void {
    const panel = panels.guidance;
    panel.replaceChildren();
    panel.append(el(doc, 'p', { class: 'admin-muted' },
      'standing guidance poe follows, wherever it applies. lessons are public records in poe\'s repo; style notes and rules stay private. you can also add some by DMing poe "style: …", "dispatch: …", "weather: …", "website: …" or "bluesky: …".'));
    const form = el(doc, 'form', { class: 'tile admin-add admin-add--guidance' });
    const text = el(doc, 'textarea', { class: 'admin-input', rows: '2', maxlength: '600', 'aria-label': 'new guidance' });
    const kind = el(doc, 'select', { class: 'admin-input', 'aria-label': 'kind' });
    for (const k of KINDS) kind.append(el(doc, 'option', { value: k }, k));
    const boxes = arenaBoxes('arenas-new', ['dispatch']);
    const add = el(doc, 'button', { type: 'submit', class: 'btn btn--primary btn--sm' }, 'add guidance');
    form.append(el(doc, 'h3', { class: 'admin-slot__title' }, 'add guidance'), text, kind, boxes, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!text.value.trim()) return;
      void change(add, { target: 'guidance', action: 'add', kind: kind.value, text: text.value, arenas: checkedIn(boxes, 'arenas-new') }, 'guidance added.');
    });
    panel.append(form);
    if (failed(guidance)) return void panel.append(el(doc, 'p', { class: 'admin-muted' }, `guidance didn't load (${guidance.error}).`));
    const active = el(doc, 'ul', { class: 'admin-list' });
    for (const item of [...guidance.active].reverse()) active.append(guidanceItem(item, false));
    if (!guidance.active.length) active.append(el(doc, 'li', { class: 'admin-muted' }, 'no guidance yet.'));
    panel.append(active);
    if (guidance.retired.length) {
      const old = el(doc, 'details', { class: 'admin-archive' });
      old.append(el(doc, 'summary', {}, `${guidance.retired.length} retired`));
      const list = el(doc, 'ul', { class: 'admin-list' });
      for (const item of guidance.retired) list.append(guidanceItem(item, true));
      old.append(list);
      panel.append(old);
    }
  }

  // ---------- people ----------
  function renderPeople(people: Overview['people']): void {
    const panel = panels.people;
    panel.replaceChildren();
    if (failed(people)) return void panel.append(el(doc, 'p', { class: 'admin-muted' }, `people didn't load (${people.error}).`));
    panel.append(el(doc, 'p', { class: 'admin-muted' }, `poe keeps notes about ${count(people.people.length, 'person').replace(/persons$/, 'people')}. their notes are public in poe's repo.`));
    const list = el(doc, 'ul', { class: 'admin-list' });
    for (const person of people.people) {
      const li = el(doc, 'li', { class: 'tile admin-person' });
      const open = el(doc, 'button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'open');
      const slot = el(doc, 'div', {});
      li.append(
        el(doc, 'a', { class: 'admin-link', href: `https://bsky.app/profile/${person.did}`, rel: 'noreferrer' }, person.did),
        el(doc, 'span', { class: 'admin-muted' }, ` · ${count(person.notes, 'note')}${person.heldBack ? `, ${person.heldBack} held back` : ''} · ${day(person.updatedAt)}${person.published ? '' : ' · not public yet'}`),
        open, slot,
      );
      open.addEventListener('click', async () => {
        if (!api || isBusy(open)) return;
        setBusy(open, true);
        const result = await api.get({ view: 'person', did: person.did });
        setBusy(open, false);
        slot.replaceChildren(result.ok ? slotCard(result.body as SlotView) : el(doc, 'p', { class: 'admin-muted' }, result.message));
      });
      list.append(li);
    }
    panel.append(list);
  }

  // ---------- replies and digest ----------
  function renderReplies(state: Overview['state']): void {
    const panel = panels.replies;
    panel.replaceChildren();
    if (failed(state)) return;
    const list = el(doc, 'ul', { class: 'admin-list' });
    for (const r of (state.recent ?? []) as Record<string, string | null>[]) {
      const li = el(doc, 'li', { class: 'tile admin-reply' });
      li.append(
        el(doc, 'p', { class: 'admin-muted' }, `${day(r.postedAt)} · ${r.author ? `@${r.author}` : 'someone'}`),
        el(doc, 'p', { class: 'admin-reply__asked' }, r.asked ?? ''),
        el(doc, 'p', { class: 'admin-reply__said' }, r.reply ?? ''),
      );
      if (r.replyUrl) li.append(el(doc, 'a', { class: 'admin-link', href: r.replyUrl, rel: 'noreferrer' }, 'on bluesky'));
      list.append(li);
    }
    if (!list.childElementCount) list.append(el(doc, 'li', { class: 'admin-muted' }, 'no replies yet.'));
    panel.append(list);
  }

  function renderDigest(): void {
    const panel = panels.digest;
    panel.replaceChildren();
    const preview = el(doc, 'button', { type: 'button', class: 'btn btn--outline btn--sm' }, "preview this week's digest");
    const out = el(doc, 'pre', { class: 'admin-pre' });
    panel.append(el(doc, 'p', { class: 'admin-muted' }, 'once a week poe DMs you what it remembered and forgot. this is what it would say now.'), preview, out);
    preview.addEventListener('click', async () => {
      if (!api || isBusy(preview)) return;
      setBusy(preview, true);
      const result = await api.get({ view: 'digest' });
      setBusy(preview, false);
      out.textContent = result.ok ? String((result.body as { text?: unknown }).text ?? 'nothing changed this week.') : result.message;
    });
  }

  async function load(): Promise<void> {
    if (!api) return;
    const result = await api.get({ view: 'overview' });
    if (!result.ok) {
      if (result.status === 401) return setState('refused', ADMIN_COPY.needsSignIn);
      if (result.status === 403) return setState('refused', ADMIN_COPY.refused);
      if (result.status === 503) return setState('unavailable', ADMIN_COPY.notConfigured);
      return setState('refused', result.message);
    }
    overview = result.body as Overview;
    const who = overview.me.handle ? `@${overview.me.handle}` : overview.me.did;
    setState('ready', ADMIN_COPY.ready(who));
    renderState(overview.state);
    renderMemory(overview.memory);
    renderGuidance(overview.guidance);
    renderPeople(overview.people);
    renderReplies(overview.state);
    if (!panels.digest.childElementCount) renderDigest();
  }

  win.addEventListener(SESSION_EVENT, (event) => {
    if ((event as CustomEvent<SessionEventDetail>).detail?.did) return;
    api = null;
    overview = null;
    setState('signed-out', ADMIN_COPY.signedOut);
  });

  if (!auth) return setState('unavailable', ADMIN_COPY.unavailable);
  if (!auth.eager) return setState('signed-out', ADMIN_COPY.signedOut);
  setState('checking', ADMIN_COPY.checking);
  const started = await auth.start().catch(() => null);
  if (!started?.session) return setState('signed-out', ADMIN_COPY.signedOut);
  api = new AdminApi(started.session, fetchImpl, now);
  await load();
}
