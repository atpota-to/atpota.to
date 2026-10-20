import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { listDmConvos, getDmMessages, sendDmMessage } from '../src/atproto.js';

test('chat endpoints use the PDS proxy, credential and DM reply target, not repo writes', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const nsid = String(url).split('/xrpc/')[1].split('?')[0];
    return new Response(JSON.stringify(nsid === 'com.atproto.server.createSession'
      ? { did: config.botDid, handle: 'poe.atpota.to', accessJwt: 'test-token', refreshJwt: 'refresh' }
      : nsid === 'chat.bsky.convo.listConvos' ? { convos: [] }
      : nsid === 'chat.bsky.convo.getMessages' ? { messages: [] }
      : { id: 'sent-id', sender: { did: config.botDid } }), { status: 200 });
  };
  try {
    await listDmConvos();
    await getDmMessages('target-convo');
    await sendDmMessage('target-convo', 'original-id', 'hello');
    assert.equal(calls.length, 4);
    for (const call of calls.slice(1)) {
      assert.equal(call.options.headers['atproto-proxy'], 'did:web:api.bsky.chat#bsky_chat');
      assert.equal(call.options.headers.authorization, 'Bearer test-token');
      assert.equal(call.url.startsWith(`${config.pdsUrl}/xrpc/chat.bsky.convo.`), true);
    }
    assert.deepEqual(JSON.parse(calls[3].options.body), {
      convoId: 'target-convo', message: { text: 'hello', replyTo: { messageId: 'original-id' } },
    });
  } finally { global.fetch = original; }
});
