/**
 * Demo pipeline for the weekly dispatch: collect a week of real data, then
 * write an issue from it with the analyst, writer and editor roles, so the
 * format and voice can be tuned before the production pipeline exists.
 *
 *   node scripts/dispatch-demo.ts collect [--days 7]
 *   node scripts/dispatch-demo.ts write .dispatch/runs/<date> [--label name]
 *        [--reuse <earlier label> [--rerun lexicons,conversation,shipping]]
 *   node scripts/dispatch-demo.ts demo [--days 7]
 *
 * `write` can be re-run on the same collected week as often as you like, so a
 * change to agent/lib/dispatch/voice.md or roles.ts can be compared against
 * the same data. Each run writes to its own drafts/<label>/ folder.
 *
 * Nothing is posted or published. Output stays in .dispatch/, which is
 * gitignored because it holds other people's posts.
 *
 * Models: DISPATCH_{ANALYST,WRITER,EDITOR}_MODEL, then AGENT_MODEL, then
 * anthropic/claude-opus-5.5. Reasoning: DISPATCH_{...}_REASONING, then
 * AGENT_REASONING, then high. Both are read from .env.local and
 * .env.development.local the way eve reads them, so `npx eve link` is enough.
 *
 * Unlike production, the analysts get their slice in the prompt rather than as
 * sandbox files. A demo week fits in the context window; a large builders list
 * may not, and production moves to files for that reason.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Output, streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import type { z } from "zod";
import { collectWeek, groupNewLexicons, lastDays, looksLikeNsid, type DispatchDataset, type DispatchPost, type LexiconReport, type ReleaseResult } from "../agent/lib/dispatch/collect.ts";
import { lintDraft, type LintReport } from "../agent/lib/dispatch/lint.ts";
import { ANALYST, ANALYST_SLICES, Draft, EDITOR, Edited, Findings, WRITER } from "../agent/lib/dispatch/roles.ts";
import { SOURCES } from "../agent/lib/dispatch/sources.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// eve reads .env.local, then .env.development.local, which wins. Variables
// already in the environment win over both.
const fromFiles: Record<string, string> = {};
for (const file of [".env.local", ".env.development.local"]) {
  const path = join(ROOT, file);
  if (existsSync(path)) Object.assign(fromFiles, parseEnv(readFileSync(path, "utf8")));
}
for (const [key, value] of Object.entries(fromFiles)) process.env[key] ??= value;

const { languageModel } = await import("../agent/lib/model.ts");

type Reasoning = "low" | "medium" | "high" | "xhigh";
type Role = { name: string; id: string; model: LanguageModel; reasoning: Reasoning | undefined };

function role(name: "ANALYST" | "WRITER" | "EDITOR"): Role {
  const env = (key: string) => process.env[key]?.trim() || undefined;
  const id = env(`DISPATCH_${name}_MODEL`) ?? env("AGENT_MODEL") ?? "anthropic/claude-opus-5.5";
  const reasoning = env(`DISPATCH_${name}_REASONING`) ?? env("AGENT_REASONING") ?? "high";
  return { name: name.toLowerCase(), id, model: languageModel(id), reasoning: reasoning === "off" ? undefined : reasoning as Reasoning };
}

const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

// ---------------------------------------------------------------------------
// collect

async function collect(days: number): Promise<string> {
  const window = lastDays(new Date(), days);
  const dir = join(ROOT, ".dispatch/runs", window.until.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  log(`collecting ${window.since} to ${window.until}`);
  const data = await collectWeek(fetch, SOURCES, window, { log });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(data.manifest, null, 2));
  writeFileSync(join(dir, "posts.jsonl"), data.posts.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(join(dir, "lexicons.json"), JSON.stringify(data.lexicons, null, 2));
  writeFileSync(join(dir, "releases.json"), JSON.stringify(data.releases, null, 2));
  log(`collected ${data.posts.length} posts into ${dir}`);
  for (const note of data.manifest.notes) log(`note: ${note}`);
  return dir;
}

function load(dir: string): DispatchDataset {
  const read = (file: string) => readFileSync(join(dir, file), "utf8");
  return {
    manifest: JSON.parse(read("manifest.json")),
    posts: read("posts.jsonl").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    lexicons: upgrade(JSON.parse(read("lexicons.json"))),
    releases: JSON.parse(read("releases.json")),
  };
}

/** Project groups and flags, computed by code at write time. */
function upgrade(report: LexiconReport | null): LexiconReport | null {
  if (!report) return report;
  // Recomputed even when stored, so a fix to the grouping or the flag reaches
  // weeks collected before it.
  for (const n of report.newLexicons) {
    n.flags = [...(looksLikeNsid(n.nsid) ? [] : ["invalid-looking"]), ...n.flags.filter((f) => f !== "invalid-looking")];
  }
  report.newByProject = groupNewLexicons(report.newLexicons);
  report.totals.newSingleAccount = report.newLexicons.filter((n) => n.accounts <= 1).length;
  return report;
}

// ---------------------------------------------------------------------------
// The slices each analyst reads, written compactly but in full

const shortVia = (via: string) => via.replace(/^(feed|list):at:\/\/[^/]+\/[^/]+\//, "$1 ").replace(/^search:/, "search ");

function postsText(posts: DispatchPost[], ids: Map<string, string>): string {
  const ref = (uri: string) => ids.get(uri) ?? uri;
  return posts.map((p) => {
    const who = `@${p.author.handle}${p.author.displayName ? ` (${p.author.displayName})` : ""}`;
    const lines = [
      `${ids.get(p.uri)} | ${p.createdAt.slice(0, 16).replace("T", " ")} | ${who} | likes ${p.likes}, reposts ${p.reposts}, replies ${p.replies}, quotes ${p.quotes} | via ${p.via.map(shortVia).join(", ")}`,
      `  ${p.text.replace(/\s+/g, " ").trim() || "(no text)"}`,
    ];
    if (p.links.length) lines.push(`  links: ${p.links.join(" ")}`);
    if (p.imageAlts.length) lines.push(`  images: ${p.imageAlts.map((alt) => JSON.stringify(alt.slice(0, 200))).join(" ")}`);
    if (p.quoted) lines.push(`  quotes: ${ref(p.quoted)}`);
    if (p.replyTo) lines.push(`  reply to: ${ref(p.replyTo)}`);
    return lines.join("\n");
  }).join("\n");
}

function lexiconsText(report: LexiconReport): string {
  const out = [`window: ${report.window.since} to ${report.window.until}`, `totals: ${JSON.stringify(report.totals)}`, ...report.notes.map((n) => `note: ${n}`), ""];
  out.push("NEW LEXICONS BY PROJECT, counted by code. domain | new NSIDs | of which flagged invalid-looking | most accounts on one | total creates | nsids");
  for (const g of report.newByProject) out.push(`${g.root} | ${g.count} | ${g.flagged} | ${g.maxAccounts} | ${g.creates} | ${g.nsids.join(", ")}`);
  out.push("", `NEW LEXICONS (${report.newLexicons.length}). nsid | accounts | creates | updates | deletes | flags`);
  for (const n of report.newLexicons) {
    out.push(`${n.nsid} | ${n.accounts} | ${n.creates} | ${n.updates} | ${n.deletes} | ${n.flags.join(",") || "-"}`);
    if (n.schema) out.push(`  schema: ${n.schema.published ? `published by ${n.schema.authorityDid}${n.schema.description ? `: ${n.schema.description}` : ""}` : `none (${n.schema.note})`}`);
    for (const s of n.samples ?? []) out.push(`  sample ${s.uri}: ${s.value}`);
  }
  out.push("", "MOVERS UP. nsid | accounts previous 7 days -> this window");
  for (const m of report.movers.up) out.push(`${m.nsid} | ${m.accountsBefore} -> ${m.accountsAfter}`);
  out.push("", "MOVERS DOWN. nsid | accounts previous 7 days -> this window");
  for (const m of report.movers.down) out.push(`${m.nsid} | ${m.accountsBefore} -> ${m.accountsAfter}`);
  out.push("", "LARGEST OUTSIDE BLUESKY'S NAMESPACES. nsid | accounts | creates | updates | deletes");
  for (const r of report.topOutsideBluesky) out.push(`${r.nsid} | ${r.accounts} | ${r.creates} | ${r.updates} | ${r.deletes}`);
  out.push("", "PUBLISHED SCHEMAS, SAMPLE. nsid | publisher did | time");
  for (const s of report.publishedSchemas) out.push(`${s.nsid} | ${s.did} | ${s.at}`);
  return out.join("\n");
}

function releasesText(releases: ReleaseResult[]): string {
  return releases.map((r) => r.ok
    ? r.releases.map((x) => `${x.repo} ${x.tag} (${x.name}) ${x.publishedAt} ${x.url}\n  ${x.notes.replace(/\s+/g, " ").slice(0, 600)}`).join("\n") || `${r.repo}: no releases in the window`
    : `${r.repo}: unavailable (${r.error})`).join("\n");
}

// ---------------------------------------------------------------------------
// Model calls

type Usage = { role: string; label: string; model: string; seconds: number; usage: LanguageModelUsage };
const usages: Usage[] = [];

async function call<T>(who: Role, label: string, system: string, prompt: string, schema: z.ZodType<T>): Promise<T> {
  const t0 = Date.now();
  log(`${label}: ${who.id} (reasoning ${who.reasoning ?? "default"}), ~${Math.round((system.length + prompt.length) / 4).toLocaleString()} input tokens`);
  let streamError: unknown;
  // Streamed so a long reasoning turn cannot hit Node's 300 second wait for
  // response headers, which a buffered request would.
  const result = streamText({
    model: who.model,
    system,
    prompt,
    reasoning: who.reasoning,
    maxOutputTokens: 32_000,
    output: Output.object({ schema }),
    onError: ({ error }) => { streamError = error; },
  });
  let output: T;
  try {
    output = await result.output as T;
  } catch (err) {
    throw new Error(`${label} failed: ${String(streamError ?? err)}`);
  }
  const usage = await result.totalUsage;
  const seconds = Math.round((Date.now() - t0) / 1000);
  usages.push({ role: who.name, label, model: who.id, seconds, usage });
  log(`${label}: done in ${seconds}s, ${usage.inputTokens?.toLocaleString()} in / ${usage.outputTokens?.toLocaleString()} out`);
  return output;
}

// ---------------------------------------------------------------------------
// write

function issueMarkdown(d: Draft): string {
  return `# ${d.title}\n\n*${d.description}*\n\n${d.markdown.trim()}\n`;
}

async function write(dir: string, label: string): Promise<void> {
  const data = load(dir);
  const out = join(dir, "drafts", label);
  mkdirSync(out, { recursive: true });
  const analyst = role("ANALYST");
  const writer = role("WRITER");
  const editor = role("EDITOR");
  const voice = readFileSync(join(ROOT, "agent/lib/dispatch/voice.md"), "utf8");

  const ids = new Map(data.posts.map((p, i) => [p.uri, `p${i + 1}`]));
  const byId = new Map(data.posts.map((p, i) => [`p${i + 1}`, p]));
  const window = data.manifest.window;
  const header = `Window: ${window.since} to ${window.until} (UTC). Sources: ${JSON.stringify(data.manifest.sources)}. Collection notes: ${JSON.stringify(data.manifest.notes)}.`;
  const posts = postsText(data.posts, ids);

  log(`writing from ${dir}: ${data.posts.length} posts, ${data.lexicons?.newLexicons.length ?? 0} new lexicons`);
  const slices: Array<[keyof typeof ANALYST_SLICES, string]> = [
    ["lexicons", data.lexicons ? lexiconsText(data.lexicons) : "Lexicon data was unavailable this run."],
    ["conversation", posts],
    ["shipping", `${posts}\n\nRELEASES\n${releasesText(data.releases)}`],
  ];
  // --reuse <label> takes the analysts' findings from an earlier run, so a
  // writer or voice change is compared on identical findings at a third of
  // the cost. --rerun names slices to analyse again anyway.
  const reuse = arg("reuse");
  const rerun = new Set((arg("rerun") ?? "").split(",").filter(Boolean));
  const previous: Record<string, Findings> = reuse ? JSON.parse(readFileSync(join(dir, "drafts", reuse, "findings.json"), "utf8")) : {};
  const findings = Object.fromEntries(await Promise.all(slices.map(async ([slice, body]) => {
    if (previous[slice] && !rerun.has(slice)) {
      log(`analyst:${slice}: reusing findings from ${reuse}`);
      return [slice, previous[slice]] as const;
    }
    return [slice, await call(analyst, `analyst:${slice}`, `${ANALYST}\n\n${ANALYST_SLICES[slice]}`, `${header}\n\n${body}`, Findings)] as const;
  })));
  writeFileSync(join(out, "findings.json"), JSON.stringify(findings, null, 2));

  // Everything a finding cites, resolved by code, so the writer quotes and
  // links from the record itself rather than from an analyst's paraphrase.
  const lexiconRows = new Map<string, unknown>();
  for (const n of data.lexicons?.newLexicons ?? []) lexiconRows.set(n.nsid, { nsid: n.nsid, accounts: n.accounts, creates: n.creates, flags: n.flags, explore: n.explore, schema: n.schema });
  for (const m of [...(data.lexicons?.movers.up ?? []), ...(data.lexicons?.movers.down ?? [])]) lexiconRows.set(m.nsid, m);
  for (const r of data.lexicons?.topOutsideBluesky ?? []) if (!lexiconRows.has(r.nsid)) lexiconRows.set(r.nsid, r);
  for (const s of data.lexicons?.publishedSchemas ?? []) {
    if (!lexiconRows.has(s.nsid)) lexiconRows.set(s.nsid, { ...s, note: "schema published in the window (sampled)", explore: `https://aturi.to/explore/lexicons/${s.nsid}` });
  }
  // An NSID an analyst found in a post rather than in the lexicon report.
  const mentionedIn = (nsid: string) => data.posts.filter((p) => p.text.includes(nsid) || p.links.some((l) => l.includes(nsid)))
    .map((p) => ({ id: ids.get(p.uri), url: p.url, text: p.text }));
  const releasesByUrl = new Map(data.releases.flatMap((r) => r.releases.map((x) => [x.url, x] as const)));
  const sources: Record<string, unknown> = {};
  const unresolved: string[] = [];
  for (const f of Object.values(findings).flatMap((x) => x.findings)) {
    for (const id of f.evidence) {
      const post = byId.get(id);
      if (post) sources[id] = { url: post.url, author: post.author.handle, name: post.author.displayName, profile: `https://bsky.app/profile/${post.author.handle}`, createdAt: post.createdAt, likes: post.likes, reposts: post.reposts, replies: post.replies, text: post.text, links: post.links, quoted: post.quoted && (ids.get(post.quoted) ?? post.quoted) };
      else if (lexiconRows.has(id)) sources[id] = lexiconRows.get(id);
      else if (releasesByUrl.has(id)) sources[id] = releasesByUrl.get(id);
      else if (mentionedIn(id).length) sources[id] = { nsid: id, note: "named in posts, not in the lexicon report", posts: mentionedIn(id) };
      else unresolved.push(id);
    }
  }
  if (unresolved.length) log(`note: ${unresolved.length} evidence ids did not resolve: ${[...new Set(unresolved)].slice(0, 10).join(", ")}`);

  // The editor can only verify what it is handed, so the counts code computed
  // travel with the findings rather than staying with the analyst.
  const counted = data.lexicons ? { totals: data.lexicons.totals, newByProject: data.lexicons.newByProject.slice(0, 40) } : null;
  const brief = `${header}\n\nFINDINGS\n${JSON.stringify(findings, null, 2)}\n\nLEXICON COUNTS (computed by code)\n${JSON.stringify(counted, null, 2)}\n\nSOURCES (by evidence id)\n${JSON.stringify(sources, null, 2)}`;
  const draft = await call(writer, "writer", `${voice}\n\n${WRITER}`, brief, Draft);
  writeFileSync(join(out, "draft.md"), issueMarkdown(draft));

  const haystack = JSON.stringify({ posts: data.posts, lexicons: data.lexicons, releases: data.releases });
  const extra = data.posts.map((p) => `https://bsky.app/profile/${p.author.handle}`);
  const lint = (d: Draft): LintReport => lintDraft(`${d.title}\n${d.description}\n${d.markdown}`, haystack, extra);
  const draftLint = lint(draft);
  writeFileSync(join(out, "lint-draft.json"), JSON.stringify(draftLint, null, 2));
  log(`draft lint: ${draftLint.ok ? "clean" : JSON.stringify({ ...draftLint, ok: undefined })}`);

  const edited = await call(editor, "editor", `${voice}\n\n${EDITOR}`,
    `${brief}\n\nDRAFT\n${JSON.stringify(draft, null, 2)}\n\nLINT REPORT\n${JSON.stringify(draftLint, null, 2)}`, Edited);
  const finalLint = lint(edited);
  writeFileSync(join(out, "final.md"), issueMarkdown(edited));
  writeFileSync(join(out, "editor.json"), JSON.stringify({ changes: edited.changes, openQuestions: edited.openQuestions, lint: finalLint }, null, 2));
  writeFileSync(join(out, "usage.json"), JSON.stringify(usages, null, 2));

  const total = usages.reduce((sum, u) => ({ in: sum.in + (u.usage.inputTokens ?? 0), out: sum.out + (u.usage.outputTokens ?? 0) }), { in: 0, out: 0 });
  log(`final lint: ${finalLint.ok ? "clean" : JSON.stringify({ ...finalLint, ok: undefined })}`);
  log(`final: ${finalLint.words} words, ${edited.changes.length} editor changes, ${edited.openQuestions.length} open questions`);
  log(`tokens: ${total.in.toLocaleString()} in, ${total.out.toLocaleString()} out`);
  log(`wrote ${join(out, "final.md")}`);
}

// ---------------------------------------------------------------------------

const command = process.argv[2];
const days = Number(arg("days") ?? 7);
const label = arg("label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
if (command === "collect") await collect(days);
else if (command === "write" && process.argv[3]) await write(process.argv[3], label);
else if (command === "demo") await write(await collect(days), label);
else {
  console.error("usage: node scripts/dispatch-demo.ts collect [--days 7] | write <run dir> [--label name] [--reuse <label> [--rerun <slices>]] | demo [--days 7]");
  process.exit(1);
}
