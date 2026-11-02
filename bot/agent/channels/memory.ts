import { generateText } from "ai";
import { defineChannel, POST } from "eve/channels";
import { z } from "zod";
import { secretMatches } from "../lib/bluesky";
import {
  ADMIN_SECRET_HEADER, AdminCall, AdminError, adminSecretMatches, forgetEverywhere, rollUpJournals, runAdminCall,
  snapshotDocs,
} from "../lib/memory-admin";
import { MODEL } from "../lib/model";

/**
 * Poe's memory, reached from outside a conversation. No turn ever runs here:
 *
 *   POST /admin/memory    the admin page on atpota.to, through the website's
 *                         admin proxy (ADMIN_SHARED_SECRET), reads and edits
 *                         every private memory (lib/memory-admin.ts)
 *   POST /memory/forget   the droplet, when someone posts "forget me": their
 *                         notes and any journal note naming them, in code
 *   POST /memory/rollup   the droplet's clock, early each month: a summary of
 *                         each finished month of the journals (lib/journal.ts)
 *   POST /memory/snapshot the droplet, once: every private document as it
 *                         stands, to start its backup log from
 */

const MAX_BODY = 160 * 1024;

async function body(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return undefined;
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

const Snapshot = z.strictObject({ operators: z.array(z.string().max(300)).max(20) });

const Forget = z.strictObject({
  did: z.string().regex(/^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]{1,253})$/),
  handle: z.string().max(253).nullable().optional(),
});

const SUMMARY_BRIEF = [
  "You are Poe, a small potato who lives in the Atmosphere (the atproto network) and keeps a journal.",
  "Below are your own journal notes from one month. Write a summary of that month in two or three short",
  "sentences, first person, lowercase, in your own warm voice: what happened, what you noticed, what you",
  "were excited or unsure about. Only what the notes say; never invent anything. No names, handles, DIDs",
  "or quotes of other people. Under 500 characters. Reply with the summary alone.",
].join(" ");

async function summarize(journal: string, month: string, notes: readonly string[]): Promise<string> {
  const { text } = await generateText({
    model: MODEL,
    abortSignal: AbortSignal.timeout(60_000),
    prompt: `${SUMMARY_BRIEF}\n\nThe ${journal === "life" ? "public life" : "private DM"} journal, ${month}:\n` +
      notes.map((note) => `- ${note}`).join("\n"),
  });
  return text;
}

export default defineChannel({
  routes: [
    POST("/admin/memory", async (request) => {
      if (!adminSecretMatches(request.headers.get(ADMIN_SECRET_HEADER))) return new Response(null, { status: 401 });
      const parsed = AdminCall.safeParse(await body(request));
      if (!parsed.success) return json({ error: "bad request" }, 400);
      try {
        return json(await runAdminCall(parsed.data, AbortSignal.timeout(20_000)));
      } catch (err) {
        if (err instanceof AdminError) return json({ error: err.message }, err.status);
        // The error name only: a Blob error can quote the key.
        console.error("admin memory call failed", parsed.data.action, err instanceof Error ? err.name : "unknown");
        return json({ error: "memory unavailable" }, 502);
      }
    }),

    POST("/memory/forget", async (request) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) return new Response(null, { status: 401 });
      const parsed = Forget.safeParse(await body(request));
      if (!parsed.success) return new Response(null, { status: 400 });
      try {
        return json(await forgetEverywhere(parsed.data.did, parsed.data.handle ?? null, AbortSignal.timeout(20_000)));
      } catch (err) {
        console.error("forget failed", err instanceof Error ? err.name : "unknown");
        return new Response(null, { status: 502 });
      }
    }),

    POST("/memory/snapshot", async (request) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) return new Response(null, { status: 401 });
      const parsed = Snapshot.safeParse(await body(request));
      if (!parsed.success) return new Response(null, { status: 400 });
      try {
        return json({ docs: await snapshotDocs(parsed.data.operators, AbortSignal.timeout(20_000)) });
      } catch (err) {
        console.error("snapshot failed", err instanceof Error ? err.name : "unknown");
        return new Response(null, { status: 502 });
      }
    }),

    POST("/memory/rollup", async (request, { waitUntil }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) return new Response(null, { status: 401 });
      waitUntil(rollUpJournals(summarize, AbortSignal.timeout(240_000)).then(
        (done) => console.log("journal rollup", JSON.stringify(done)),
        (err) => console.error("journal rollup failed", err instanceof Error ? err.name : "unknown"),
      ));
      return new Response(null, { status: 202 });
    }),
  ],
});
