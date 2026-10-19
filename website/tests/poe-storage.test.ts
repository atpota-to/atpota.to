// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TRANSCRIPT,
  TRANSCRIPT_KEY,
  createStore,
  isTucked,
  loadTranscript,
  local,
  markNudged,
  parseEntry,
  resetStoresForTests,
  saveTranscript,
  session,
  setTucked,
  wasNudged,
  type TranscriptEntry,
} from '../src/poe/storage.js';

function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 } as unknown as Storage;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetStoresForTests();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

describe('createStore', () => {
  it('uses the real storage when it works', () => {
    const store = createStore(() => window.localStorage);
    expect(store.set('k', 'v')).toBe(true);
    expect(window.localStorage.getItem('k')).toBe('v');
    expect(store.get('k')).toBe('v');
    store.remove('k');
    expect(window.localStorage.getItem('k')).toBeNull();
  });

  it('falls back to memory when the storage getter throws (blocked site data)', () => {
    const store = createStore(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(store.get('k')).toBeNull();
    expect(store.set('k', 'v')).toBe(false);
    expect(store.get('k')).toBe('v');
    store.remove('k');
    expect(store.get('k')).toBeNull();
  });

  it('falls back to memory when every method throws', () => {
    const store = createStore(() => throwingStorage());
    expect(() => store.set('a', '1')).not.toThrow();
    expect(store.get('a')).toBe('1');
    expect(() => store.remove('a')).not.toThrow();
  });

  it('keeps the value in memory when setItem hits the quota', () => {
    const real = window.localStorage;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const store = createStore(() => real);
    expect(store.set('q', 'v')).toBe(false);
    expect(real.getItem('q')).toBeNull();
    expect(store.get('q')).toBe('v'); // kept for this page view
    vi.restoreAllMocks();
    // once storage works again, a successful write replaces the memory copy
    expect(store.set('q', 'w')).toBe(true);
    expect(real.getItem('q')).toBe('w');
    expect(store.get('q')).toBe('w');
    store.remove('q');
    expect(store.get('q')).toBeNull();
  });

  it('treats a null storage as unavailable', () => {
    const store = createStore(() => null);
    store.set('x', 'y');
    expect(store.get('x')).toBe('y');
  });
});

describe('flags', () => {
  it('stores tucked in localStorage under poe:tucked', () => {
    expect(isTucked()).toBe(false);
    setTucked(true);
    expect(window.localStorage.getItem('poe:tucked')).toBe('1');
    expect(isTucked()).toBe(true);
    setTucked(false);
    expect(window.localStorage.getItem('poe:tucked')).toBeNull();
  });

  it('stores the nudge flag in sessionStorage under poe:nudged', () => {
    expect(wasNudged()).toBe(false);
    markNudged();
    expect(window.sessionStorage.getItem('poe:nudged')).toBe('1');
    expect(wasNudged()).toBe(true);
  });

  it('keeps working when window storage throws on access', () => {
    const local$ = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const session$ = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    resetStoresForTests();
    expect(() => setTucked(true)).not.toThrow();
    expect(isTucked()).toBe(true);
    expect(() => markNudged()).not.toThrow();
    expect(wasNudged()).toBe(true);
    expect(() => saveTranscript([{ role: 'you', text: 'hi' }])).not.toThrow();
    expect(loadTranscript()).toEqual([{ role: 'you', text: 'hi' }]);
    expect(local$).toHaveBeenCalled();
    expect(session$).toHaveBeenCalled();
    expect(local()).toBe(local());
    expect(session()).toBe(session());
  });
});

describe('transcript', () => {
  it('round-trips entries and keeps only the last 20', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 25 }, (_, i) => ({ role: 'you', text: `q${i}` }) as TranscriptEntry);
    saveTranscript(entries);
    const loaded = loadTranscript();
    expect(loaded).toHaveLength(MAX_TRANSCRIPT);
    expect(loaded[0]).toEqual({ role: 'you', text: 'q5' });
    expect(loaded[19]).toEqual({ role: 'you', text: 'q24' });
  });

  it('removes the key when saving an empty transcript', () => {
    saveTranscript([{ role: 'you', text: 'x' }]);
    saveTranscript([]);
    expect(window.sessionStorage.getItem(TRANSCRIPT_KEY)).toBeNull();
  });

  it('returns [] for missing, corrupt or non-array data', () => {
    expect(loadTranscript()).toEqual([]);
    for (const raw of ['{', 'null', '"str"', '{"role":"you"}', '42']) {
      window.sessionStorage.setItem(TRANSCRIPT_KEY, raw);
      expect(loadTranscript(), raw).toEqual([]);
    }
  });

  it('drops invalid entries and cleans the valid ones', () => {
    window.sessionStorage.setItem(
      TRANSCRIPT_KEY,
      JSON.stringify([
        { role: 'you', text: 'ok', quote: 'labelers' },
        { role: 'you', text: '' },
        { role: 'admin', text: 'x' },
        { role: 'poe', text: 'answer', links: ['https://aturi.to', 'javascript:alert(1)', 'http://x.example', 5, 'https://a.example', 'https://b.example', 'https://c.example'] },
        { role: 'poe', text: 7 },
        { role: 'note', code: 'rate_limited', retryAfter: 120 },
        { role: 'note', code: '<img src=x>' },
        { role: 'note', code: 'timeout', retryAfter: -5 },
        null,
        'string',
      ]),
    );
    expect(loadTranscript()).toEqual([
      { role: 'you', text: 'ok', quote: 'labelers' },
      { role: 'poe', text: 'answer', links: ['https://aturi.to', 'https://a.example', 'https://b.example'] },
      { role: 'note', code: 'rate_limited', retryAfter: 120 },
      { role: 'note', code: 'timeout' },
    ]);
  });

  it('caps stored text and quote lengths', () => {
    const entry = parseEntry({ role: 'you', text: 'x'.repeat(50_000), quote: 'q'.repeat(1000) });
    expect(entry && entry.role === 'you' && entry.text.length).toBe(12_000);
    expect(entry && entry.role === 'you' && entry.quote?.length).toBe(300);
  });
});
