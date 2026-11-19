import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// The journals on eve's in-memory backend (no VERCEL in the environment), with
// the droplet's backup log faked by a stubbed fetch where it matters.
const OUT = new URL("../.eve/journal-test/", import.meta.url);
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/journal.ts",
  "--outDir", ".eve/journal-test", "--rootDir", "agent/lib", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
for (const file of readdirSync(OUT).filter((f) => f.endsWith(".js"))) {
  const path = new URL(file, OUT);
  writeFileSync(path, readFileSync(path, "utf8").replaceAll(/from "(\.\/[^"]+?)(?<!\.js)"/g, 'from "$1.js"'));
}
const journal = await import(new URL("journal.js", OUT));
const memory = await import(new URL("published-memory.js", OUT));

const abortSignal = new AbortController().signal;
const turn = (key, said = "", operationId = `op-${Math.random()}`) => ({
  memory: { scope: { key, namespace: "n", value: "poe-life" }, slot: "life" },
  abortSignal, operationId, messages: [],
  turn: { id: "t", sequence: 0, input: said ? [{ role: "user", content: [{ type: "text", text: said }] }] : [] },
});

test("a note's month comes from its date, and words leave out the commonest ones", () => {
  assert.equal(journal.monthOf("[2026-10-21] saw a storm"), "2026-10");
  assert.equal(journal.monthOf("saw a storm before dates were kept"), "undated");
  assert.deepEqual([...journal.wordsOf("[2026-10-21] Poe saw the TANGLED.sh storm, and it was gusty!")].sort(),
    ["gusty", "saw", "storm", "tangled.sh"]);
});

test("related notes share the rarest words with what was said, newest first among equals", () => {
  const notes = [
    "[2026-09-01] watched the relay hiccup again",
    "[2026-09-02] tangled launched knots and i cheered",
    "[2026-09-03] a quiet day on the roof",
    "[2026-09-04] tangled shipped stars, the relay held up",
  ];
  assert.deepEqual(journal.relatedNotes(notes, "what happened with tangled knots?"),
    [notes[1], notes[3]]);
  assert.deepEqual(journal.relatedNotes(notes, "hello there!"), []);
  assert.deepEqual(journal.relatedNotes(notes, "the relay", 1), [notes[3]]);
});

test("a full journal moves its oldest notes to the archive instead of refusing, and loses nothing", async () => {
  const provider = journal.journalMemory();
  const key = "full-life";
  const tools = await provider.tools(turn(key));
  const saved = [];
  for (let i = 0; i < 120; i++) {
    const text = `found something new today, number ${i}, `.padEnd(150, "x");
    const answer = await tools.save_memory.execute({ text }, { abortSignal });
    assert.match(answer, /^Saved as note \d+\./);
    saved.push(text);
  }
  const current = await memory.readNotes(key, abortSignal);
  const { archive } = await journal.readArchive(key, abortSignal);
  const archived = journal.archivedNotes(archive);
  assert.ok(archived.length > 0, "something was archived");
  assert.ok(current.length < 120, "the journal itself stayed within its room");
  const everything = [...archived, ...current.map((n) => n.text)].map((n) => n.replace(/^\[\d{4}-\d{2}-\d{2}\] /, ""));
  assert.deepEqual(everything.sort(), saved.map((t) => t.trim()).sort(), "every note is in one place or the other");
  // The newest note is always in the journal, the oldest in the archive.
  assert.ok(current.some((n) => n.text.includes("number 119,")));
  assert.ok(archived.some((n) => n.includes("number 0,")));
  // Indices keep counting: a removed or archived note's number is never reused.
  assert.equal(Math.max(...current.map((n) => n.index)), 119);
});

test("recall adds the archive's month summaries and the older notes that relate to what was said", async () => {
  const provider = journal.journalMemory();
  const key = "recall-life";
  const tools = await provider.tools(turn(key));
  await tools.save_memory.execute({ text: "a calm morning on the roof" }, { abortSignal });
  await journal.updateArchive(key, abortSignal, (archive) => {
    journal.fileNotes(archive, ["[2026-09-12] tangled launched knots and i cheered", "[2026-09-13] a dull relay day"]);
    archive.months["2026-09"].summary = "a month of launches";
    return true;
  });
  const withRelated = await provider.recall["turn.started"](turn(key, "did tangled ever ship knots?"));
  const archivePart = withRelated.messages.find((m) => m.id === "journal-archive");
  assert.ok(archivePart, "the archive is recalled");
  assert.match(archivePart.content, /2026-09: a month of launches/);
  assert.match(archivePart.content, /tangled launched knots/);
  assert.doesNotMatch(archivePart.content, /dull relay day/);
  assert.match(withRelated.messages[0].content, /calm morning on the roof/);

  // Nothing related and no summaries: no archive message at all.
  const quietKey = "quiet-life";
  await journal.updateArchive(quietKey, abortSignal, (archive) => journal.fileNotes(archive, ["[2026-09-13] a dull relay day"]));
  const quiet = await provider.recall["turn.started"](turn(quietKey, "hello!"));
  assert.equal(quiet?.messages.some((m) => m.id === "journal-archive") ?? false, false);

  // A replay of the same recall gets the same answer even after the archive changes.
  const replayed = turn(key, "did tangled ever ship knots?", "op-replay");
  const first = await provider.recall["turn.started"](replayed);
  await journal.updateArchive(key, abortSignal, (archive) => journal.fileNotes(archive, ["[2026-09-14] tangled knots again"]));
  assert.deepEqual(await provider.recall["turn.started"](replayed), first);
});

test("rollups summarise each finished month once, again only when it grows, and never the current one", async () => {
  const key = "rollup-life";
  const now = Date.parse("2026-11-02T04:00:00Z");
  await journal.updateArchive(key, abortSignal, (archive) => journal.fileNotes(archive,
    ["[2026-09-01] september one", "[2026-09-02] september two", "old undated note"]));
  // An October note still in the journal itself counts toward October.
  await memory.memoryStore.write({ key, signal: abortSignal, expectedVersion: null,
    content: memory.formatNotes(1, [{ index: 0, text: "[2026-10-30] october in the journal" }, { index: 1, text: "[2026-11-01] november" }]) });
  const asked = [];
  const summarize = async (month, notes) => (asked.push([month, notes.length]), `summary of ${month}`);
  assert.deepEqual(await journal.rollUp(key, "life", "poe-life", abortSignal, summarize, now), ["2026-09", "2026-10"]);
  assert.deepEqual(asked, [["2026-09", 2], ["2026-10", 1]]);
  const { archive } = await journal.readArchive(key, abortSignal);
  assert.equal(archive.months["2026-09"].summary, "summary of 2026-09");
  assert.equal(archive.months["2026-10"].summary, "summary of 2026-10");
  assert.equal(archive.months["2026-11"], undefined, "the current month waits");
  assert.equal(archive.months.undated.summary, undefined, "undated notes have no month to summarise");

  asked.length = 0;
  assert.deepEqual(await journal.rollUp(key, "life", "poe-life", abortSignal, summarize, now), [], "nothing new");
  await journal.updateArchive(key, abortSignal, (a) => journal.fileNotes(a, ["[2026-09-03] a late september note"]));
  assert.deepEqual(await journal.rollUp(key, "life", "poe-life", abortSignal, summarize, now), ["2026-09"]);
  assert.deepEqual(asked, [["2026-09", 3]]);
});

test("every private write is handed to the droplet's backup log, with its slot and scope", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(null, { status: 202 });
  };
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/callback";
  process.env.DROPLET_SHARED_SECRET = "droplet-secret";
  try {
    const tools = await memory.privateFileMemory().tools({
      memory: { scope: { key: "logged-notes", namespace: "n", value: "did:plc:operator" }, slot: "operator-notes" },
      abortSignal, turn: { id: "t", input: [], sequence: 0 },
    });
    await tools.save_memory.execute({ text: "likes short answers" }, { abortSignal });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://droplet.example/memory");
    assert.equal(sent[0].headers["x-atpotato-secret"], "droplet-secret");
    const { log } = sent[0].body;
    assert.equal(log.slot, "operator-notes");
    assert.equal(log.scope, "did:plc:operator");
    assert.equal(log.source, "poe");
    assert.match(log.content, /0: \[\d{4}-\d{2}-\d{2}\] likes short answers/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DROPLET_CALLBACK_URL;
    delete process.env.DROPLET_SHARED_SECRET;
  }
});
