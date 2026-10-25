import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// The Bluesky and operator DM instructions, compiled with eve's runtime
// imports swapped for stubs. Kinds are spelled the way eve reports them at
// runtime ("channel:bluesky"), which is the case the bare-name checks missed.
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig",
  "agent/instructions/bluesky.ts", "agent/instructions/operator-dm.ts", "agent/instructions/weather.ts",
  "agent/instructions/dispatch.ts",
  "types/assets.d.ts",
  "--outDir", ".eve/channel-kind-test", "--rootDir", "agent", "--module", "esnext",
  "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
const out = new URL("../.eve/channel-kind-test/", import.meta.url);
function load(path, replacements) {
  let source = readFileSync(new URL(`${path}.js`, out), "utf8");
  for (const [from, to] of replacements) source = source.replace(from, to);
  writeFileSync(new URL(`${path}.mjs`, out), source);
  return import(new URL(`${path}.mjs`, out));
}
const instructionsStub = ['from "eve/instructions"', `from "${stub(`export const defineDynamic = (definition) => definition;
  export const defineInstructions = (instructions) => instructions;`)}"`];
const kindImport = ['from "../lib/channel-kind"', 'from "../lib/channel-kind.js"'];
const { isChannelKind } = await import(new URL("lib/channel-kind.js", out));
await load("lib/preview", [['from "./channel-kind"', 'from "./channel-kind.js"']]);
const bluesky = (await load("instructions/bluesky", [instructionsStub, kindImport,
  ['from "../skills/bluesky-reply.md?raw"', `from "${stub('export default "---\\nname: bluesky-reply\\n---\\nreply rules";')}"`],
  ['from "../lib/preview"', 'from "../lib/preview.mjs"'],
])).default;
const operatorDm = (await load("instructions/operator-dm", [instructionsStub, kindImport])).default;
const weather = (await load("instructions/weather", [instructionsStub, kindImport,
  ['from "../skills/weather-post.md?raw"', `from "${stub('export default "---\\nname: weather-post\\n---\\nweather rules";')}"`],
])).default;

const dispatch = (await load("instructions/dispatch", [instructionsStub, kindImport,
  ['from "../skills/dispatch-issue.md?raw"', `from "${stub('export default "---\\nname: dispatch-issue\\n---\\nwriting rules";')}"`],
])).default;

const turn = (definition, kind, session) => definition.events["turn.started"]({}, { channel: { kind }, ...(session ? { session } : {}) });

test("isChannelKind takes eve's runtime spelling and the bare stem, nothing else", () => {
  assert.equal(isChannelKind("channel:bluesky", "bluesky"), true);
  assert.equal(isChannelKind("bluesky", "bluesky"), true);
  for (const kind of ["channel:operator-dm", "unknown", "channel:bluesky-x", "xchannel:bluesky", "", undefined]) {
    assert.equal(isChannelKind(kind, "bluesky"), false, String(kind));
  }
});

test("the Bluesky reply rules load on a real Bluesky turn", async () => {
  assert.deepEqual(await turn(bluesky, "channel:bluesky"), { content: "reply rules" });
  assert.deepEqual(await turn(bluesky, "bluesky"), { content: "reply rules" });
  for (const kind of ["channel:operator-dm", "channel:website", "channel:eve", "unknown"]) {
    assert.equal(await turn(bluesky, kind), null, kind);
  }
});

test("the operator DM instructions load only on an operator DM turn", async () => {
  assert.match((await turn(operatorDm, "channel:operator-dm")).content, /private conversation/);
  assert.match((await turn(operatorDm, "operator-dm")).content, /private conversation/);
  for (const kind of ["channel:bluesky", "channel:website", "channel:eve", "unknown"]) {
    assert.equal(await turn(operatorDm, kind), null, kind);
  }
});

test("the operator DM instructions name the dispatch draft waiting on the operator", async () => {
  const attributes = { dmId: "dm-1", operatorDid: "did:plc:x", dispatchDrafts: "true", dispatchDraftId: "dd-2026-10-26",
    dispatchDraftStatus: "ready", dispatchDraftVersion: "3", dispatchDraftTitle: "spaces near beta" };
  const withDraft = (await turn(operatorDm, "channel:operator-dm", { auth: { current: { attributes } } })).content;
  assert.match(withDraft, /Right now the dispatch draft "spaces near beta" \(version 3\) is waiting for the operator's review/);
  assert.match(withDraft, /propose_dispatch_publish/);
  const without = (await turn(operatorDm, "channel:operator-dm", { auth: { current: { attributes: { dmId: "dm-2", dispatchDrafts: "true" } } } })).content;
  assert.doesNotMatch(without, /Right now the dispatch draft/);
  assert.match(without, /read_dispatch_draft/, "how to handle a draft is there while drafts are on");
  const off = (await turn(operatorDm, "channel:operator-dm", { auth: { current: { attributes: { dmId: "dm-3" } } } })).content;
  assert.doesNotMatch(off, /read_dispatch_draft|start_dispatch_draft/, "and not while the droplet has them off");
});

test("the dispatch writing rules load only on a dispatch turn", async () => {
  assert.match((await turn(dispatch, "channel:dispatch")).content, /^writing rules\n\nThis session is yours alone/);
  for (const kind of ["channel:bluesky", "channel:operator-dm", "channel:website", "channel:weather", "unknown"]) {
    assert.equal(await turn(dispatch, kind), null, kind);
  }
});

test("the weather post rules load only on a weather turn", async () => {
  assert.deepEqual(await turn(weather, "channel:weather"), { content: "weather rules" });
  assert.deepEqual(await turn(weather, "weather"), { content: "weather rules" });
  for (const kind of ["channel:bluesky", "channel:operator-dm", "channel:website", "channel:eve", "unknown"]) {
    assert.equal(await turn(weather, kind), null, kind);
  }
  // and the weather channel never previews Bluesky mode, even locally
  assert.equal(await turn(bluesky, "channel:weather"), null);
});
