import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

execFileSync("node", ["node_modules/typescript/bin/tsc", "--ignoreConfig", "agent/lib/preview.ts",
  "--outDir", ".eve/preview-test", "--module", "esnext", "--moduleResolution", "bundler",
  "--target", "es2022", "--skipLibCheck", "--types", "node"],
  { cwd: new URL("..", import.meta.url) });
// eve's bundler resolves the extensionless import; plain Node needs the .js.
const compiled = new URL("../.eve/preview-test/preview.js", import.meta.url);
writeFileSync(compiled, readFileSync(compiled, "utf8").replace('from "./channel-kind"', 'from "./channel-kind.js"'));
const { previewsBluesky } = await import(compiled);

function withEnv(env, fn) {
  const keys = ["EVE_DEV", "EVE_EVALUATION", "POE_PREVIEW"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}

test("a deployment, with neither local flag, never previews", () => {
  withEnv({}, () => assert.equal(previewsBluesky("eve"), false));
});

test("eve dev and a local eve eval preview Bluesky mode in the chat channel", () => {
  withEnv({ EVE_DEV: "1" }, () => assert.equal(previewsBluesky("eve"), true));
  withEnv({ EVE_EVALUATION: "1" }, () => assert.equal(previewsBluesky("eve"), true));
});

test("POE_PREVIEW=off turns it off locally", () => {
  withEnv({ EVE_DEV: "1", POE_PREVIEW: "off" }, () => assert.equal(previewsBluesky("eve"), false));
});

test("the real Bluesky, operator DM and weather channels are never treated as a preview", () => {
  withEnv({ EVE_DEV: "1" }, () => {
    // eve's runtime spelling first, then the bare file stem.
    assert.equal(previewsBluesky("channel:bluesky"), false);
    assert.equal(previewsBluesky("channel:operator-dm"), false);
    assert.equal(previewsBluesky("channel:weather"), false);
    assert.equal(previewsBluesky("bluesky"), false);
    assert.equal(previewsBluesky("operator-dm"), false);
    assert.equal(previewsBluesky("weather"), false);
    assert.equal(previewsBluesky(undefined), false);
  });
});

test("the website chat panel never gets the Bluesky preview, under either kind spelling", () => {
  for (const env of [{ EVE_DEV: "1" }, { EVE_EVALUATION: "1" }]) {
    withEnv(env, () => {
      assert.equal(previewsBluesky("website"), false);
      assert.equal(previewsBluesky("channel:website"), false);
    });
  }
});
