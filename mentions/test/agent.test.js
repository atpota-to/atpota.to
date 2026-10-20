import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendMention } from '../src/agent.js';

/** A stand-in agent route that records every body and answers with `respond(body)`. */
async function fakeAgent(respond) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      res.writeHead(respond(body)).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { bodies, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const row = {
  thread_root: 'at://did:plc:a/app.bsky.feed.post/root',
  uri: 'at://did:plc:a/app.bsky.feed.post/new',
  author_did: 'did:plc:a',
  author_handle: 'a.bsky.social',
  text: 'how was your nap?',
  reason: 'reply',
  attempts: 1,
};
const thread = [{ author: 'poe.atpota.to', you: true, text: 'ok i need a little lie down!' }];

test('the thread travels with the turn', async () => {
  const agent = await fakeAgent(() => 202);
  try {
    const res = await sendMention(row, { context: { thread }, agentUrl: agent.url });
    assert.equal(res.ok, true);
    assert.deepEqual(agent.bodies[0].thread, thread);
  } finally { agent.close(); }
});

test('no thread, no thread field: the payload is what it was before', async () => {
  const agent = await fakeAgent(() => 202);
  try {
    await sendMention(row, { context: { thread: [] }, agentUrl: agent.url });
    await sendMention(row, { agentUrl: agent.url });
    for (const body of agent.bodies) assert.equal('thread' in body, false);
    assert.deepEqual(agent.bodies[0].account, { handle: 'atpota.to', did: 'did:plc:qntsxa2i4sb24noi45fx4np2' },
      'the agent is told which account it is answering as');
  } finally { agent.close(); }
});

test('an agent that refuses the context still gets the turn, without it', async () => {
  // Schema drift between the two repos produced silence once already. The
  // context is context; losing it must not lose the answer.
  const agent = await fakeAgent((body) => ('thread' in body ? 400 : 202));
  try {
    const res = await sendMention(row, { context: { thread }, agentUrl: agent.url });
    assert.equal(res.ok, true);
    assert.equal(agent.bodies.length, 2);
    assert.equal('thread' in agent.bodies[1], false);
    assert.equal(agent.bodies[1].text, row.text);
  } finally { agent.close(); }
});

test('a 400 is retried once, bare, and then given up on', async () => {
  const agent = await fakeAgent(() => 400);
  try {
    const res = await sendMention(row, { agentUrl: agent.url });
    assert.equal(res.ok, false);
    assert.equal(agent.bodies.length, 2, 'one bare resend, never a loop');
    assert.deepEqual(Object.keys(agent.bodies[1]).sort(),
      ['attempt', 'authorDid', 'authorHandle', 'postUri', 'reason', 'text', 'threadRoot'],
      'the resend is exactly the original contract');
  } finally { agent.close(); }
});

test('the embed, the images and the written-out text travel with the turn', async () => {
  const agent = await fakeAgent(() => 202);
  const context = {
    text: 'what is this? https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json',
    attachment: '[quoting @dame.is (at://did:plc:a/app.bsky.feed.post/q): lexicons are just json]',
    images: [{ url: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:a/bafk@jpeg', source: 'their post' }],
  };
  try {
    await sendMention(row, { context, agentUrl: agent.url });
    const body = agent.bodies[0];
    assert.equal(body.text, context.text, 'the agent gets the links written out');
    assert.equal(body.attachment, context.attachment);
    assert.deepEqual(body.images, context.images);
    assert.equal('thread' in body, false, 'no thread, no thread field');
  } finally { agent.close(); }
});

test('the bare resend goes back to the stored text, not the rewritten one', async () => {
  const agent = await fakeAgent((body) => ('attachment' in body ? 400 : 202));
  try {
    const res = await sendMention(row, { context: { text: 'rewritten', attachment: '[image]' }, agentUrl: agent.url });
    assert.equal(res.ok, true);
    assert.equal(agent.bodies[1].text, row.text);
    for (const k of ['attachment', 'images', 'thread']) assert.equal(k in agent.bodies[1], false);
  } finally { agent.close(); }
});

test('direction from the people who run it travels with the turn', async () => {
  const agent = await fakeAgent(() => 202);
  try {
    await sendMention(row, { operator: true, lessonSaved: 'fewer faces', lessons: ['fewer faces', 'say PDS'], agentUrl: agent.url });
    await sendMention(row, { agentUrl: agent.url });
    assert.equal(agent.bodies[0].operator, true);
    assert.equal(agent.bodies[0].lessonSaved, 'fewer faces');
    assert.deepEqual(agent.bodies[0].lessons, ['fewer faces', 'say PDS']);
    for (const k of ['operator', 'lessonSaved', 'lessons']) assert.equal(k in agent.bodies[1], false, `no ${k} unless there is one`);
  } finally { agent.close(); }
});
