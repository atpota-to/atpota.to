// state.json: cursors per host and the last reconcile, saved atomically, loaded tolerantly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, loadState, saveState } from '../src/state.js';

const quiet = { info() {}, warn() {}, error() {} };

test('saves atomically, and a missing or broken file is a fresh start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-state-'));
  const file = path.join(dir, 'state.json');
  try {
    assert.deepEqual(loadState(file), { cursors: {}, backfilledAt: null });
    saveState(file, { cursors: { 'wss://a': 5 }, backfilledAt: '2026-10-20T00:00:00.000Z' });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.deepEqual(loadState(file), { cursors: { 'wss://a': 5 }, backfilledAt: '2026-10-20T00:00:00.000Z' });
    fs.writeFileSync(file, '{nope');
    assert.deepEqual(loadState(file), { cursors: {}, backfilledAt: null });
    fs.writeFileSync(file, JSON.stringify({ cursors: { 'wss://a': 'x', 'wss://b': -1, 'wss://c': 9 }, backfilledAt: 'never' }));
    assert.deepEqual(loadState(file), { cursors: { 'wss://c': 9 }, backfilledAt: null });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('the store saves each change, and drops a host\'s cursor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-state-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = createStore(file, quiet);
    assert.equal(store.cursor('wss://a'), null);
    store.setCursors(new Map([['wss://a', 10]]));
    store.setCursors([['wss://b', 3]]);
    store.setBackfilledAt('2026-10-20T06:00:00.000Z');
    assert.deepEqual(loadState(file), { cursors: { 'wss://a': 10, 'wss://b': 3 }, backfilledAt: '2026-10-20T06:00:00.000Z' });
    store.dropCursor('wss://a');
    assert.deepEqual(createStore(file, quiet).snapshot, { cursors: { 'wss://b': 3 }, backfilledAt: '2026-10-20T06:00:00.000Z' });
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('a failed save is logged, and the state kept for the next one', () => {
  const errors = [];
  let broken = true;
  const saved = [];
  const store = createStore('state.json', { ...quiet, error: (msg) => errors.push(msg) }, {
    load: () => ({ cursors: {}, backfilledAt: null }),
    save: (_f, s) => {
      if (broken) throw new Error('disk full');
      saved.push(structuredClone(s));
    },
  });
  store.setCursors([['wss://a', 1]]);
  assert.deepEqual(errors, ['could not save state']);
  broken = false;
  store.setCursors([['wss://b', 2]]);
  assert.deepEqual(saved, [{ cursors: { 'wss://a': 1, 'wss://b': 2 }, backfilledAt: null }]);
});
