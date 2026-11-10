import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The sample replies and posts in the skills are what Poe copies hardest. It
// obeys "don't copy their lines" and copies their sentence shapes: three of the
// first thirteen samples explained a thing by what it wasn't, and by November
// one live reply in seven did too. So the samples are held to the rules they sit
// beside, with the same detectors the droplet's measure-voice tool counts live
// posts with (mentions/src/voice-tells.js).

const tellsFile = new URL("../../mentions/src/voice-tells.js", import.meta.url);
const skip = existsSync(tellsFile) ? false : "mentions/ isn't checked out next to the bot";
const tells = skip ? null : await import(tellsFile.href);

/**
 * Every blockquote in a skill: the replies and posts held up as good. The ones
 * that fell flat are quoted inline after "Posted:", so they are not picked up.
 * A wrapped line joins the one before it; a line that opens with an emoji, and
 * the line after a blank one, start afresh, as they do in the post.
 */
function samples(name) {
  const text = readFileSync(new URL(`../agent/skills/${name}.md`, import.meta.url), "utf8");
  const out = [];
  let lines = null;
  const flush = () => {
    if (!lines) return;
    let sample = "";
    for (const [i, line] of lines.entries()) {
      const fresh = i === 0 || line === "" || lines[i - 1] === "" || /^\p{Extended_Pictographic}/u.test(line);
      sample += (fresh ? (i === 0 ? "" : "\n") : " ") + line;
    }
    out.push(sample.trim());
    lines = null;
  };
  for (const line of text.split("\n")) {
    if (/^>( |$)/.test(line)) (lines ??= []).push(line.replace(/^> ?/, "").trim());
    else flush();
  }
  flush();
  return out;
}

const counts = (measured) => Object.fromEntries(measured.tells.map((t) => [t.key, t.count]));

test("the blockquotes are read as the replies and posts they are", { skip }, () => {
  const replies = samples("bluesky-reply");
  assert.ok(replies.length >= 15, `found ${replies.length} sample replies`);
  assert.ok(replies.every((r) => !r.includes("\n")), "a reply's wrapped lines are one paragraph");
  assert.ok(replies.some((r) => r.startsWith("hiiii! oh that's a nice bathroom.")));
  const posts = samples("weather-post");
  assert.equal(posts.length, 6);
  assert.ok(posts.some((p) => p.split("\n").length === 5), "the list example keeps its lines and its blank one");
});

test("no sample reply carries a habit the voice rules tell Poe to break", { skip }, () => {
  const replies = samples("bluesky-reply");
  const found = counts(tells.measureReplies(replies));
  for (const key of ["contrast", "summing-up", "sincerity", "my-kind-of", "no-no-no", "signpost", "praise", "concession"]) {
    assert.equal(found[key], 0, `[${key}] in a sample reply: ${JSON.stringify(tells.examples(replies, key))}`);
  }
});

test("the loved replies open differently and mostly end without a question", { skip }, () => {
  const text = readFileSync(new URL("../agent/skills/bluesky-reply.md", import.meta.url), "utf8");
  const section = text.slice(text.indexOf("## The voice"), text.indexOf("### Before and after"));
  const loved = samples("bluesky-reply").filter((r) => section.includes(r.slice(0, 30)));
  assert.equal(loved.length, 13);
  const measured = tells.measureReplies(loved);
  // "not yet!" and "not a chance!" are the one pair that share a first word.
  assert.ok(measured.openers.length <= 1 && measured.openers.every((o) => o.count <= 2),
    `hardly any two start alike: ${JSON.stringify(measured.openers)}`);
  assert.match(text, /Hardly any two start alike/);
  const found = counts(measured);
  // The skill says so in as many words, and Poe reads the samples to check.
  assert.equal(found["question-back"], 2, "two ask something back");
  assert.match(text, /Two ask something back/);
  assert.ok(found["question-back"] / loved.length <= 0.2, "a question back on about one reply in five");
  assert.match(text, /about one reply in five/);
});

test("the weather examples mostly end on the news, and none is built like another", { skip }, () => {
  const posts = samples("weather-post");
  const measured = tells.measureWeather(posts);
  const found = counts(measured);
  assert.equal(found["closing-line"], 1, "one example ends on a line of its own");
  assert.ok(found["closing-line"] / posts.length <= 1 / 3);
  for (const key of ["question", "somebody", "meanwhile", "blew-in", "on-the-roof"]) {
    assert.equal(found[key], 0, `[${key}] in a weather example`);
  }
  assert.deepEqual(measured.repeatedOpenings, []);
  assert.deepEqual(measured.repeatedClosers, []);
  const replyTells = counts(tells.measureReplies(posts));
  assert.equal(replyTells.contrast, 0, `a contrast in a weather example: ${JSON.stringify(tells.examples(posts, "contrast"))}`);
});

test("the habits are named in the one place every channel reads", () => {
  const voice = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");
  assert.match(voice, /## Habits to break/);
  for (const habit of ["Explaining a thing by what it isn't", "A last line that sums up", "Vouching for yourself", "A question on the end of everything"]) {
    assert.ok(voice.includes(habit), habit);
  }
  // The rules were once written in the shapes they now rule out, and Poe mirrored them.
  assert.equal(voice.includes("no idea honestly"), false);
  assert.equal(voice.includes("—"), false, "no em dashes");
  for (const skill of ["dispatch-issue", "weather-post", "bluesky-reply"]) {
    const text = readFileSync(new URL(`../agent/skills/${skill}.md`, import.meta.url), "utf8");
    assert.equal(text.includes("—"), false, `no em dashes in ${skill}`);
  }
});
