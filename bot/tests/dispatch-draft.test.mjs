import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

// lib/dispatch-draft.ts, lib/operator-dm.ts and the five draft tools, compiled as the
// other contract tests do, with eve's defineTool stubbed and the extensionless imports
// made loadable by Node.
const tools = ["read_dispatch_draft", "save_dispatch_draft", "propose_dispatch_publish", "start_dispatch_draft",
  "propose_dispatch_correction"];
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig",
  "agent/lib/dispatch-draft.ts", "agent/lib/operator-dm.ts", ...tools.map((t) => `agent/tools/${t}.ts`),
  "--outDir", ".eve/dispatch-draft-test", "--rootDir", "agent",
  "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022",
  "--skipLibCheck", "--types", "node"], { cwd: new URL("..", import.meta.url) });
const out = new URL("../.eve/dispatch-draft-test/", import.meta.url);
const stub = `data:text/javascript,${encodeURIComponent("export const defineTool = (tool) => tool;")}`;
for (const file of ["lib/dispatch-draft", "lib/operator-dm", ...tools.map((t) => `tools/${t}`)]) {
  const source = readFileSync(new URL(`${file}.js`, out), "utf8")
    .replace('from "eve/tools"', `from "${stub}"`)
    .replace('from "../lib/dispatch-draft"', 'from "../lib/dispatch-draft.mjs"');
  writeFileSync(new URL(`${file}.mjs`, out), source);
}
const { DispatchDraftRequest, buildDispatchPrompt, draftCaller, postDispatchDone } =
  await import(new URL("lib/dispatch-draft.mjs", out));
const { OperatorDm, draftAttributes } = await import(new URL("lib/operator-dm.mjs", out));
const tool = Object.fromEntries(await Promise.all(tools.map(async (t) =>
  [t, (await import(new URL(`tools/${t}.mjs`, out))).default])));

const operator = "did:plc:operator1";
const dmCaller = { authenticator: "atpotato-droplet-dm", principalType: "user", principalId: operator,
  attributes: { dmId: "dm-42", operatorDid: operator, guidance: "false" } };
const drafting = { authenticator: "atpotato-droplet-dispatch", principalType: "service", principalId: "atpotato-dispatch-drafts",
  attributes: { draftId: "dd-2026-10-26" } };
const bluesky = { authenticator: "atpotato-droplet", principalType: "user", principalId: "did:plc:someone",
  attributes: { did: "did:plc:someone", postUri: "at://did:plc:someone/app.bsky.feed.post/1", attempt: "1" } };
const website = { authenticator: "atpotato-website", principalType: "anonymous", principalId: "website-visitor", attributes: {} };
const ctx = (current) => ({ session: { id: "s1", auth: { initiator: current, current } } });

function withFetch(respond) {
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "shared";
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init, body: JSON.parse(init.body) }); return respond(init); };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

const request = {
  draftId: "dd-2026-10-26",
  windowStart: "2026-10-19T19:02:15.894Z",
  windowEnd: "2026-10-26T12:00:00.000Z",
  lastIssue: { title: "attie sites, spaces near beta, and a brand new cow", url: "https://atpota.to/blog/3myasnk4bzk22", publishedAt: "2026-10-19T19:02:15.894Z" },
};

test("accepts only the droplet's draft request", () => {
  assert.equal(DispatchDraftRequest.safeParse(request).success, true);
  assert.equal(DispatchDraftRequest.safeParse({ ...request, lastIssue: undefined, guidance: "lead with spaces" }).success, true);
  assert.equal(DispatchDraftRequest.safeParse({ ...request, draftId: "../etc" }).success, false);
  assert.equal(DispatchDraftRequest.safeParse({ ...request, windowEnd: "next tuesday" }).success, false);
  assert.equal(DispatchDraftRequest.safeParse({ ...request, publish: true }).success, false);
});

test("the prompt names the window, the last issue and the operator's words", () => {
  const prompt = buildDispatchPrompt({ ...request, guidance: "lead with the spaces beta" });
  assert.match(prompt, /^<dispatch_draft id="dd-2026-10-26">/);
  assert.match(prompt, /covering 2026-10-19 to 2026-10-26/);
  assert.match(prompt, /"attie sites, spaces near beta, and a brand new cow" \(https:\/\/atpota\.to\/blog\/3myasnk4bzk22\)/);
  assert.match(prompt, /The operator asked for this one, and said:\nlead with the spaces beta/);
  assert.match(prompt, /save it with save_dispatch_draft/);
  assert.doesNotMatch(buildDispatchPrompt({ ...request, lastIssue: undefined }), /The last issue/);
});

test("a draft tool is for the drafting session or an operator DM, from auth alone", () => {
  assert.deepEqual(draftCaller(ctx(drafting)), { draftingId: "dd-2026-10-26" });
  assert.deepEqual(draftCaller(ctx(dmCaller)), { dmId: "dm-42", operatorDid: operator });
  for (const caller of [bluesky, website, undefined, { ...dmCaller, principalId: "did:plc:someoneelse" },
    { ...drafting, principalType: "user" }, { ...drafting, attributes: { draftId: "nope" } }]) {
    assert.equal(draftCaller(ctx(caller)), null);
  }
});

test("reading and saving go to the droplet with the caller it authenticated", async () => {
  const f = withFetch(() => Response.json({ accepted: true, version: 2, preview: "https://atpota.to/blog/preview/abc" }));
  try {
    assert.deepEqual(await tool.save_dispatch_draft.execute({ title: "spaces", markdown: "## hi" }, ctx(drafting)),
      { accepted: true, version: 2, preview: "https://atpota.to/blog/preview/abc" });
    await tool.save_dispatch_draft.execute({ edits: [{ find: "a", replace: "b" }], draftingId: "dd-2099-01-01" }, ctx(dmCaller));
    await tool.read_dispatch_draft.execute({}, ctx(dmCaller));
  } finally { f.restore(); }
  assert.equal(f.requests[0].url, "https://droplet.example/callback");
  assert.equal(f.requests[0].init.headers["x-atpotato-secret"], "shared");
  assert.deepEqual(f.requests[0].body, { draftingId: "dd-2026-10-26", dispatchDraft: { action: "save", title: "spaces", markdown: "## hi" } });
  // The model can't pick the draft or the DM: those come from the session's auth.
  assert.equal(f.requests[1].body.draftingId, undefined);
  assert.equal(f.requests[1].body.dmId, "dm-42");
  assert.equal(f.requests[1].body.dispatchDraft.draftingId, "dd-2099-01-01", "the stray field rides inside the call, where the droplet ignores it");
  assert.deepEqual(f.requests[2].body, { dmId: "dm-42", operatorDid: operator, dispatchDraft: { action: "read" } });
});

test("making it live and starting a draft are for operator DMs only", async () => {
  const f = withFetch(() => Response.json({ accepted: true, version: 3, note: "proposed, not published" }));
  try {
    assert.deepEqual(await tool.propose_dispatch_publish.execute({ version: 3, announcement: "issue two is out!" }, ctx(dmCaller)),
      { proposed: true, version: 3, note: "proposed, not published" });
    assert.equal((await tool.propose_dispatch_publish.execute({ version: 3 }, ctx(drafting))).proposed, false);
    assert.equal((await tool.start_dispatch_draft.execute({}, ctx(drafting))).started, false);
    assert.equal((await tool.start_dispatch_draft.execute({ guidance: "spaces" }, ctx(dmCaller))).started, true);
    for (const caller of [bluesky, website, undefined]) {
      assert.equal((await tool.read_dispatch_draft.execute({}, ctx(caller))).found, false);
      assert.equal((await tool.save_dispatch_draft.execute({ markdown: "x" }, ctx(caller))).accepted, false);
    }
  } finally { f.restore(); }
  assert.equal(f.requests.length, 2, "only the two DM calls reached the droplet");
  assert.deepEqual(f.requests[0].body.dispatchDraft, { action: "propose_publish", version: 3, announcement: "issue two is out!" });
  assert.deepEqual(f.requests[1].body.dispatchDraft, { action: "start", guidance: "spaces" });
});

test("a live issue is read and corrected only from an operator DM, and only proposed", async () => {
  const f = withFetch(() => Response.json({ accepted: true, version: 1, note: "proposed, not changed" }));
  const fix = { issue: "latest", version: 1, edits: [{ find: "the beta is close", replace: "the beta is very close" }] };
  try {
    await tool.read_dispatch_draft.execute({ issue: "latest" }, ctx(dmCaller));
    assert.deepEqual(await tool.propose_dispatch_correction.execute(fix, ctx(dmCaller)),
      { proposed: true, version: 1, note: "proposed, not changed" });
    for (const caller of [drafting, bluesky, website, undefined]) {
      assert.equal((await tool.propose_dispatch_correction.execute(fix, ctx(caller))).proposed, false);
    }
  } finally { f.restore(); }
  assert.equal(f.requests.length, 2, "only the two DM calls reached the droplet");
  assert.deepEqual(f.requests[0].body, { dmId: "dm-42", operatorDid: operator, dispatchDraft: { action: "read", issue: "latest" } });
  assert.deepEqual(f.requests[1].body.dispatchDraft, { action: "propose_correction", ...fix });

  const schema = tool.propose_dispatch_correction.inputSchema;
  assert.equal(schema.safeParse(fix).success, true);
  assert.equal(schema.safeParse({ issue: "latest", version: 1, title: "spaces is nearly here" }).success, true);
  assert.equal(schema.safeParse({ issue: "latest", version: 1 }).success, false, "a fix needs something to fix");
  assert.equal(schema.safeParse({ ...fix, edits: Array.from({ length: 11 }, () => fix.edits[0]) }).success, false, "small fixes only");
  assert.equal(schema.safeParse({ ...fix, edits: [{ find: "x".repeat(501), replace: "y" }] }).success, false);
});

test("service errors are reasons, not throws", async () => {
  for (const [respond, reason] of [
    [() => new Response(null, { status: 503 }), "service unavailable"],
    [() => new Response(null, { status: 409 }), /can't work on the draft/],
    [() => new Response(null, { status: 429 }), /too many tries/],
    [() => { throw new Error("socket hang up"); }, "service unavailable"],
  ]) {
    const f = withFetch(respond);
    try {
      const result = await tool.save_dispatch_draft.execute({ markdown: "x" }, ctx(drafting));
      assert.equal(result.accepted, false);
      if (reason instanceof RegExp) assert.match(result.reason, reason);
      else assert.equal(result.reason, reason);
    } finally { f.restore(); }
  }
});

test("the drafting turn's last word goes back keyed, for the droplet to DM", async () => {
  const f = withFetch(() => Response.json({ ok: true }));
  try {
    await postDispatchDone({ key: "s1:t1", draftId: "dd-2026-10-26", text: "here it is!" });
  } finally { f.restore(); }
  assert.deepEqual(f.requests[0].body, { key: "s1:t1", dispatchDraftDone: { draftId: "dd-2026-10-26", text: "here it is!" } });
});

test("an operator DM can carry the draft waiting on them, as string attributes", () => {
  const dm = { dmId: "dm-1", operatorDid: "did:plc:abc123", text: "cut the tokimeki bit" };
  const dispatchDraft = { id: "dd-2026-10-26", status: "ready", version: 3, title: "spaces near beta" };
  assert.equal(OperatorDm.safeParse({ ...dm, dispatchDrafts: true, dispatchDraft }).success, true);
  assert.equal(OperatorDm.safeParse({ ...dm, dispatchDrafts: false }).success, false);
  assert.equal(OperatorDm.safeParse({ ...dm, dispatchDraft: { ...dispatchDraft, status: "published" } }).success, false);
  assert.equal(OperatorDm.safeParse({ ...dm, dispatchDraft: { ...dispatchDraft, extra: 1 } }).success, false);
  assert.deepEqual(draftAttributes({ dispatchDrafts: true, dispatchDraft }), {
    dispatchDrafts: "true", dispatchDraftId: "dd-2026-10-26", dispatchDraftStatus: "ready", dispatchDraftVersion: "3",
    dispatchDraftTitle: "spaces near beta",
  });
  assert.deepEqual(draftAttributes({ dispatchDrafts: true }), { dispatchDrafts: "true" });
  assert.deepEqual(draftAttributes({}), {});
});
