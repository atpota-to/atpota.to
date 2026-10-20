// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPE, type Auth, type Session } from '../src/blog/auth.js';
import { grants } from './lexicon-helpers.js';
import { readPending, resetBlogStoresForTests, sessionStoreFor } from '../src/blog/state.js';
import { ASK_AFTER, COUNT_COPY, initPet, PETS_KEY } from '../src/scripts/pet.js';
import { createPetSync, MAX_PETS, PET_SIGNIN_EVENT, PETS_NSID, PETS_RKEY, petsRecord, readSavedPets, SAVE_DELAY_MS, toSavedPets, troubleFrom } from '../src/scripts/pet-sync.js';

const DID = 'did:plc:reader';
const PDS = 'https://pds.test';
const CREATED = '2026-09-01T00:00:00.000Z';
const lexicon = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lexicons/to/atpota/poe/pets.json'), 'utf8'));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A PDS with the reader's record (or none); putRecord answers `putStatus`. */
function fakeSession(record: unknown, putStatus = 200) {
  const puts: Record<string, unknown>[] = [];
  const session: Session = {
    did: DID,
    pds: PDS,
    fetch: vi.fn(async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { collection: string; rkey: string; record: Record<string, unknown> };
      if (putStatus !== 200) return json(putStatus, { error: 'nope' });
      puts.push(body.record);
      return json(200, { uri: `at://${DID}/${body.collection}/${body.rkey}`, cid: 'bafycid' });
    }),
    signOut: async () => undefined,
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(`${PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=${PETS_NSID}&rkey=${PETS_RKEY}`);
    return record === undefined ? json(400, { error: 'RecordNotFound' }) : json(200, { uri: `at://${DID}/${PETS_NSID}/self`, value: record });
  }) as unknown as typeof fetch;
  return { session, fetchImpl, puts };
}

function fakeAuth(session: Session | null, eager = session !== null): Auth {
  return {
    mode: 'site',
    eager,
    start: vi.fn(async () => ({ session, callback: false, error: null })),
    warm: () => undefined,
    prepare: vi.fn(),
    go: vi.fn(),
  } as unknown as Auth;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetBlogStoresForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the pets record', () => {
  it('matches the lexicon, and the sign-in asks for it', () => {
    expect(lexicon.id).toBe(PETS_NSID);
    expect(lexicon.defs.main.key).toBe(`literal:${PETS_RKEY}`);
    expect(lexicon.defs.main.record.required).toEqual(['count', 'createdAt', 'updatedAt']);
    expect(SCOPE.split(' ')).toContain('include:to.atpota.authFull');
    expect(grants(PETS_NSID)).toEqual(['create', 'update']);
    const record = petsRecord(5, CREATED, new Date('2026-10-20T12:00:00Z'));
    expect(record).toEqual({ $type: PETS_NSID, count: 5, createdAt: CREATED, updatedAt: '2026-10-20T12:00:00.000Z' });
    expect(Object.keys(record).filter((k) => k !== '$type').sort()).toEqual(Object.keys(lexicon.defs.main.record.properties).sort());
  });

  it('reads only sensible counts', () => {
    expect(toSavedPets({ count: 12, createdAt: CREATED })).toEqual({ count: 12, createdAt: CREATED });
    expect(toSavedPets({ count: 0, createdAt: CREATED })).toEqual({ count: 0, createdAt: CREATED });
    for (const count of [-1, 1.5, '12', MAX_PETS + 1, Number.NaN]) expect(toSavedPets({ count, createdAt: CREATED })).toBeNull();
    expect(toSavedPets({ count: 1, createdAt: 'soon' })).toBeNull();
    expect(toSavedPets(null)).toBeNull();
  });

  it('treats a missing record as none, and other errors as errors', async () => {
    const none = fakeSession(undefined);
    expect(await readSavedPets(none.session, none.fetchImpl)).toBeNull();
    const some = fakeSession({ count: 40, createdAt: CREATED });
    expect(await readSavedPets(some.session, some.fetchImpl)).toEqual({ count: 40, createdAt: CREATED });
    const down = vi.fn(async () => json(502, {})) as unknown as typeof fetch;
    await expect(readSavedPets(some.session, down)).rejects.toMatchObject({ status: 502 });
  });

  it('tells sign-in trouble from everything else', () => {
    expect(troubleFrom({ status: 401 })).toBe('expired');
    expect(troubleFrom(Object.assign(new Error('x'), { name: 'TokenRevokedError' }))).toBe('expired');
    expect(troubleFrom({ status: 403 })).toBe('consent');
    expect(troubleFrom({ status: 500 })).toBeNull();
    expect(troubleFrom(new TypeError('offline'))).toBeNull();
  });
});

describe('createPetSync', () => {
  it('does nothing for a signed-out reader', async () => {
    expect(await createPetSync(null).start()).toBeNull();
    const auth = fakeAuth(null, false);
    expect(await createPetSync(auth).start()).toBeNull();
    expect(auth.start).not.toHaveBeenCalled();
  });

  it('writes a burst of pets once, after a quiet spell, keeping createdAt', async () => {
    vi.useFakeTimers();
    const { session, fetchImpl, puts } = fakeSession({ count: 40, createdAt: CREATED });
    const sync = createPetSync(fakeAuth(session), { fetchImpl, now: () => new Date('2026-10-20T12:00:00Z') });
    expect(await sync.start()).toBe(40);
    expect(sync.did).toBe(DID);
    for (let total = 41; total <= 45; total++) sync.save(total);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts).toEqual([{ $type: PETS_NSID, count: 45, createdAt: CREATED, updatedAt: '2026-10-20T12:00:00.000Z' }]);
    // nothing new: nothing written
    sync.flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(puts).toHaveLength(1);
    // never goes down
    sync.save(3);
    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts).toHaveLength(1);
  });

  it('writes right away when the page is hidden', async () => {
    vi.useFakeTimers();
    const { session, fetchImpl, puts } = fakeSession(undefined);
    const sync = createPetSync(fakeAuth(session), { fetchImpl });
    expect(await sync.start()).toBe(0);
    sync.save(2);
    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ count: 2 });
    expect(typeof puts[0]!.createdAt).toBe('string');
  });

  it('stops and says why when the write is refused', async () => {
    vi.useFakeTimers();
    const { session, fetchImpl } = fakeSession(undefined, 403);
    const onTrouble = vi.fn();
    const sync = createPetSync(fakeAuth(session), { fetchImpl, onTrouble });
    await sync.start();
    sync.save(1);
    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTrouble).toHaveBeenCalledWith('consent');
    sync.save(2);
    sync.flush();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the tile count', () => {
  const HERO = `
    <div class="home-sun" data-mascot-trigger>
      <img data-mascot="kawaii" data-pet src="poe.svg" alt="poe">
      <p class="home-sun__bubble"><span class="only-hover">psst, hover me</span><span data-pet-say></span></p>
      <p class="home-sun__count" data-pet-count hidden><span data-pet-count-n></span><span data-pet-count-unit></span><button type="button" data-pet-count-ask hidden></button></p>
    </div>`;
  const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  const pet = (n = 1) => {
    for (let i = 0; i < n; i++) q('img[data-pet]').click();
  };

  it('is on the home page, next to Poe', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
    for (const attr of ['data-pet-count', 'data-pet-count-n', 'data-pet-count-unit', 'data-pet-count-ask']) expect(index).toContain(`${attr}`);
    expect(index.indexOf('data-pet-count')).toBeGreaterThan(index.indexOf('data-pet-say'));
  });

  it('stays hidden where sign-in is not offered', () => {
    document.body.innerHTML = HERO;
    initPet(document, { auth: null });
    pet(ASK_AFTER + 2);
    expect(q('[data-pet-count]').hidden).toBe(true);
  });

  it('offers a signed-out reader sign-in after a few pets', () => {
    document.body.innerHTML = HERO;
    localStorage.setItem(PETS_KEY, '7');
    initPet(document, { auth: fakeAuth(null, false) });
    pet(ASK_AFTER - 1);
    expect(q('[data-pet-count]').hidden).toBe(true);
    pet();
    expect(q('[data-pet-count]').hidden).toBe(false);
    expect(q('[data-pet-count-n]').textContent).toBe(String(7 + ASK_AFTER));
    expect(q('[data-pet-count-unit]').textContent).toContain('not saved yet');
    expect(q('[data-pet-count-ask]').hidden).toBe(false);
    expect(q('[data-pet-count-ask]').textContent).toBe(COUNT_COPY.ask);

    // the button asks the header's sign-in (account.ts) to open
    const asked: string[] = [];
    window.addEventListener(PET_SIGNIN_EVENT, (e) => asked.push((e as CustomEvent<{ lede: string }>).detail.lede), { once: true });
    q('[data-pet-count-ask]').click();
    expect(asked).toEqual([COUNT_COPY.lede]);
  });

  it('shows a signed-in reader the higher count, keeps pets from before it loaded, and saves', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = HERO;
    localStorage.setItem(PETS_KEY, '3');
    const { session, fetchImpl, puts } = fakeSession({ count: 1200, createdAt: CREATED });
    initPet(document, { auth: fakeAuth(session), fetchImpl });
    pet(2); // before the saved count has loaded
    await vi.advanceTimersByTimeAsync(400);
    expect(q('[data-pet-count]').hidden).toBe(false);
    expect(q('[data-pet-count-n]').textContent).toBe('1,202');
    expect(q('[data-pet-count-ask]').hidden).toBe(true);
    expect(localStorage.getItem(PETS_KEY)).toBe('1202');

    pet();
    expect(q('[data-pet-count-n]').textContent).toBe('1,203');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(puts.at(-1)).toMatchObject({ count: 1203, createdAt: CREATED });
  });

  it('asks again when the session predates the permission', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = HERO;
    const { session, fetchImpl } = fakeSession({ count: 10, createdAt: CREATED }, 403);
    initPet(document, { auth: fakeAuth(session), fetchImpl });
    await vi.advanceTimersByTimeAsync(400);
    pet();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(q('[data-pet-count-ask]').hidden).toBe(false);
    expect(q('[data-pet-count-ask]').textContent).toBe(COUNT_COPY.again);
  });

  it('welcomes a reader back from signing in here', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = HERO;
    sessionStorage.setItem('blog:pending', JSON.stringify({ kind: 'pet', returnTo: '/', at: Date.now() }));
    const { session, fetchImpl } = fakeSession(undefined);
    initPet(document, { auth: fakeAuth(session), fetchImpl });
    await vi.advanceTimersByTimeAsync(400);
    expect(q('[data-pet-say]').textContent).toBe(COUNT_COPY.welcome);
    expect(readPending(sessionStoreFor(window), Date.now())).toBeNull();
  });
});
