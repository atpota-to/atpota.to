// state.js
// The one thing kept across restarts: the last minute written to Supabase. On start the
// station resumes Jetstream from just before the next minute, so a restart (or a kill -9)
// replays the minutes it would otherwise lose, and never rewrites one it already wrote.

import fs from 'node:fs';

export function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(state?.lastWrittenMinute) ? state : null;
  } catch {
    return null;
  }
}

export function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Where to start: the first minute to write (epoch seconds) and the Jetstream cursor
 * (time_us, or null for the live tail). Without a saved minute, the current minute,
 * partly covered, from the live tail.
 */
export function resumePoint(state, nowMs, maxReplaySeconds, rewindUs) {
  const nowSec = nowMs / 1000;
  const current = Math.floor(nowSec / 60) * 60;
  if (!state) return { startMinute: current, startCursorUs: null };
  const earliest = Math.ceil((nowSec - maxReplaySeconds) / 60) * 60;
  const resume = Math.max(state.lastWrittenMinute + 60, earliest);
  if (resume > current) return { startMinute: current, startCursorUs: null };
  return { startMinute: resume, startCursorUs: resume * 1e6 - rewindUs };
}
