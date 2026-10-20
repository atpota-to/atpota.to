import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/channel-kind.ts",
  "agent/lib/person-scope.ts", "agent/lib/website.ts",
  "--outDir", ".eve/channel-kind-test", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const channelKind = await import("../.eve/channel-kind-test/channel-kind.js");
const personScope = await import("../.eve/channel-kind-test/person-scope.js");
const website = await import("../.eve/channel-kind-test/website.js");

// Exercise each authored memory definition with a small stand-in for eve's
// memory lifecycle. No Vercel credentials, PDS, or DM transport are involved.
function loadSlot(file) {
  const source = readFileSync(new URL(`../agent/memory/${file}.ts`, import.meta.url), "utf8");
  // These definitions use JavaScript syntax; replace their module boundaries
  // so the functions can run against a fake provider without a live Blob store.
  const code = source.replace(/^import \{ (.+) \} from "(.+)";$/gm,
    (_line, names, name) => `const { ${names} } = require("${name}");`)
    .replace("export default defineMemory(", "module.exports.default = defineMemory(");
  const module = { exports: {} };
  const provider = () => ({ recall: {}, tools: async () => ({ save_memory: true }) });
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      if (name === "eve/memory") return {
        defineMemory: (value) => value,
        defineMemoryProvider: (value) => value,
      };
      if (name === "eve/memory/scope") return {
        byPrincipal: (ctx) => ctx.session.auth.current?.principalId ?? null,
      };
      if (name === "../lib/published-memory") return {
        privateFileMemory: provider,
        publishedFileMemory: provider,
      };
      if (name === "../lib/channel-kind") return channelKind;
      if (name === "../lib/person-scope") return personScope;
      if (name === "../lib/website") return website;
      throw new Error(`unexpected memory dependency ${name}`);
    },
  });
  return module.exports.default;
}

const operatorDid = "did:plc:operator123";
const otherDid = "did:plc:other123";
// Kinds as eve reports them at runtime: "channel:" plus the channel's file stem.
const dm = (did = operatorDid, kind = "channel:operator-dm") => ({
  channel: { kind },
  session: { auth: { current: {
    authenticator: "atpotato-droplet-dm", principalType: "user",
    principalId: did, attributes: { operatorDid: did },
  } } },
});
const publicTurn = (operator, kind = "channel:bluesky") => ({
  channel: { kind },
  session: { auth: { current: {
    authenticator: "atpotato-droplet", principalType: "user",
    principalId: otherDid, attributes: { did: otherDid, operator: String(operator) },
  } } },
});

test("private operator notes are keyed to the authenticated DID, never public", async () => {
  const slot = loadSlot("operator-notes");
  assert.equal(slot.scope(dm()), operatorDid);
  assert.equal(slot.scope(dm(otherDid)), otherDid);
  assert.equal(slot.scope(publicTurn(true)), null);
  const forged = dm();
  forged.session.auth.current.attributes.operatorDid = otherDid;
  assert.equal(slot.scope(forged), null);
  const untrusted = dm();
  untrusted.session.auth.current.authenticator = "atpotato-droplet";
  assert.equal(slot.scope(untrusted), null);
  assert.equal((await slot.provider.tools(dm())).save_memory, true);
});

test("private DM journal can save an ordinary DM but cannot be opened publicly", async () => {
  const slot = loadSlot("operator-dm-life");
  assert.equal(slot.scope(dm()), "poe-operator-dm-life");
  assert.equal(slot.scope(publicTurn(true)), null);
  assert.equal((await slot.provider.tools(dm())).save_memory, true);
  assert.equal(await slot.provider.tools(publicTurn(true)), null);
});

test("stable self notes require an operator; public life journal is read-only in DMs", async () => {
  const self = loadSlot("self");
  const life = loadSlot("life");
  assert.equal(self.scope, "poe-self");
  assert.equal((await self.provider.tools(dm())).save_memory, true);
  assert.equal((await self.provider.tools(publicTurn(true))).save_memory, true);
  assert.equal(await self.provider.tools(publicTurn(false)), null);
  assert.equal(life.scope(dm()), "poe-life");
  assert.equal(life.scope(publicTurn(false)), "poe-life");
  assert.equal(await life.provider.tools(dm()), null);
  assert.equal((await life.provider.tools(publicTurn(false))).save_memory, true);
});

test("public person notes remain unavailable to operator DMs", () => {
  const slot = loadSlot("person");
  assert.equal(slot.scope(dm()), null);
  assert.equal(slot.scope(publicTurn(false))[1], otherDid);
});

test("an anonymous website visitor gets no memory beyond public-safe self and journal recall", async () => {
  for (const kind of ["website", "channel:website"]) {
    const visitor = { channel: { kind }, session: { auth: { current: {
      authenticator: "atpotato-website", principalType: "anonymous", principalId: "website-visitor",
      attributes: { conversationId: "c".repeat(43), path: "/" },
    } } } };
    for (const file of ["person", "operator-dm-life", "operator-notes"]) {
      assert.equal(loadSlot(file).scope(visitor), null, `${file} on ${kind}`);
    }
    // One journal wherever Poe is: recalled here, never written by a stranger.
    assert.equal(loadSlot("life").scope(visitor), "poe-life");
    assert.equal(await loadSlot("life").provider.tools(visitor), null);
    const self = loadSlot("self");
    assert.equal(self.scope, "poe-self");
    assert.equal(await self.provider.tools(visitor), null);
  }
});

const signedInDid = "did:plc:abcdefghijklmnopqrstuvwx";
const signedIn = (overrides = {}, kind = "channel:website") => ({
  channel: { kind },
  session: { auth: { current: {
    authenticator: "atpotato-website", principalType: "user", principalId: signedInDid,
    attributes: { conversationId: "c".repeat(43), path: "/", did: signedInDid, handle: "someone.example" },
    ...overrides,
  } } },
});

test("a signed-in website visitor gets the very notes Poe keeps for their DID on Bluesky", async () => {
  for (const kind of ["website", "channel:website"]) {
    const person = loadSlot("person");
    assert.deepEqual(person.scope(signedIn({}, kind)), personScope.personScope(signedInDid));
    assert.deepEqual(person.scope(signedIn({}, kind)),
      [JSON.stringify(["user", "atpotato-droplet", null, signedInDid]), signedInDid]);
    assert.equal((await person.provider.tools(signedIn({}, kind))).save_memory, true);
    assert.equal(loadSlot("life").scope(signedIn({}, kind)), "poe-life");
    assert.equal((await loadSlot("life").provider.tools(signedIn({}, kind))).save_memory, true);
    // Signing in on the website never reaches operator memory or self notes.
    for (const file of ["operator-dm-life", "operator-notes"]) {
      assert.equal(loadSlot(file).scope(signedIn({}, kind)), null, `${file} on ${kind}`);
    }
    assert.equal(await loadSlot("self").provider.tools(signedIn({}, kind)), null);
  }
});

test("website person notes need the DID the proxy asserted, under the website's own authenticator", async () => {
  const person = loadSlot("person");
  const life = loadSlot("life");
  // A principal that is not the asserted DID, a malformed DID, or a website
  // kind carrying another authenticator opens nothing.
  const mismatched = signedIn({ principalId: otherDid });
  const malformed = signedIn({ principalId: "did:example:x", attributes: { did: "did:example:x" } });
  const anonymousWithDid = signedIn({ principalType: "anonymous" });
  const droplet = signedIn({ authenticator: "atpotato-droplet" });
  for (const ctx of [mismatched, malformed, anonymousWithDid, droplet]) {
    assert.equal(person.scope(ctx), null);
  }
  for (const ctx of [mismatched, malformed, anonymousWithDid]) {
    assert.equal(await life.provider.tools(ctx), null);
  }
});

test("each slot opens for its own channel under either kind spelling, and never for another", async () => {
  for (const [dmKind, publicKind] of [["channel:operator-dm", "channel:bluesky"], ["operator-dm", "bluesky"]]) {
    assert.equal(loadSlot("operator-notes").scope(dm(operatorDid, dmKind)), operatorDid);
    assert.equal(loadSlot("operator-dm-life").scope(dm(operatorDid, dmKind)), "poe-operator-dm-life");
    assert.equal(loadSlot("life").scope(publicTurn(false, publicKind)), "poe-life");
    assert.equal(loadSlot("person").scope(publicTurn(false, publicKind))[1], otherDid);
    assert.equal((await loadSlot("self").provider.tools(publicTurn(true, publicKind))).save_memory, true);
  }
  // eve reports any spelling it does not know as "unknown"; that, or another
  // channel's kind, opens nothing.
  for (const kind of ["unknown", "channel:eve", "http"]) {
    assert.equal(loadSlot("operator-notes").scope(dm(operatorDid, kind)), null, kind);
    assert.equal(loadSlot("operator-dm-life").scope(dm(operatorDid, kind)), null, kind);
    assert.equal(loadSlot("life").scope(publicTurn(false, kind)), null, kind);
    assert.equal(loadSlot("person").scope(publicTurn(false, kind)), null, kind);
    assert.equal(await loadSlot("self").provider.tools(publicTurn(true, kind)), null, kind);
  }
});
