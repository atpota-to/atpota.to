import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig",
  "agent/tools/propose_dispatch_announcement.ts", "--outDir", ".eve/dispatch-proposal-test", "--rootDir", "agent",
  "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022",
  "--skipLibCheck", "--types", "node"], { cwd: new URL("..", import.meta.url) });
const compiled = new URL("../.eve/dispatch-proposal-test/tools/propose_dispatch_announcement.js", import.meta.url);
const source = readFileSync(compiled, "utf8")
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent("export const defineTool = (tool) => tool;")}"`);
writeFileSync(new URL("../.eve/dispatch-proposal-test/tools/propose_dispatch_announcement.mjs", import.meta.url), source);
const tool = (await import("../.eve/dispatch-proposal-test/tools/propose_dispatch_announcement.mjs")).default;

const operator = "did:plc:operator1";
const dmCaller = { authenticator: "atpotato-droplet-dm", principalType: "user", principalId: operator,
  attributes: { dmId: "dm-42", operatorDid: operator, guidance: "false" } };
const ctx = (current) => ({ session: { id: "s1", auth: { initiator: current, current } } });
const issue = { title: "attie sites", description: "a week", url: "https://poe.leaflet.pub/3myasnk4bzk22",
  publishedAt: "2026-10-19T19:02:15.894Z", excerpt: "the big thing this week" };

function withFetch(respond) {
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "shared";
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return respond(init); };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test("proposes for the authenticated DM, never for a model-supplied one", async () => {
  const f = withFetch(() => Response.json({ accepted: true, issue, text: "it's out!", note: "proposed, not posted" }));
  try {
    const result = await tool.execute({ issue: "latest", text: "it's out!", dmId: "dm-other" }, ctx(dmCaller));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, "https://droplet.example/dispatch/announce-proposal");
    assert.equal(f.requests[0].init.headers["x-atpotato-secret"], "shared");
    assert.deepEqual(JSON.parse(f.requests[0].init.body),
      { dmId: "dm-42", operatorDid: operator, issue: "latest", text: "it's out!" });
    assert.deepEqual(result, { proposed: true, note: "proposed, not posted", issue, text: "it's out!" });
  } finally { f.restore(); }
});

test("without text it only looks the issue up", async () => {
  const f = withFetch(() => Response.json({ accepted: false, reason: "nothing proposed yet", issue }));
  try {
    const result = await tool.execute({ issue: "latest" }, ctx(dmCaller));
    assert.deepEqual(JSON.parse(f.requests[0].init.body), { dmId: "dm-42", operatorDid: operator, issue: "latest" });
    assert.deepEqual(result, { proposed: false, reason: "nothing proposed yet", issue });
  } finally { f.restore(); }
});

test("a failed check comes back as the reason, and an announced issue as its post", async () => {
  const f = withFetch(() => Response.json({ accepted: false, reason: "that issue is already announced",
    post: "https://bsky.app/profile/poe.atpota.to/post/3mdone", issue }));
  try {
    const result = await tool.execute({ issue: "latest", text: "again" }, ctx(dmCaller));
    assert.deepEqual(result, { proposed: false, reason: "that issue is already announced",
      announcedPost: "https://bsky.app/profile/poe.atpota.to/post/3mdone", issue });
  } finally { f.restore(); }
});

test("refuses outside an operator DM without calling the service", async () => {
  const f = withFetch(() => { throw new Error("must not be called"); });
  try {
    const bluesky = { authenticator: "atpotato-droplet", principalType: "user", principalId: "did:plc:someone",
      attributes: { did: "did:plc:someone", postUri: "at://did:plc:someone/app.bsky.feed.post/1" } };
    const spoofed = { ...dmCaller, principalId: "did:plc:someoneelse" };
    for (const caller of [bluesky, spoofed, undefined]) {
      const result = await tool.execute({ issue: "latest", text: "hi" }, ctx(caller));
      assert.equal(result.proposed, false);
    }
    assert.equal(f.requests.length, 0);
  } finally { f.restore(); }
});

test("service errors and rate limits are reported, not thrown", async () => {
  for (const [respond, reason] of [
    [() => new Response(null, { status: 503 }), "service unavailable"],
    [() => new Response(null, { status: 409 }), "service unavailable"],
    [() => new Response(null, { status: 429 }), /too many tries/],
    [() => { throw new Error("socket hang up"); }, "service unavailable"],
  ]) {
    const f = withFetch(respond);
    try {
      const result = await tool.execute({ issue: "latest", text: "hi" }, ctx(dmCaller));
      assert.equal(result.proposed, false);
      if (reason instanceof RegExp) assert.match(result.reason, reason);
      else assert.equal(result.reason, reason);
    } finally { f.restore(); }
  }
});
