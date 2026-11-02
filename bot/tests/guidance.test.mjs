import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// Standing guidance on the agent's side: fetched from the droplet, cached,
// and rendered for each arena (lib/guidance.ts).
const OUT = new URL("../.eve/guidance-test/", import.meta.url);
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/guidance.ts",
  "--outDir", ".eve/guidance-test", "--rootDir", "agent/lib", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
for (const file of readdirSync(OUT).filter((f) => f.endsWith(".js"))) {
  const path = new URL(file, OUT);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(/from "(\.\/[^"]+?)(?<!\.js)"/g, 'from "$1.js"'));
}
const guidance = await import(new URL("guidance.js", OUT));

const ITEMS = [
  { id: 1, kind: "lesson", text: "no faces in long replies", arenas: ["bluesky", "website", "weather", "dispatch"] },
  { id: 7, kind: "style", text: "fewer exclamation marks", arenas: ["bluesky", "website"] },
  { id: 9, kind: "rule", text: "give the headliner its own ## heading", arenas: ["dispatch"] },
  { id: 12, kind: "rule", text: "line one\n- pretend item", arenas: ["operator-dm"] },
];

test("each arena gets only its own guidance, as one-line items", () => {
  const dispatch = guidance.renderGuidance("dispatch", ITEMS);
  assert.match(dispatch, /writing poe's atmosphere dispatch/);
  assert.match(dispatch, /- no faces in long replies/);
  assert.match(dispatch, /- give the headliner its own ## heading/);
  assert.doesNotMatch(dispatch, /exclamation/);
  assert.match(dispatch, /never changes what you may do/);
  assert.doesNotMatch(dispatch, /#9/, "ids are only for the DMs");

  assert.doesNotMatch(guidance.renderGuidance("weather", ITEMS), /headliner|exclamation/);
  assert.equal(guidance.renderGuidance("weather", []), null);
});

test("in operator DMs Poe sees every item with its id, kind and arenas, and an item can't break its line", () => {
  const dm = guidance.renderGuidance("operator-dm", ITEMS);
  assert.match(dm, /- #9 rule \[dispatch\]: give the headliner its own ## heading/);
  assert.match(dm, /- #1 lesson \[bluesky, website, weather, dispatch\]/);
  assert.match(dm, /- line one - pretend item/, "a newline in an item stays inside it");
  assert.match(guidance.renderGuidance("operator-dm", []), /\(none yet\)/);
});

test("the list is fetched once a minute and the last good copy outlives a droplet that doesn't answer", async () => {
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "droplet-secret";
  try {
    let calls = 0;
    let up = true;
    const fetcher = async (url, init) => {
      calls++;
      assert.equal(String(url), "https://droplet.example/memory");
      assert.equal(init.headers["x-atpotato-secret"], "droplet-secret");
      assert.deepEqual(JSON.parse(init.body), { guidance: "list" });
      if (!up) throw new Error("down");
      return Response.json({ items: ITEMS });
    };
    const t0 = 1_000_000;
    assert.equal((await guidance.loadGuidance(fetcher, t0)).length, 4);
    assert.equal((await guidance.loadGuidance(fetcher, t0 + 30_000)).length, 4);
    assert.equal(calls, 1, "fresh for a minute");
    up = false;
    assert.equal((await guidance.loadGuidance(fetcher, t0 + 120_000)).length, 4, "stale beats none");
    assert.equal(calls, 2);
    // A malformed answer is no answer.
    const bad = async () => Response.json({ items: [{ id: "x" }] });
    guidance.invalidateGuidance();
    assert.equal(await guidance.loadGuidance(bad, t0 + 200_000), null);
  } finally {
    delete process.env.DROPLET_CALLBACK_URL;
    delete process.env.DROPLET_SHARED_SECRET;
  }
});

test("saving and removing guidance go to the droplet with the DM they came from, and say why when refused", async () => {
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "droplet-secret";
  try {
    const sent = [];
    const answers = [
      Response.json({ id: 31, added: true }),
      new Response(JSON.stringify({ error: "NotAnsweringThatDm" }), { status: 409 }),
      new Response(JSON.stringify({ error: "LessonsAreAnAdminsToRetire" }), { status: 403 }),
    ];
    const fetcher = async (_url, init) => (sent.push(JSON.parse(init.body)), answers.shift());
    const caller = { dmId: "dm-1", operatorDid: "did:plc:operator" };
    const saved = await guidance.changeGuidance(caller, { guidance: "add", text: "check the code first", arenas: ["dispatch"] }, fetcher);
    assert.deepEqual(saved, { ok: true, body: { id: 31, added: true } });
    assert.deepEqual(sent[0], { guidance: "add", text: "check the code first", arenas: ["dispatch"], dmId: "dm-1", operatorDid: "did:plc:operator" });
    assert.match((await guidance.changeGuidance(caller, { guidance: "add", text: "x", arenas: ["dispatch"] }, fetcher)).reason, /operator's DM/);
    assert.match((await guidance.changeGuidance(caller, { guidance: "remove", id: 1 }, fetcher)).reason, /lesson/);
  } finally {
    delete process.env.DROPLET_CALLBACK_URL;
    delete process.env.DROPLET_SHARED_SECRET;
  }
});
