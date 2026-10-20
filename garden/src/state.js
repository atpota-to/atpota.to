// state.js
// What's kept across restarts, in state.json in the data folder:
//
//   { "cursors": { "<jetstream host>": <seq> }, "backfilledAt": "<iso>" | null }
//
// A cursor is the newest Jetstream v2 `seq` from that host whose events are all in
// Supabase. Cursors are kept per host because each Jetstream numbers its own events: one
// host's seq means nothing to another. backfilledAt is when the last reconcile finished,
// so a restart doesn't start another one. Written atomically (a temp file, then a rename),
// and a missing or broken file is a fresh start, never a crash: the worst it costs is a
// reconcile.

import fs from 'node:fs';

export const emptyState = () => ({ cursors: {}, backfilledAt: null });

export function loadState(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }
  const state = emptyState();
  if (raw && typeof raw.cursors === 'object' && raw.cursors !== null) {
    for (const [host, seq] of Object.entries(raw.cursors)) {
      if (Number.isSafeInteger(seq) && seq > 0) state.cursors[host] = seq;
    }
  }
  if (typeof raw?.backfilledAt === 'string' && Number.isFinite(Date.parse(raw.backfilledAt))) state.backfilledAt = raw.backfilledAt;
  return state;
}

export function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * The state in memory, saved on every change. A failed save is logged and the state kept:
 * the next save writes it all again.
 */
export function createStore(file, log, { load = loadState, save = saveState } = {}) {
  const state = file ? load(file) : emptyState();
  const persist = () => {
    if (!file) return;
    try {
      save(file, state);
    } catch (err) {
      log.error('could not save state', { file, err });
    }
  };
  return {
    cursor(host) {
      return state.cursors[host] ?? null;
    },
    /** Saves the newest seq applied for each host given (a Map or [host, seq] pairs). */
    setCursors(entries) {
      let changed = false;
      for (const [host, seq] of entries) {
        if (!Number.isSafeInteger(seq) || seq <= 0 || state.cursors[host] === seq) continue;
        state.cursors[host] = seq;
        changed = true;
      }
      if (changed) persist();
    },
    dropCursor(host) {
      if (!(host in state.cursors)) return;
      delete state.cursors[host];
      persist();
    },
    get backfilledAt() {
      return state.backfilledAt;
    },
    setBackfilledAt(iso) {
      state.backfilledAt = iso;
      persist();
    },
    /** A copy, for tests and the stats line. */
    get snapshot() {
      return { cursors: { ...state.cursors }, backfilledAt: state.backfilledAt };
    },
  };
}
