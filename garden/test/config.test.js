// The environment: what's required, and the defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const env = { SUPABASE_URL: 'https://zdzjtziydmwkxbzlkwxv.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

test('without the Supabase URL and service key it refuses to start, saying which', () => {
  assert.throws(() => loadConfig({}), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => loadConfig({ SUPABASE_URL: env.SUPABASE_URL }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: '  ' }), /SUPABASE_URL/);
});

test('the defaults', () => {
  assert.deepEqual(loadConfig(env), {
    supabase: { url: 'https://zdzjtziydmwkxbzlkwxv.supabase.co', key: 'service-key' },
    jetstreamHosts: ['wss://jetstream2.us-east.bsky.network', 'wss://jetstream1.us-east.bsky.network'],
    relayUrl: 'https://relay1.us-east.bsky.network',
    plcUrl: 'https://plc.directory',
    host: '127.0.0.1',
    port: 8791,
    stateFile: 'state.json',
    reconcileHours: 6,
    recycleMinutes: 15,
    settleSeconds: 30,
    logLevel: 'info',
  });
});

test('overrides, and nonsense refused', () => {
  const c = loadConfig({ ...env, JETSTREAM_HOSTS: ' wss://a.example/ , wss://b.example ', PORT: '9000', RECONCILE_HOURS: '1', PLC_URL: 'https://plc.example/' });
  assert.deepEqual(c.jetstreamHosts, ['wss://a.example', 'wss://b.example']);
  assert.equal(c.port, 9000);
  assert.equal(c.reconcileHours, 1);
  assert.equal(c.plcUrl, 'https://plc.example');
  assert.throws(() => loadConfig({ ...env, PORT: 'eighty' }), /PORT/);
  assert.throws(() => loadConfig({ ...env, JETSTREAM_HOSTS: 'https://a.example' }), /JETSTREAM_HOSTS/);
  assert.throws(() => loadConfig({ ...env, JETSTREAM_HOSTS: 'wss://a.example/subscribe' }), /JETSTREAM_HOSTS/, 'a host, not a path');
  assert.throws(() => loadConfig({ ...env, RELAY_URL: 'ftp://relay' }), /RELAY_URL/);
  assert.throws(() => loadConfig({ ...env, RECYCLE_MINUTES: '0' }), /RECYCLE_MINUTES/);
});
