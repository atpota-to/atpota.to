import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
globalThis.__scanBridge = { drafts: [] };
const channelStub = stub(`export const POST = (path, fetch) => ({ path, fetch });
  export const defineChannel = (definition) => definition;`);
const blueskyStub = stub(`export const MAX_TRACKED_LINKS = 200;
  export const MentionEvent = { safeParse: () => ({ success: false }) };
  export const buildPrompt = () => '';
  export const linksFromToolResult = () => [];
  export const postDraftToDroplet = async (draft) => globalThis.__scanBridge.drafts.push(draft);
  export const secretMatches = (secret) => secret === 'shared';`);
const visionStub = stub("export const describeImages = async () => [];");
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig",
  "agent/channels/bluesky.ts", "--outDir", ".eve/scan-bridge-test", "--rootDir", "agent",
  "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022",
  "--skipLibCheck", "--types", "node"], { cwd: new URL("..", import.meta.url) });
let source = readFileSync(new URL("../.eve/scan-bridge-test/channels/bluesky.js", import.meta.url), "utf8");
source = source.replace('from "eve/channels"', `from "${channelStub}"`)
  .replace('from "../lib/bluesky"', `from "${blueskyStub}"`)
  .replace('from "../lib/vision"', `from "${visionStub}"`);
const outputDir = new URL("../.eve/scan-bridge-test/", import.meta.url);
mkdirSync(outputDir, { recursive: true });
writeFileSync(new URL("bluesky.mjs", outputDir), source);
const channel = (await import(new URL("bluesky.mjs", outputDir))).default;
const responseRoute = channel.routes.find((route) => route.path === "/api/scan-approval/respond");
const postUri = "at://did:plc:requester/app.bsky.feed.post/post1";
const threadRoot = "at://did:plc:requester/app.bsky.feed.post/root";
const context = { session: { id: "session-1", auth: { current: {
  authenticator: "atpotato-droplet", principalType: "user", principalId: "did:plc:requester",
  attributes: { did: "did:plc:requester", postUri, threadRoot, attempt: "3" },
} } } };
const request = { requestId: "req-1", kind: "question", display: "confirmation",
  allowFreeform: false, prompt: "Scanned 1000 records. Approve scanning up to 10000 records?",
  options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Stop" }] };
const events = [{ type: "input.requested", data: { turnId: "turn-1", requests: [request] },
  meta: { at: new Date().toISOString() } }];
const responses = [];
const session = {
  getStreamTailIndex: async () => events.length,
  getEventStream: async () => new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(event);
    controller.close();
  } }),
  respond: async (...args) => { responses.push(args); return { status: "accepted" }; },
};
const routeContext = { attachSession: (id) => {
  assert.equal(id, "session-1");
  return session;
} };
const headers = { "x-atpotato-secret": "shared" };
const invoke = (payload, secret = headers) => responseRoute.fetch(new Request("https://bot.example/api/scan-approval/respond", {
  method: "POST", headers: secret, body: JSON.stringify(payload),
}), routeContext);
let offered;

// These tests exercise the channel handlers, including their authenticated HTTP
// route and Eve session handle, without starting the Eve runtime or droplet.
test("forwards only the original scan question with a signed, expiring address", async () => {
  process.env.DROPLET_SHARED_SECRET = "shared";
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/draft";
  const state = structuredClone(channel.state);
  const adapter = { state, continuation: { token: postUri } };
  channel.events["turn.started"]({ turnId: "turn-1" }, adapter, context);
  assert.deepEqual(state.origin, { sessionId: "session-1", turnId: "turn-1", postUri, threadRoot, attempt: 3 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    offered = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return { ok: true };
  };
  try {
    await channel.events["input.requested"]({ turnId: "turn-1", requests: [
      { ...request, kind: "tool-approval", requestId: "other" }, request,
    ] }, adapter, context);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(offered.url, "https://droplet.example/internal/scan-approval/request");
  assert.equal(offered.headers["x-atpotato-secret"], "shared");
  assert.equal(offered.body.postUri, postUri);
  assert.equal(offered.body.attempt, 3);
  assert.equal(offered.body.requestId, "req-1");
  assert.equal(offered.body.turnId, "turn-1");
  assert.equal(offered.body.sessionId, "session-1");
  assert.ok(offered.body.expiresAt > Date.now());
  assert.match(offered.body.approvalToken, /^[0-9a-f]{64}$/);
  await channel.events["input.requested"]({ turnId: "turn-other", requests: [request] }, adapter, context);
  return adapter;
});

test("requires shared secret, exact signed fields, live request, and allowed choice", async () => {
  const { prompt: _prompt, ...address } = offered.body;
  const valid = { ...address, optionId: "approve", adminDid: "did:plc:admin" };
  assert.equal((await invoke(valid, {})).status, 401);
  assert.equal((await invoke({ ...valid, optionId: "maybe" })).status, 400);
  for (const changed of [
    { postUri: "at://did:plc:other/app.bsky.feed.post/x" },
    { attempt: 4 }, { turnId: "turn-other" }, { requestId: "req-other" },
    { sessionId: "session-other" }, { expiresAt: Date.now() - 100 },
  ]) {
    assert.equal((await invoke({ ...valid, ...changed })).status, 409);
  }
  assert.equal(responses.length, 0);
  assert.equal((await invoke(valid)).status, 202);
  assert.deepEqual(responses[0][0], [{ requestId: "req-1", optionId: "approve" }]);
  assert.equal(responses[0][1].auth.principalId, "did:plc:admin");
  events.push({ type: "input.resolved", data: { turnId: "turn-1", resolutions: [{ requestId: "req-1" }] } });
  assert.equal((await invoke(valid)).status, 409);
  assert.equal(responses.length, 1);
  events.pop();
  assert.equal((await invoke({ ...valid, approvalToken: "0".repeat(64) })).status, 409);
  events.push({ type: "turn.started", data: { turnId: "new-attempt" } });
  assert.equal((await invoke({ ...valid, optionId: "deny" })).status, 409);
  events.pop();
  assert.equal((await invoke({ ...valid, optionId: "deny" })).status, 202);
  assert.deepEqual(responses.at(-1)[0], [{ requestId: "req-1", optionId: "deny" }]);
});

test("routes the resumed draft to the original requester, not auth.current admin", async () => {
  const adapter = { state: structuredClone(channel.state), continuation: { token: postUri } };
  channel.events["turn.started"]({ turnId: "turn-1" }, adapter, context);
  adapter.state.draft = "Here is your count.";
  adapter.state.links = ["https://example.org/result"];
  const adminContext = { session: { ...context.session, auth: { current: {
    authenticator: "atpotato-droplet-scan-approval", principalId: "did:plc:admin",
    attributes: { postUri: "at://did:plc:admin/app.bsky.feed.post/wrong", attempt: "99" },
  } } } };
  await channel.events["turn.completed"]({ turnId: "turn-1" }, adapter, adminContext);
  assert.deepEqual(globalThis.__scanBridge.drafts.at(-1), {
    key: "session-1:turn-1", threadRoot, postUri, attempt: 3,
    text: "Here is your count.", links: ["https://example.org/result"],
  });
  const count = globalThis.__scanBridge.drafts.length;
  await channel.events["turn.completed"]({ turnId: "turn-other" }, adapter, adminContext);
  assert.equal(globalThis.__scanBridge.drafts.length, count);
});
