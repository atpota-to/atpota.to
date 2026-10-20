import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// "Forget me" finds a person's notes by working out eve's key itself, outside
// any turn. Run against eve's own derivation, so an eve upgrade that changes
// it fails here rather than quietly leaving the notes of everyone who asked to
// be forgotten where they were. Then forgetNotes runs for real, on eve's
// in-memory backend (no VERCEL in the environment), with the droplet faked.
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/published-memory.ts",
  "--outDir", ".eve/memory-key-test", "--rootDir", "agent", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const out = new URL("../.eve/memory-key-test/lib/", import.meta.url);
for (const [file, from, to] of [
  ["memory-key", '"./person-scope"', '"./person-scope.js"'],
  ["published-memory", '"./memory-key"', '"./memory-key.js"'],
]) {
  const path = new URL(`${file}.js`, out);
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}
const { memoryKey, personNotesKey, PERSON_SLOT } = await import(new URL("memory-key.js", out));
const { personScope } = await import(new URL("person-scope.js", out));
const { emptyNotes, forgetNotes, publishedFileMemory } = await import(new URL("published-memory.js", out));
const { createMemoryLock } = await import("../node_modules/eve/dist/src/shared/memory-state.js");
const { defaultNamespace } = await import("eve/memory");

const DIDS = ["did:plc:abcdefghijklmnopqrstuvwx", "did:web:someone.example"];

test("memoryKey is eve's key for any namespace and scope", () => {
  for (const namespace of ["poe", "a namespace with ünïcode", defaultNamespace({ appRoot: "/x", node: "__root__", slot: "person" })]) {
    for (const scope of ["poe-life", ...DIDS.map(personScope), ["one"], ["a", "b", "c"]]) {
      const lock = createMemoryLock({ namespace, scope, slot: "person", turn: null, visibility: "scope" });
      assert.equal(memoryKey(namespace, scope), lock.scope.key);
    }
  }
});

test("personNotesKey is the key of the person slot on the root agent, locally and on Vercel", () => {
  assert.equal(PERSON_SLOT, "person");
  const saved = { ...process.env };
  try {
    for (const env of [{}, { VERCEL_PROJECT_ID: "prj_123", VERCEL_ENV: "production" }]) {
      delete process.env.VERCEL_PROJECT_ID;
      delete process.env.VERCEL_OIDC_TOKEN;
      Object.assign(process.env, env);
      const namespace = defaultNamespace({ appRoot: process.cwd(), node: "__root__", slot: "person" });
      for (const did of DIDS) {
        const lock = createMemoryLock({ namespace, scope: personScope(did), slot: "person", turn: null, visibility: "scope" });
        assert.equal(personNotesKey(did), lock.scope.key);
      }
    }
  } finally {
    process.env = saved;
  }
  assert.notEqual(personNotesKey(DIDS[0]), personNotesKey(DIDS[1]));
});

test("emptyNotes is a valid empty document that keeps the counter", () => {
  assert.equal(emptyNotes(null), "<!-- eve-memory-file-v1 lastAllocatedIndex=-1 -->\n");
  assert.equal(emptyNotes("<!-- eve-memory-file-v1 lastAllocatedIndex=7 -->\n- [7] builds feeds\n"),
    "<!-- eve-memory-file-v1 lastAllocatedIndex=7 -->\n");
  assert.equal(emptyNotes("not a memory document"), "<!-- eve-memory-file-v1 lastAllocatedIndex=-1 -->\n");
});

test("forgetNotes wipes one person's notes, hands the empty version over, and leaves everyone else's alone", async () => {
  const handed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    handed.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example";
  process.env.DROPLET_SHARED_SECRET = "droplet-secret";
  try {
    const provider = publishedFileMemory();
    const turnFor = (did) => ({ memory: { scope: { key: personNotesKey(did), namespace: "n", value: personScope(did) }, slot: "person" },
      abortSignal: new AbortController().signal, turn: { id: "t", input: [], sequence: 0 } });
    const recalled = async (did) => (await provider.recall["turn.started"](turnFor(did)))?.messages[0].content ?? null;
    for (const did of DIDS) {
      const tools = await provider.tools(turnFor(did));
      await tools.save_memory.execute({ text: `${did} builds feeds` }, { abortSignal: new AbortController().signal });
    }
    assert.match(await recalled(DIDS[0]), /builds feeds/);
    handed.length = 0;

    assert.deepEqual(await forgetNotes(DIDS[0]), { hadNotes: true, published: true });
    assert.deepEqual(handed, [{ url: "https://droplet.example/memory",
      body: { did: DIDS[0], content: "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n" } }]);
    assert.match(await recalled(DIDS[0]), /No memories are saved/);
    assert.match(await recalled(DIDS[1]), /builds feeds/, "someone else's notes are untouched");

    // Asking again finds nothing new, and makes sure the public copy is empty too.
    assert.deepEqual(await forgetNotes(DIDS[0]), { hadNotes: false, published: true });
    // A DID Poe never met: nothing stored, and nothing handed over to be published.
    handed.length = 0;
    assert.deepEqual(await forgetNotes("did:plc:zzzzzzzzzzzzzzzzzzzzzzzz"), { hadNotes: false, published: false });
    assert.deepEqual(handed, []);

    // The droplet down: the notes are still gone, and the caller hears the public copy is not.
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await forgetNotes(DIDS[1]), { hadNotes: true, published: false });
    } finally {
      console.error = original;
    }
    assert.match(await recalled(DIDS[1]), /No memories are saved/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.DROPLET_CALLBACK_URL;
    delete process.env.DROPLET_SHARED_SECRET;
  }
});
