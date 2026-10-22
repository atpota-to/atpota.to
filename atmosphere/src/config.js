// config.js
// Everything comes from the environment (the unit's EnvironmentFile, .env).

import path from 'node:path';
import { DEFAULT_RELAY } from './hosts.js';
import { DEFAULT_URLS } from './jetstream.js';

function opt(env, name, fallback) {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function num(env, name, fallback) {
  const v = opt(env, name, '');
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
  return n;
}

export function loadConfig(env = process.env) {
  const secret = opt(env, 'WEATHER_SECRET', '');
  if (secret.length < 32) throw new Error('WEATHER_SECRET must be set, at least 32 characters');
  const supabaseUrl = opt(env, 'SUPABASE_URL', '');
  const supabaseKey = opt(env, 'SUPABASE_SERVICE_ROLE_KEY', '');
  return {
    jetstreamUrls: opt(env, 'JETSTREAM_URLS', DEFAULT_URLS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    host: opt(env, 'HOST', '127.0.0.1'),
    port: num(env, 'PORT', 8790),
    secret,
    // Without both, the station still answers /v1/now and writes nothing.
    supabase: supabaseUrl && supabaseKey ? { url: supabaseUrl, key: supabaseKey } : null,
    // whose list of PDS hosts to count (hosts.js)
    relayUrl: opt(env, 'RELAY_URL', DEFAULT_RELAY),
    stateFile: opt(env, 'STATE_FILE', 'state.json'),
    // which independent host each account lives on, by a hash of its DID (host-activity.js); beside the state file
    hostDirectoryFile: opt(env, 'HOST_DIRECTORY_FILE', path.join(path.dirname(opt(env, 'STATE_FILE', 'state.json')), 'host-directory.json')),
    maxReplaySeconds: num(env, 'MAX_REPLAY_SECONDS', 1800),
    logLevel: opt(env, 'LOG_LEVEL', 'info'),
  };
}
