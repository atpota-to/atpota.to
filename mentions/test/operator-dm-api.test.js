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

test('a DM link goes out with a link facet, so it can be tapped', async () => {
  const original = global.fetch;
  const bodies = [];
  global.fetch = async (url, options = {}) => {
    const nsid = String(url).split('/xrpc/')[1].split('?')[0];
    if (nsid === 'chat.bsky.convo.sendMessage') bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify(nsid === 'com.atproto.server.createSession'
      ? { did: config.botDid, handle: 'poe.atpota.to', accessJwt: 'test-token', refreshJwt: 'refresh' }
      : { id: 'sent-id', sender: { did: config.botDid } }), { status: 200 });
  };
  try {
    const url = 'https://atpota.to/blog/preview/abc123';
    const text = `done! ✿ preview (version 2): ${url}.`;
    await sendDmMessage('convo', null, text);
    const start = Buffer.byteLength('done! ✿ preview (version 2): ');
    assert.deepEqual(bodies[0].message, {
      text,
      facets: [{
        index: { byteStart: start, byteEnd: start + Buffer.byteLength(url) },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
      }],
    });
  } finally { global.fetch = original; }
});
