import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// Poe's memory read and changed outside a turn, on eve's in-memory backend,
// with the droplet faked by a stubbed fetch.
const OUT = new URL("../.eve/memory-admin-test/", import.meta.url);
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/memory-admin.ts",
  "--outDir", ".eve/memory-admin-test", "--rootDir", "agent/lib", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
for (const file of readdirSync(OUT).filter((f) => f.endsWith(".js"))) {
  const path = new URL(file, OUT);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(/from "(\.\/[^"]+?)(?<!\.js)"/g, 'from "$1.js"'));
}
const admin = await import(new URL("memory-admin.js", OUT));
const journal = await import(new URL("journal.js", OUT));
const keys = await import(new URL("memory-key.js", OUT));
const { personScope } = await import(new URL("person-scope.js", OUT));
const memory = await import(new URL("published-memory.js", OUT));

const signal = new AbortController().signal;
const ADMIN = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const PERSON = "did:plc:cccccccccccccccccccccccc";

function droplet() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 202 });
  };
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "droplet-secret";
  return {
    sent,
    restore() {
      globalThis.fetch = realFetch;
      delete process.env.DROPLET_CALLBACK_URL;
      delete process.env.DROPLET_SHARED_SECRET;
    },
  };
}

test("the admin secret fails closed, and is refused when it is one of the other secrets", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ADMIN_SHARED_SECRET;
    assert.equal(admin.adminSecretMatches("anything"), false);
    process.env.ADMIN_SHARED_SECRET = "admin-secret";
    assert.equal(admin.adminSecretMatches("admin-secret"), true);
    assert.equal(admin.adminSecretMatches("admin-secreT"), false);
    assert.equal(admin.adminSecretMatches(null), false);
    process.env.WEBSITE_SHARED_SECRET = "admin-secret";
    assert.equal(admin.adminSecretMatches("admin-secret"), false, "never the website's chat secret");
    delete process.env.WEBSITE_SHARED_SECRET;
    process.env.DROPLET_SHARED_SECRET = "admin-secret";
    assert.equal(admin.adminSecretMatches("admin-secret"), false, "never the droplet's");
  } finally {
    process.env = saved;
  }
});

test("admin calls are strict about their shape", () => {
  assert.equal(admin.AdminCall.safeParse({ action: "overview", by: ADMIN, operators: [OPERATOR] }).success, true);
  assert.equal(admin.AdminCall.safeParse({ action: "overview", by: ADMIN, operators: [], extra: 1 }).success, false);
  assert.equal(admin.AdminCall.safeParse({ action: "add", by: ADMIN, slot: "secrets", text: "x" }).success, false);
  assert.equal(admin.AdminCall.safeParse({ action: "add", by: "not-a-did", slot: "self", text: "x" }).success, false);
  assert.equal(admin.AdminCall.safeParse({ action: "drop", by: ADMIN }).success, false);
});

test("an admin can add, edit, remove and restore private notes, and every version is logged as theirs", async () => {
  const fake = droplet();
  try {
    const call = (c) => admin.runAdminCall({ by: ADMIN, ...c }, signal);
    let self = await call({ action: "add", slot: "self", text: "loves   gusty days" });
    assert.match(self.notes[0].text, /^\[\d{4}-\d{2}-\d{2}\] loves gusty days$/);
    const day = self.notes[0].text.slice(0, 13);
    self = await call({ action: "add", slot: "self", text: "a second fact" });
    self = await call({ action: "edit", slot: "self", index: 0, text: "loves stormy days" });
    assert.equal(self.notes[0].text, `${day}loves stormy days`, "an edit keeps the day it was first saved");
    const before = memory.formatNotes(1, self.notes);
    self = await call({ action: "remove", slot: "self", index: 1 });
    assert.deepEqual(self.notes.map((n) => n.index), [0]);
    await assert.rejects(call({ action: "remove", slot: "self", index: 9 }), (err) => err.status === 404);
    self = await call({ action: "restore", slot: "self", content: before });
    assert.deepEqual(self.notes.map((n) => n.index), [0, 1]);
    // A note added after a restore never takes an old number.
    self = await call({ action: "add", slot: "self", text: "third" });
    assert.equal(self.notes.at(-1).index, 2);

    const logs = fake.sent.filter((s) => s.body.log);
    assert.equal(logs.length, 6);
    assert.ok(logs.every((s) => s.body.log.slot === "self" && s.body.log.scope === "poe-self" && s.body.log.source === `admin:${ADMIN}`));
    assert.equal(logs.at(-1).body.log.content, memory.formatNotes(2, self.notes));

    await assert.rejects(call({ action: "restore", slot: "self", content: "not a memory document" }), (err) => err.status === 400);
    await assert.rejects(call({ action: "add", slot: "operator-notes", text: "no did" }), (err) => err.status === 400);
  } finally {
    fake.restore();
  }
});

test("person notes edited by an admin follow the repo's rules and go to the droplet to publish", async () => {
  const fake = droplet();
  try {
    const person = await admin.runAdminCall({ action: "add", by: ADMIN, slot: "person", did: PERSON, text: "builds feeds" }, signal);
    assert.deepEqual(person.notes, [{ index: 0, text: "builds feeds" }], "person notes are never dated");
    await assert.rejects(admin.runAdminCall({ action: "add", by: ADMIN, slot: "person", did: PERSON, text: "see https://x.example" }, signal),
      (err) => err.status === 400 && /link/.test(err.message));
    assert.deepEqual(fake.sent.map((s) => [s.url, s.body.did]), [["https://droplet.example/memory", PERSON]]);
    assert.equal(fake.sent.some((s) => s.body.log), false, "the droplet logs person notes itself");
    // The same document the person slot recalls.
    assert.match((await memory.readNotes(keys.slotKey("person", personScope(PERSON)), signal))[0].text, /builds feeds/);
  } finally {
    fake.restore();
  }
});

test("the overview shows every shared slot, each operator's notes, and the journals' archives", async () => {
  await admin.runAdminCall({ action: "add", by: ADMIN, slot: "operator-notes", did: OPERATOR, text: "likes short answers" }, signal);
  await admin.runAdminCall({ action: "add", by: ADMIN, slot: "life", text: "watched a storm" }, signal);
  await journal.updateArchive(keys.slotKey("life", "poe-life"), signal, (a) => journal.fileNotes(a, ["[2026-09-01] old storm"]));
  const { slots } = await admin.runAdminCall({ action: "overview", by: ADMIN, operators: [OPERATOR, OPERATOR] }, signal);
  assert.deepEqual(slots.map((s) => `${s.slot}:${s.scope}`),
    ["life:poe-life", "operator-dm-life:poe-operator-dm-life", "self:poe-self", `operator-notes:${OPERATOR}`]);
  const life = slots[0];
  assert.match(life.notes.at(-1).text, /watched a storm/);
  assert.deepEqual(life.archive, [{ month: "2026-09", notes: ["[2026-09-01] old storm"], summary: null }]);
  assert.match(slots[3].notes[0].text, /likes short answers/);
  assert.ok(life.about.length > 0);

  const after = await admin.runAdminCall({ action: "remove-archived", by: ADMIN, slot: "life", month: "2026-09", text: "[2026-09-01] old storm" }, signal);
  assert.deepEqual(after.archive, [{ month: "2026-09", notes: [], summary: null }]);
  await assert.rejects(admin.runAdminCall({ action: "remove-archived", by: ADMIN, slot: "self", month: "2026-09", text: "x" }, signal),
    (err) => err.status === 400);
});

test("a journal note mentions someone by DID or handle, not by a word that happens to contain it", () => {
  assert.equal(admin.mentions("[2026-10-01] talked to did:plc:cccccccccccccccccccccccc", PERSON, null), true);
  assert.equal(admin.mentions("[2026-10-01] @alice.bsky.social showed me knots", PERSON, "alice.bsky.social"), true);
  assert.equal(admin.mentions("alice.bsky.social. what a day", PERSON, "@alice.bsky.social"), true);
  assert.equal(admin.mentions("malice.bsky.social is someone else", PERSON, "alice.bsky.social"), false);
  assert.equal(admin.mentions("alice.bsky.socialite", PERSON, "alice.bsky.social"), false);
  assert.equal(admin.mentions("alice said hi", PERSON, "alice"), false, "a bare word is never treated as a handle");
});

test("forget wipes the person's notes and every journal note naming them, archived ones too", async () => {
  const fake = droplet();
  try {
    const did = "did:plc:dddddddddddddddddddddddd";
    await admin.runAdminCall({ action: "add", by: ADMIN, slot: "person", did, text: "builds labelers" }, signal);
    await admin.runAdminCall({ action: "add", by: ADMIN, slot: "life", text: "dave.example.com showed me a labeler" }, signal);
    await admin.runAdminCall({ action: "add", by: ADMIN, slot: "life", text: "a quiet afternoon" }, signal);
    const lifeKey = keys.slotKey("life", "poe-life");
    await journal.updateArchive(lifeKey, signal, (a) => {
      journal.fileNotes(a, ["[2026-09-02] met @dave.example.com", "[2026-09-03] nobody in particular"]);
      a.months["2026-09"].summary = "met dave.example.com";
      a.months["2026-09"].summarizedNotes = 2;
      return true;
    });
    const result = await admin.forgetEverywhere(did, "dave.example.com", signal);
    assert.equal(result.hadNotes, true);
    assert.equal(result.journalNotesRemoved, 2);
    assert.deepEqual(await memory.readNotes(keys.slotKey("person", personScope(did)), signal), []);
    const life = (await memory.readNotes(lifeKey, signal)).map((n) => n.text).join("\n");
    assert.doesNotMatch(life, /dave/);
    assert.match(life, /a quiet afternoon/);
    const { archive } = await journal.readArchive(lifeKey, signal);
    assert.deepEqual(archive.months["2026-09"].notes, ["[2026-09-03] nobody in particular"]);
    assert.equal(archive.months["2026-09"].summary, undefined, "a summary that may name them is dropped until the next rollup");
  } finally {
    fake.restore();
  }
});

test("rollups run for both journals", async () => {
  const lifeKey = keys.slotKey("life", "poe-life");
  const dmKey = keys.slotKey("operator-dm-life", "poe-operator-dm-life");
  await journal.updateArchive(lifeKey, signal, (a) => journal.fileNotes(a, ["[2026-08-01] august in public"]));
  await journal.updateArchive(dmKey, signal, (a) => journal.fileNotes(a, ["[2026-08-02] august in dms"]));
  const asked = [];
  const done = await admin.rollUpJournals(async (j, month) => (asked.push(`${j}:${month}`), "a month"), signal, Date.parse("2026-11-02T00:00:00Z"));
  assert.ok(done.life.includes("2026-08"));
  assert.deepEqual(done["operator-dm-life"], ["2026-08"]);
  assert.ok(asked.includes("operator-dm-life:2026-08"));
});

test("the snapshot hands over every private document once, with the journals' archives and the old dispatch notes", async () => {
  const legacyKey = keys.slotKey("dispatch-notes", "poe-dispatch-notes");
  await memory.memoryStore.write({ key: legacyKey, signal, expectedVersion: null,
    content: memory.formatNotes(0, [{ index: 0, text: "[2026-11-02] give the headliner its own heading" }]) });
  const docs = await admin.snapshotDocs([OPERATOR, "not-a-did"], signal);
  const names = docs.map((d) => `${d.slot}:${d.scope}`);
  for (const name of ["life:poe-life", "life:archive:poe-life", "self:poe-self", `operator-notes:${OPERATOR}`, "dispatch-notes:poe-dispatch-notes"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.some((n) => n.includes("not-a-did")));
  assert.match(docs.find((d) => d.slot === "dispatch-notes").content, /headliner/);
});
