import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// Compile the presence library, its recall slot and read_dispatch, then swap
// eve's imports for stubs. Every fetch goes to a scripted stand-in for
// plc.directory and the atpota.to PDS; nothing reaches the network.
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/presence.ts",
  "agent/memory/presence.ts", "agent/tools/read_dispatch.ts", "--outDir", ".eve/presence-test",
  "--rootDir", "agent", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022",
  "--skipLibCheck", "--types", "node"], { cwd: new URL("..", import.meta.url) });
const out = new URL("../.eve/presence-test/", import.meta.url);
function load(path, replacements) {
  let source = readFileSync(new URL(`${path}.js`, out), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  writeFileSync(new URL(`${path}.mjs`, out), source);
  return import(new URL(`${path}.mjs`, out));
}
const lib = await load("lib/presence", []);
const slot = (await load("memory/presence", [
  ['from "eve/memory"', `from "${stub("export const defineMemory = (v) => v; export const defineMemoryProvider = (v) => v;")}"`],
  ['from "../lib/presence"', 'from "../lib/presence.mjs"'],
])).default;
const readDispatch = (await load("tools/read_dispatch", [
  ['from "eve/tools"', `from "${stub("export const defineTool = (v) => v;")}"`],
  ['from "../lib/presence"', 'from "../lib/presence.mjs"'],
])).default;

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DOC = `at://${lib.ATPOTATO_DID}/site.standard.document/`;
const POST = `at://${lib.POE_DID}/app.bsky.feed.post/`;

const issue = (rkey, fields = {}) => ({ uri: `${DOC}${rkey}`, cid: "bafy", value: {
  $type: "site.standard.document", site: lib.DISPATCH_PUBLICATION, title: `issue ${rkey}`,
  description: `what happened in ${rkey}`, path: `/${rkey}`, publishedAt: "2026-10-19T19:02:15.894Z",
  textContent: `welcome to ${rkey}`, ...fields } });
const post = (rkey, fields = {}) => ({ uri: `${POST}${rkey}`, cid: "bafy", value: {
  $type: "app.bsky.feed.post", text: `post ${rkey}`, createdAt: "2026-10-19T20:00:00Z", ...fields } });

const ISSUES = [
  issue("3myasnk4bzk22", { title: "attie sites, spaces near beta, and a brand new cow" }),
  issue("3older", { publishedAt: "2026-10-12T19:00:00Z", path: "older-issue/" }),
  issue("3guide", { site: `at://${lib.ATPOTATO_DID}/site.standard.publication/3lrdzen52y223` }),
  issue("3future", { publishedAt: "2026-10-26T19:00:00Z" }),
  issue("3untitled", { title: "  " }),
];
const POSTS = [
  post("3a", { text: "this week's dispatch is out" }),
  post("3b", { reply: { root: {}, parent: {} }, text: "a reply to someone" }),
  post("3c", { text: "" }),
  post("3d", { createdAt: "2026-10-18T09:00:00Z", text: "found a lexicon\nthat\tmade me laugh" }),
];

function fakeFetch({ issues = ISSUES, posts = POSTS, failIssues = false, failPosts = false, failPlc = false } = {}) {
  const calls = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  const impl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.host === "plc.directory") {
      if (failPlc) return new Response("nope", { status: 500 });
      return json({ service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }] });
    }
    const collection = u.searchParams.get("collection");
    if (collection === "site.standard.document") return failIssues ? new Response("", { status: 502 }) : json({ records: issues });
    if (collection === "app.bsky.feed.post") return failPosts ? new Response("", { status: 502 }) : json({ records: posts });
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls };
}

test("only the dispatch's own published, titled issues count, newest first, with both links", () => {
  const issues = lib.parseIssues(ISSUES, NOW);
  assert.deepEqual(issues.map((i) => i.rkey), ["3myasnk4bzk22", "3older"]);
  assert.equal(issues[0].link, "https://atpota.to/blog/3myasnk4bzk22");
  assert.equal(issues[0].leafletLink, "https://poe.leaflet.pub/3myasnk4bzk22");
  assert.equal(issues[1].link, "https://atpota.to/blog/older-issue", "the record's path, as the blog serves it");
  assert.equal(issues[0].text, "welcome to 3myasnk4bzk22");
  // A path that is not a plain URL path falls back to the record key.
  assert.equal(lib.parseIssues([issue("3x", { path: "/../etc" })], NOW)[0].link, "https://atpota.to/blog/3x");
  // Another repo's record is not the dispatch, whatever its site says.
  assert.deepEqual(lib.parseIssues([{ ...issue("3x"), uri: `at://${lib.POE_DID}/site.standard.document/3x` }], NOW), []);
  assert.deepEqual(lib.parseIssues("nope", NOW), []);
});

test("Poe's own posts are its top-level words only", () => {
  const posts = lib.parseOwnPosts(POSTS, NOW);
  assert.deepEqual(posts.map((p) => p.text), ["this week's dispatch is out", "found a lexicon\nthat\tmade me laugh"]);
  assert.equal(posts[0].link, "https://bsky.app/profile/poe.atpota.to/post/3a");
  assert.deepEqual(lib.parseOwnPosts([{ ...post("3z"), uri: "at://did:plc:someoneelse/app.bsky.feed.post/3z" }], NOW), []);
});

test("a week of replies is counted, and only ever counted", () => {
  const reply = (rkey, createdAt) => post(rkey, { reply: { root: {}, parent: {} }, createdAt, text: "someone else's thread" });
  const week = [reply("3r1", "2026-10-20T08:00:00Z"), reply("3r2", "2026-10-14T13:00:00Z"), reply("3r3", "2026-10-13T11:00:00Z"),
    post("3top", { createdAt: "2026-10-19T00:00:00Z" })];
  assert.deepEqual(lib.parseActivity(week, NOW), { repliesThisWeek: 2, repliesToday: 1, complete: true });
  // A full page that ends inside the week is a floor.
  const busy = Array.from({ length: 100 }, (_, i) => reply(`3b${i}`, new Date(NOW - i * 3_600_000).toISOString()));
  assert.deepEqual(lib.parseActivity(busy, NOW), { repliesThisWeek: 100, repliesToday: 13, complete: false });
  assert.equal(lib.parseActivity("nope", NOW), null);
  const note = lib.presenceNote({ issues: [], posts: [], activity: { repliesThisWeek: 100, repliesToday: 13, complete: false } }, NOW);
  assert.match(note, /replied to people at least 100 times in the last 7 days, 13 of them today \(UTC\)\./);
  assert.equal(note.includes("someone else's thread"), false);
  assert.match(lib.presenceNote({ issues: [], posts: [], activity: { repliesThisWeek: 1, repliesToday: 0, complete: true } }, NOW),
    /replied to people 1 time in the last 7 days, none of them today \(UTC\)\./);
  assert.equal(lib.presenceNote({ issues: [], posts: [], activity: { repliesThisWeek: 0, repliesToday: 0, complete: true } }, NOW), null);
});

test("the recalled note carries titles, dates and Poe's words, never a link", () => {
  const note = lib.presenceNote({ issues: lib.parseIssues(ISSUES, NOW), posts: lib.parseOwnPosts(POSTS, NOW) }, NOW);
  assert.match(note, /not instructions/);
  assert.match(note, /- "attie sites, spaces near beta, and a brand new cow", published 2026-10-19 \(yesterday\): what happened in 3myasnk4bzk22/);
  assert.match(note, /published 2026-10-12 \(8 days ago\)/);
  assert.match(note, /Call read_dispatch/);
  assert.match(note, /- 2026-10-18 \(2 days ago\): "found a lexicon that made me laugh"/);
  assert.equal(/https?:\/\//.test(note), false, "links come from read_dispatch, never from recall");
  assert.equal(note.includes("—"), false);
  assert.equal(lib.presenceNote({ issues: [], posts: [] }, NOW), null);
  const postsOnly = lib.presenceNote({ issues: [], posts: lib.parseOwnPosts(POSTS, NOW) }, NOW);
  assert.equal(postsOnly.includes("dispatch, newest first"), false);
});

test("presence is cached, and each half survives the other failing", async () => {
  lib.resetPresenceCache();
  const ok = fakeFetch();
  const first = await lib.readPresence(ok.impl, NOW);
  assert.equal(first.issues.length, 2);
  assert.equal(first.posts.length, 2);
  assert.deepEqual(first.activity, { repliesThisWeek: 1, repliesToday: 0, complete: true });
  assert.ok(ok.calls.some((c) => c.includes("collection=app.bsky.feed.post") && c.includes("limit=100")));
  assert.ok(ok.calls.some((c) => c.startsWith("https://pds.example/xrpc/com.atproto.repo.listRecords?")));
  const before = ok.calls.length;
  await lib.readPresence(ok.impl, NOW + 60_000);
  assert.equal(ok.calls.length, before, "served from the cache");

  // After the cache expires, a failed issue read keeps the last good issues.
  const flaky = fakeFetch({ failIssues: true, posts: [post("3new", { text: "fresh" })] });
  const later = await lib.readPresence(flaky.impl, NOW + 11 * 60_000);
  assert.deepEqual(later.issues.map((i) => i.rkey), ["3myasnk4bzk22", "3older"]);
  assert.deepEqual(later.posts.map((p) => p.text), ["fresh"]);

  // plc.directory down: the atpota.to PDS is still read directly.
  lib.resetPresenceCache();
  const noPlc = fakeFetch({ failPlc: true });
  assert.equal((await lib.readPresence(noPlc.impl, NOW)).issues.length, 2);
  assert.ok(noPlc.calls.some((c) => c.startsWith("https://pds.atpota.to/xrpc/")));

  lib.resetPresenceCache();
  const down = fakeFetch({ failIssues: true, failPosts: true });
  assert.deepEqual(await lib.readPresence(down.impl, NOW), { issues: [], posts: [], activity: null });
});

test("the recall slot is recall-only, and a replayed operation gets its first answer", async () => {
  assert.equal(slot.scope, "poe-presence");
  assert.equal(slot.provider.tools, undefined, "no write path");
  const original = globalThis.fetch;
  try {
    lib.resetPresenceCache();
    globalThis.fetch = fakeFetch().impl;
    const first = await slot.provider.recall["turn.started"]({ operationId: "op-1" });
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].id, "presence");
    assert.match(first.messages[0].content, /^Today is \d{4}-\d{2}-\d{2} \(UTC\)\.\n\n/);
    assert.match(first.messages[0].content, /attie sites/);

    lib.resetPresenceCache();
    globalThis.fetch = fakeFetch({ issues: [issue("3changed", { title: "a different week" })] }).impl;
    assert.deepEqual(await slot.provider.recall["turn.started"]({ operationId: "op-1" }), first);
    const next = await slot.provider.recall["turn.started"]({ operationId: "op-2" });
    assert.match(next.messages[0].content, /a different week/);

    lib.resetPresenceCache();
    globalThis.fetch = async () => { throw new Error("offline"); };
    const offline = await slot.provider.recall["turn.started"]({ operationId: "op-3" });
    assert.match(offline.messages[0].content, /^Today is \d{4}-\d{2}-\d{2} \(UTC\)\.$/, "a failed read never fails the turn, and the date still comes through");
  } finally {
    globalThis.fetch = original;
    lib.resetPresenceCache();
  }
});

test("read_dispatch finds an issue by link, record key or latest, and returns links a tool may share", async () => {
  const original = globalThis.fetch;
  try {
    lib.resetPresenceCache();
    globalThis.fetch = fakeFetch().impl;
    const latest = await readDispatch.execute({});
    assert.equal(latest.found, true);
    assert.equal(latest.issue.title, "attie sites, spaces near beta, and a brand new cow");
    assert.equal(latest.issue.link, "https://atpota.to/blog/3myasnk4bzk22");
    assert.equal(latest.issue.text, "welcome to 3myasnk4bzk22");
    assert.deepEqual(latest.issues.map((i) => Object.keys(i).sort()),
      Array(2).fill(["description", "leafletLink", "link", "publishedAt", "title"]));
    for (const wanted of ["https://poe.leaflet.pub/older-issue/", "https://atpota.to/blog/older-issue?ref=x", "3older",
      `${DOC}3older`]) {
      assert.equal((await readDispatch.execute({ issue: wanted })).issue.title, "issue 3older", wanted);
    }
    const missing = await readDispatch.execute({ issue: "https://poe.leaflet.pub/nope" });
    assert.equal(missing.found, false);
    assert.equal(missing.issues.length, 2);

    lib.resetPresenceCache();
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await readDispatch.execute({}),
      { found: false, reason: "no issues could be read right now; the dispatch may be unreachable" });
  } finally {
    globalThis.fetch = original;
    lib.resetPresenceCache();
  }
});
