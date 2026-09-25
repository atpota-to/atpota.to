import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/bluesky.ts",
  "--outDir", ".eve/bluesky-test", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const { MentionEvent, buildPrompt } = await import("../.eve/bluesky-test/bluesky.js");

const currentDid = "did:plc:bailey";
const thread = [{
  author: "brookie.blog",
  authorDid: "did:plc:brookie",
  you: false,
  text: "how many voted for me?",
}];
const event = {
  threadRoot: "at://did:plc:root/app.bsky.feed.post/root",
  postUri: "at://did:plc:bailey/app.bsky.feed.post/reply",
  authorDid: currentDid,
  authorHandle: "pds.dad",
  text: "how many votes do I have?",
  reason: "reply",
  attempt: 1,
  thread,
};

test("thread context can carry stable author DIDs while remaining backward compatible", () => {
  assert.equal(MentionEvent.safeParse(event).success, true);
  const legacy = { ...event, thread: [{ author: "brookie.blog", you: false, text: "hi" }] };
  assert.equal(MentionEvent.safeParse(legacy).success, true);
  assert.equal(MentionEvent.safeParse({ ...event, thread: [{ ...thread[0], authorDid: "brookie.blog" }] }).success, false);
});

test("the prompt binds this turn to its author and forbids transferring another participant's facts", () => {
  const prompt = buildPrompt(event);
  assert.match(prompt, /@pds\.dad \(did:plc:bailey\)/);
  assert.match(prompt, /@brookie\.blog \(did:plc:brookie\)/);
  assert.match(prompt, /Never transfer them to the/);
  assert.match(prompt, /look it up again using their DID above/);
});

test("the Bluesky workflow requires cursor exhaustion and honest partial results", () => {
  const skill = readFileSync(new URL("../agent/skills/bluesky-reply.md", import.meta.url), "utf8");
  assert.match(skill, /until there is no cursor left/);
  assert.match(skill, /label any count as partial/);
  assert.match(skill, /promise to continue later/);
  assert.match(skill, /post status updates instead of the answer/);
});
