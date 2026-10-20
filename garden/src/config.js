// config.js
// Everything comes from the environment (the unit's EnvironmentFile, .env). The Supabase
// service key is the only secret, and without it there is nothing to do, so it's required.

export const DEFAULT_JETSTREAM_HOSTS = ['wss://jetstream2.us-east.bsky.network', 'wss://jetstream1.us-east.bsky.network'];

function opt(env, name, fallback) {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function num(env, name, fallback, { min = 0 } = {}) {
  const v = opt(env, name, '');
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`env ${name} is not a number of at least ${min}: ${v}`);
  return n;
}

function url(env, name, fallback, protocols) {
  const v = opt(env, name, fallback).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`env ${name} is not a URL: ${v}`);
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`env ${name} must be ${protocols.join(' or ')}: ${v}`);
  return v;
}

export function loadConfig(env = process.env) {
  const supabaseUrl = opt(env, 'SUPABASE_URL', '');
  const supabaseKey = opt(env, 'SUPABASE_SERVICE_ROLE_KEY', '');
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (the same values as /root/atpotato-weather/.env)');
  }
  const jetstreamHosts = opt(env, 'JETSTREAM_HOSTS', DEFAULT_JETSTREAM_HOSTS.join(','))
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const h of jetstreamHosts) {
    if (!/^wss?:\/\/[^/?#\s]+$/.test(h)) throw new Error(`env JETSTREAM_HOSTS: not a ws:// or wss:// host: ${h}`);
  }
  if (!jetstreamHosts.length) throw new Error('env JETSTREAM_HOSTS is empty');
  return {
    supabase: { url: url(env, 'SUPABASE_URL', '', ['https:', 'http:']), key: supabaseKey },
    jetstreamHosts,
    relayUrl: url(env, 'RELAY_URL', 'https://relay1.us-east.bsky.network', ['https:', 'http:']),
    plcUrl: url(env, 'PLC_URL', 'https://plc.directory', ['https:', 'http:']),
    host: opt(env, 'HOST', '127.0.0.1'),
    port: num(env, 'PORT', 8791),
    stateFile: opt(env, 'STATE_FILE', 'state.json'),
    reconcileHours: num(env, 'RECONCILE_HOURS', 6, { min: 0.25 }),
    recycleMinutes: num(env, 'RECYCLE_MINUTES', 15, { min: 1 }),
    settleSeconds: num(env, 'SETTLE_SECONDS', 30, { min: 1 }),
    logLevel: opt(env, 'LOG_LEVEL', 'info'),
  };
}
