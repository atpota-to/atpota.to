// Restarts: where a new process resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REWIND_US } from '../src/jetstream.js';
import { LOOKBACK_S, loadState, resumePoint, saveState } from '../src/state.js';

const T0 = 1_792_512_000;

test('no saved state: the current minute, replaying a full window so /v1/now answers at once', () => {
  assert.deepEqual(resumePoint(null, (T0 + 75) * 1000, 1800, REWIND_US), { startMinute: T0 + 60, startCursorUs: (T0 + 75 - LOOKBACK_S) * 1e6 });
});

test('after a restart: the minute after the last one written, replayed from just before it', () => {
  const r = resumePoint({ lastWrittenMinute: T0 }, (T0 + 130) * 1000, 1800, REWIND_US);
  assert.deepEqual(r, { startMinute: T0 + 60, startCursorUs: (T0 + 60) * 1e6 - REWIND_US });
});

test('a restart moments after a minute was written still replays a full window', () => {
  const r = resumePoint({ lastWrittenMinute: T0 }, (T0 + 120 + 20) * 1000, 1800, REWIND_US);
  assert.deepEqual(r, { startMinute: T0 + 60, startCursorUs: (T0 + 60) * 1e6 - REWIND_US });
  const soon = resumePoint({ lastWrittenMinute: T0 + 60 }, (T0 + 120 + 20) * 1000, 1800, REWIND_US);
  assert.equal(soon.startMinute, T0 + 120);
  assert.equal(soon.startCursorUs, (T0 + 140 - LOOKBACK_S) * 1e6, 'further back than the minute, for the rolling window');
});

test('a long outage replays no further back than allowed', () => {
  const r = resumePoint({ lastWrittenMinute: T0 - 7200 }, (T0 + 30) * 1000, 1800, REWIND_US);
  assert.equal(r.startMinute, T0 - 1740);
  assert.equal(r.startCursorUs, (T0 - 1740) * 1e6 - REWIND_US);
});

test('saves atomically and ignores a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-state-'));
  const file = path.join(dir, 'state.json');
  assert.equal(loadState(file), null);
  saveState(file, { lastWrittenMinute: T0 });
  assert.deepEqual(loadState(file), { lastWrittenMinute: T0 });
  fs.writeFileSync(file, '{nope');
  assert.equal(loadState(file), null);
  fs.rmSync(dir, { recursive: true });
});
