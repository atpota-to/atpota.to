// Restarts: where a new process resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REWIND_US } from '../src/jetstream.js';
import { loadState, resumePoint, saveState } from '../src/state.js';

const T0 = 1_792_512_000;

test('no saved state: the current minute, from the live tail', () => {
  assert.deepEqual(resumePoint(null, (T0 + 75) * 1000, 1800, REWIND_US), { startMinute: T0 + 60, startCursorUs: null });
});

test('after a restart: the minute after the last one written, replayed from just before it', () => {
  const r = resumePoint({ lastWrittenMinute: T0 }, (T0 + 130) * 1000, 1800, REWIND_US);
  assert.deepEqual(r, { startMinute: T0 + 60, startCursorUs: (T0 + 60) * 1e6 - REWIND_US });
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
