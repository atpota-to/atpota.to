/**
 * Demo pipeline for the weekly dispatch: collect a week of real data, then
 * write an issue from it with the analyst, writer and editor roles, so the
 * format and voice can be tuned before the production pipeline exists.
 *
 *   node scripts/dispatch-demo.ts collect [--week | --days 7]
 *   node scripts/dispatch-demo.ts write .dispatch/runs/<date> [--label name]
 *        [--reuse <earlier label> [--rerun lexicons,posts]] [--analysts-only]
 *   node scripts/dispatch-demo.ts demo [--week | --days 7]
 *   node scripts/dispatch-demo.ts sites .dispatch/runs/<date>
 *
 * `sites` adds the app-site checks to a week collected before they existed,
 * without re-collecting it (which would renumber the posts and break --reuse).
 *
 * --week collects the last full Monday-to-Monday UTC week, the window
 * production recaps; without it, the 7 days ending now.
 *
 * `write` can be re-run on the same collected week as often as you like, so a
 * change to agent/lib/dispatch/voice.md or roles.ts can be compared against
 * the same data. Each run writes to its own drafts/<label>/ folder.
 *
 * Nothing is posted or published. Output stays in .dispatch/, which is
 * gitignored because it holds other people's posts.
 *
 * Models: DISPATCH_{ANALYST,WRITER,EDITOR}_MODEL, defaulting to Claude Sonnet
 * 5.5 for the analysts and Claude Opus 5.5 for the writer and editor (see
 * DEFAULT_MODELS). Reasoning: DISPATCH_{...}_REASONING, default high. Both are
 * read from .env.local and .env.development.local the way eve reads them, so
 * `npx eve link` is enough.
 *
 * Unlike production, the analysts get their slice in the prompt rather than as
 * sandbox files. A demo week fits in the context window; a large builders list
 * may not, and production moves to files for that reason.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Output, streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import type { z } from "zod";
import { checkSites, collectWeek, groupNewLexicons, lastDays, LINKABLE_SITES, looksLikeNsid, previousWeek, type DispatchDataset, type DispatchPost, type LexiconReport, type ReleaseResult } from "../agent/lib/dispatch/collect.ts";
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

/**
 * The analysts read most of the tokens, about 410,000 of a run's 620,000, and
 * their job is finding and sorting; the writer and editor read far less and
 * carry the voice and the fact-checking. So the analysts default to Sonnet and
 * the other two to Opus. The 2026-10-19 comparison behind this is in
 * agent-spec/12-weekly-dispatch.md.
 */
const DEFAULT_MODELS = {
  ANALYST: "anthropic/claude-sonnet-5.5",
  WRITER: "anthropic/claude-opus-5.5",
  EDITOR: "anthropic/claude-opus-5.5",
};

/**
 * Anthropic list prices per million tokens (input, cache read, output), as of
 * October 2026, for an estimate in the log. The gateway's charges can differ.
 */
const PRICES: Record<string, [number, number, number]> = {
  "anthropic/claude-opus-5.5": [4, 0.2, 20],
  "anthropic/claude-sonnet-5.5": [2, 0.2, 10],
};

function dollars(model: string, usage: LanguageModelUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return (((usage.inputTokens ?? 0) - cached) * price[0] + cached * price[1] + (usage.outputTokens ?? 0) * price[2]) / 1e6;
}

function role(name: "ANALYST" | "WRITER" | "EDITOR"): Role {
  const env = (key: string) => process.env[key]?.trim() || undefined;
  const id = env(`DISPATCH_${name}_MODEL`) ?? DEFAULT_MODELS[name];
  const reasoning = env(`DISPATCH_${name}_REASONING`) ?? "high";
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

async function collect(days: number, week: boolean): Promise<string> {
  const window = week ? previousWeek(new Date()) : lastDays(new Date(), days);
  // A full week is named like an issue, by the Monday it starts.
  const dir = join(ROOT, ".dispatch/runs", week ? `week-${window.since.slice(0, 10)}` : window.until.slice(0, 10));
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

async function sites(dir: string): Promise<void> {
  const path = join(dir, "lexicons.json");
  const report = upgrade(JSON.parse(readFileSync(path, "utf8")));
  if (!report) throw new Error(`no lexicon report in ${dir}`);
  report.sites = await checkSites(fetch, report, log);
  writeFileSync(path, JSON.stringify(report, null, 2));
  for (const c of report.sites) log(`${c.verdict.padEnd(11)} ${c.url} | ${c.why} | ${c.title ?? "-"}`);
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

function lexiconsText(report: LexiconReport, posts: DispatchPost[], ids: Map<string, string>): string {
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
  out.push("", "APP SITES, checked by code. project | url | verdict | why | page title");
  for (const c of report.sites ?? []) out.push(`${c.root} | ${c.url} | ${c.verdict} | ${c.why} | ${c.title ?? "-"}`);
  const byUri = new Map(posts.map((p) => [p.uri, p]));
  out.push("", "LEXICON TALK: posts by the account at each project's domain, and posts naming the domain");
  for (const t of report.talk ?? []) {
    out.push("", `${t.root} (${t.domain}): ${t.why}${t.notes.length ? `. ${t.notes.join("; ")}` : ""}`);
    const found = t.posts.map((uri) => byUri.get(uri)).filter((p): p is DispatchPost => !!p);
    out.push(found.length ? postsText(found, ids) : "  (no posts found)");
  }
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
  const cost = dollars(who.id, usage);
  log(`${label}: done in ${seconds}s, ${usage.inputTokens?.toLocaleString()} in / ${usage.outputTokens?.toLocaleString()} out${cost === undefined ? "" : `, about $${cost.toFixed(2)}`}`);
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
  // One analyst for posts and releases, one for lexicons. Conversation and
  // shipping were separate analysts reading the same 238,000 tokens twice.
  const slices: Array<[keyof typeof ANALYST_SLICES, string]> = [
    ["lexicons", data.lexicons ? lexiconsText(data.lexicons, data.posts, ids) : "Lexicon data was unavailable this run."],
    ["posts", `${posts}\n\nRELEASES\n${releasesText(data.releases)}`],
  ];
  // --reuse <label> takes the analysts' findings from an earlier run, so a
  // writer or voice change is compared on identical findings for a fraction of
  // the cost. --rerun names slices to analyse again anyway.
  const reuse = arg("reuse");
  const rerun = new Set((arg("rerun") ?? "").split(",").filter(Boolean));
  const previous: Record<string, Findings> & { _posts?: string } = reuse ? JSON.parse(readFileSync(join(dir, "drafts", reuse, "findings.json"), "utf8")) : {};
  // Findings cite posts by position (p12), so they only mean something
  // against the same posts in the same order.
  const postsSha = createHash("sha256").update(data.posts.map((p) => p.uri).join("\n")).digest("hex");
  if (reuse && previous._posts && previous._posts !== postsSha) {
    throw new Error(`--reuse ${reuse}: those findings were made from a different set of posts`);
  }
  const findings = Object.fromEntries(await Promise.all(slices.map(async ([slice, body]) => {
    if (previous[slice] && !rerun.has(slice)) {
      log(`analyst:${slice}: reusing findings from ${reuse}`);
      return [slice, previous[slice]] as const;
    }
    return [slice, await call(analyst, `analyst:${slice}`, `${ANALYST}\n\n${ANALYST_SLICES[slice]}`, `${header}\n\n${body}`, Findings)] as const;
  })));
  writeFileSync(join(out, "findings.json"), JSON.stringify({ ...findings, _posts: postsSha }, null, 2));
  if (process.argv.includes("--analysts-only")) return finish(out);

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
  const sites = data.lexicons?.sites ?? [];
  const linkable = sites.filter((c) => LINKABLE_SITES.has(c.verdict)).map(({ root, url, verdict, why, title }) => ({ root, url, verdict, why, title }));
  const blocked = sites.filter((c) => !LINKABLE_SITES.has(c.verdict)).map((c) => c.url);
  const brief = `${header}\n\nFINDINGS\n${JSON.stringify(findings, null, 2)}\n\nLEXICON COUNTS (computed by code)\n${JSON.stringify(counted, null, 2)}` +
    `\n\nAPP SITES YOU MAY LINK (checked by code)\n${JSON.stringify(linkable, null, 2)}\n\nAPP SITES YOU MUST NOT LINK\n${JSON.stringify(blocked)}` +
    `\n\nSOURCES (by evidence id)\n${JSON.stringify(sources, null, 2)}`;
  const draft = await call(writer, "writer", `${voice}\n\n${WRITER}`, brief, Draft);
  writeFileSync(join(out, "draft.md"), issueMarkdown(draft));

  const haystack = JSON.stringify({ posts: data.posts, lexicons: data.lexicons, releases: data.releases });
  const extra = data.posts.map((p) => `https://bsky.app/profile/${p.author.handle}`);
  const lint = (d: Draft): LintReport => lintDraft(`${d.title}\n${d.description}\n${d.markdown}`, haystack, extra, blocked);
  const draftLint = lint(draft);
  writeFileSync(join(out, "lint-draft.json"), JSON.stringify(draftLint, null, 2));
  log(`draft lint: ${draftLint.ok ? "clean" : JSON.stringify({ ...draftLint, ok: undefined })}`);

  const edited = await call(editor, "editor", `${voice}\n\n${EDITOR}`,
    `${brief}\n\nDRAFT\n${JSON.stringify(draft, null, 2)}\n\nLINT REPORT\n${JSON.stringify(draftLint, null, 2)}`, Edited);
  const finalLint = lint(edited);
  writeFileSync(join(out, "final.md"), issueMarkdown(edited));
  writeFileSync(join(out, "editor.json"), JSON.stringify({ changes: edited.changes, openQuestions: edited.openQuestions, lint: finalLint }, null, 2));
  log(`final lint: ${finalLint.ok ? "clean" : JSON.stringify({ ...finalLint, ok: undefined })}`);
  log(`final: ${finalLint.words} words, ${edited.changes.length} editor changes, ${edited.openQuestions.length} open questions`);
  finish(out);
  log(`wrote ${join(out, "final.md")}`);
}

function finish(out: string): void {
  const priced = usages.map((u) => ({ ...u, dollars: dollars(u.model, u.usage) }));
  writeFileSync(join(out, "usage.json"), JSON.stringify(priced, null, 2));
  const total = priced.reduce((sum, u) => ({
    in: sum.in + (u.usage.inputTokens ?? 0), out: sum.out + (u.usage.outputTokens ?? 0), dollars: sum.dollars + (u.dollars ?? 0),
  }), { in: 0, out: 0, dollars: 0 });
  log(`tokens: ${total.in.toLocaleString()} in, ${total.out.toLocaleString()} out, about $${total.dollars.toFixed(2)} at list prices`);
}

// ---------------------------------------------------------------------------

const command = process.argv[2];
const days = Number(arg("days") ?? 7);
const label = arg("label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const week = process.argv.includes("--week");
if (command === "sites" && process.argv[3]) await sites(process.argv[3]);
else if (command === "collect") await collect(days, week);
else if (command === "write" && process.argv[3]) await write(process.argv[3], label);
else if (command === "demo") await write(await collect(days, week), label);
else {
  console.error("usage: node scripts/dispatch-demo.ts collect [--week | --days 7] | write <run dir> [--label name] [--reuse <label> [--rerun <slices>]] [--analysts-only] | demo [--week | --days 7] | sites <run dir>");
  process.exit(1);
}
