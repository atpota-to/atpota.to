import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { startCallbackServer } from '../src/callback.js';
import { acceptMessage, baseline } from '../src/operator-dm.js';

test('DM callback authenticates and never enters the public post queue', async () => {
  config.adminDids = ['did:plc:operator123'];
  config.dmEnabled = true;
  const convo = { id: 'direct-callback', members: [{ did: config.botDid }, { did: config.adminDids[0] }] };
  const message = { id: 'callback-msg', text: 'ping', sender: { did: config.adminDids[0] },
    sentAt: new Date(Date.now() + 60000).toISOString() };
  acceptMessage(convo, message, baseline());
  db.prepare("UPDATE operator_dm SET status = 'dispatched' WHERE message_id = ?").run(message.id);
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/dm-draft`;
  const body = JSON.stringify({ key: 'callback-key', dmId: message.id,
    operatorDid: config.adminDids[0], text: 'secret response' });
  try {
    let response = await fetch(url, { method: 'POST', body });
    assert.equal(response.status, 401);
    response = await fetch(url, { method: 'POST',
      headers: { 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify({ ...JSON.parse(body), operatorDid: 'did:plc:attacker' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, false);
    // Disable outbound sending for this test; the draft remains private and durable.
    config.dmEnabled = false;
    response = await fetch(url, { method: 'POST',
      headers: { 'x-atpotato-secret': config.sharedSecret }, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM queue').get().count, 0);
    assert.equal(db.prepare('SELECT draft_text FROM operator_dm WHERE message_id = ?').get(message.id).draft_text, 'secret response');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
