import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";


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
      throw new Error(`unexpected memory dependency ${name}`);
    },
  });
  return module.exports.default;
}

const operatorDid = "did:plc:operator123";
const otherDid = "did:plc:other123";
const dm = (did = operatorDid) => ({
  channel: { kind: "operator-dm" },
  session: { auth: { current: {
    authenticator: "atpotato-droplet-dm", principalType: "user",
    principalId: did, attributes: { operatorDid: did },
  } } },
});
const publicTurn = (operator) => ({
  channel: { kind: "bluesky" },
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
