import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Compile the tested source with the installed TypeScript version. Eve itself
// requires Node 24, but these contract tests can also run on Node 18.
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/operator-dm.ts",
  "--outDir", ".eve/dm-test", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const { OperatorDm, postDmDraft } = await import("../.eve/dm-test/operator-dm.js");

const dm = { dmId: "dm-1", operatorDid: "did:plc:abc123", text: "how are you?" };

test("accepts only the private DM contract", () => {
  assert.equal(OperatorDm.safeParse(dm).success, true);
  assert.equal(OperatorDm.safeParse({ ...dm, guidance: true }).success, true);
  assert.equal(OperatorDm.safeParse({ ...dm, text: "" }).success, false);
  assert.equal(OperatorDm.safeParse({ ...dm, operatorDid: "some.handle" }).success, false);
  assert.equal(OperatorDm.safeParse({ ...dm, postUri: "at://post" }).success, false);
});

test("sends the draft only to the authenticated private callback", async () => {
  process.env.DROPLET_CALLBACK_URL = "https://droplet.example/draft";
  process.env.DROPLET_SHARED_SECRET = "shared";
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url: String(url), options };
    return { ok: true };
  };
  try {
    await postDmDraft({ key: "session:turn", ...dm });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sent.url, "https://droplet.example/dm-draft");
  assert.equal(sent.options.headers["x-atpotato-secret"], "shared");
  assert.deepEqual(JSON.parse(sent.options.body), { key: "session:turn", ...dm });
});

test("callback transport failures never log DM text", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged = [];
  globalThis.fetch = async () => { throw new Error(dm.text); };
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await postDmDraft({ key: "session:turn", ...dm });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes(dm.text), false);
});
