import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// The website reaches a person's existing notes only if personScope spells
// the key eve's byPrincipal produces on a Bluesky turn. Run against eve's own
// byPrincipal, so an eve upgrade that changes the format fails here rather
// than quietly giving every signed-in visitor an empty document.
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/person-scope.ts",
  "--outDir", ".eve/person-scope-test", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const { personScope } = await import("../.eve/person-scope-test/person-scope.js");
const { byPrincipal } = await import("../node_modules/eve/dist/src/public/memory/scope.js");

test("personScope is the scope a Bluesky turn resolves for the same DID", () => {
  for (const did of ["did:plc:abcdefghijklmnopqrstuvwx", "did:web:someone.example"]) {
    // Exactly the auth channels/bluesky.ts sends for a mention.
    const ctx = { session: { auth: { current: {
      authenticator: "atpotato-droplet", principalType: "user", principalId: did,
      attributes: { did, handle: "someone.example", postUri: `at://${did}/app.bsky.feed.post/3abc`,
        threadRoot: `at://${did}/app.bsky.feed.post/3abc`, attempt: "1", operator: "false" },
    } } } };
    assert.deepEqual(personScope(did), [byPrincipal(ctx), did]);
  }
});

test("a website caller would get a different key from byPrincipal, which is why personScope exists", () => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx";
  const ctx = { session: { auth: { current: {
    authenticator: "atpotato-website", principalType: "user", principalId: did, attributes: { did },
  } } } };
  assert.notEqual(byPrincipal(ctx), personScope(did)[0]);
});
