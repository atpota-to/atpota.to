// logger.js
// One JSON object per line, so journalctl stays greppable.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', out = process.stdout, err = process.stderr) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
    (lvl === 'error' || lvl === 'warn' ? err : out).write(line + '\n');
  };
  return {
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
  };
}
