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

/** Every start replays at least this far back, so /v1/now has a full window (and
 *  /healthz says ok) as soon as the replay catches up, a few seconds after a deploy. */
export const LOOKBACK_S = 65;

/**
 * Where to start: the first minute to write (epoch seconds) and the Jetstream cursor
 * (time_us). Without a saved minute, the current minute. Replaying further back than
 * the first minute to write is harmless: the writer never goes back before it.
 */
export function resumePoint(state, nowMs, maxReplaySeconds, rewindUs) {
  const nowSec = nowMs / 1000;
  const current = Math.floor(nowSec / 60) * 60;
  const lookbackUs = Math.round((nowSec - LOOKBACK_S) * 1e6);
  if (!state) return { startMinute: current, startCursorUs: lookbackUs };
  const earliest = Math.ceil((nowSec - maxReplaySeconds) / 60) * 60;
  const resume = Math.max(state.lastWrittenMinute + 60, earliest);
  if (resume > current) return { startMinute: current, startCursorUs: lookbackUs };
  return { startMinute: resume, startCursorUs: Math.min(resume * 1e6 - rewindUs, lookbackUs) };
}
