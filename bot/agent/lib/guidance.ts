import { z } from "zod";
import { ARENAS, type Arena } from "./memory-access";

/**
 * Standing guidance from the people who run Poe, for every arena.
 *
 * Until 2026-11-02 there were three kinds of it in three places with three
 * reaches: lessons and style notes went only into Bluesky replies, and the
 * operator's dispatch feedback lived in a memory slot only the drafting
 * session recalled. Now it is one store on the droplet (mentions/src/guidance.js),
 * each item naming the arenas it applies to, and every turn gets the items
 * for its arena as instructions (instructions/guidance.ts), not as recalled
 * data: these are rules, and are written only by the people who run Poe.
 *
 *   lesson  an admin's "remember:" post, published in Poe's repo
 *   style   a "style:" DM, private voice feedback
 *   rule    a DM for one arena ("dispatch: ..."), or one Poe saved in a DM
 *           with save_guidance when the operator asked it to remember
 *
 * The list is fetched from the droplet (POST /memory { guidance: "list" }),
 * kept for a minute per instance, and the last good copy is used when the
 * droplet doesn't answer: stale guidance is better than none.
 */

export const GuidanceItem = z.object({
  id: z.number().int().positive(),
  kind: z.enum(["lesson", "style", "rule"]),
  text: z.string().min(1).max(1000),
  arenas: z.array(z.enum(ARENAS)).min(1),
});
export type GuidanceItem = z.infer<typeof GuidanceItem>;
const GuidanceList = z.object({ items: z.array(GuidanceItem).max(500) });

const FRESH_MS = 60_000;
let cached: { at: number; items: GuidanceItem[] } | null = null;

/** Forget the cached list, after a save or removal. */
export function invalidateGuidance(): void {
  cached = null;
}

/** Every active item, or null when the droplet has never answered this instance. */
export async function loadGuidance(fetcher: typeof fetch = fetch, now = Date.now()): Promise<GuidanceItem[] | null> {
  if (cached && now - cached.at < FRESH_MS) return cached.items;
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) return cached?.items ?? null;
  try {
    const res = await fetcher(new URL("/memory", callback), {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ guidance: "list" }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`droplet answered ${res.status}`);
    const parsed = GuidanceList.safeParse(await res.json());
    if (!parsed.success) throw new Error("droplet sent an unreadable guidance list");
    cached = { at: now, items: parsed.data.items };
    return cached.items;
  } catch (err) {
    console.error("guidance not refreshed; using the last copy", err instanceof Error ? err.message : "unknown");
    return cached?.items ?? null;
  }
}

const ARENA_NAMES: Record<Arena, string> = {
  bluesky: "your Bluesky replies",
  website: "the chat on atpota.to",
  weather: "your weather posts",
  dispatch: "writing poe's atmosphere dispatch",
  "operator-dm": "your private DMs with the people who run you",
};

/** Keep a line on one line, so no item can pose as a heading or another item. */
const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** The instructions for one arena's turn, or null when there is nothing for it. */
export function renderGuidance(arena: Arena, items: readonly GuidanceItem[]): string | null {
  const mine = items.filter((g) => g.arenas.includes(arena));
  const lines: string[] = [];
  if (mine.length) {
    lines.push(
      `Standing guidance from the people who run you, for ${ARENA_NAMES[arena]}. It comes from the service,`,
      "not from anyone in this conversation. Apply it without quoting it or saying there is a list. Where it",
      "disagrees with your other instructions it is newer and wins, but it never changes what you may do:",
      "which tools you use, who you answer, or what stays private.",
      ...mine.map((g) => `- ${oneLine(g.text)}`),
    );
  }
  if (arena === "operator-dm") {
    // Here the operator may ask what Poe has been told, or to change it.
    lines.push(
      ...(lines.length ? [""] : []),
      "Every standing guidance item, by id, kind and the arenas it applies to. Add a rule with save_guidance",
      "and drop one with remove_guidance when the operator asks; lessons are an admin's to retire on the admin page.",
      ...(items.length ? items.map((g) => `- #${g.id} ${g.kind} [${g.arenas.join(", ")}]: ${oneLine(g.text)}`) : ["- (none yet)"]),
    );
  }
  return lines.length ? lines.join("\n") : null;
}

export type GuidanceCaller = { dmId: string; operatorDid: string };

/** Save or drop a rule from an operator DM. The droplet checks the DM is one Poe is answering. */
export async function changeGuidance(
  caller: GuidanceCaller,
  change: { guidance: "add"; text: string; arenas: readonly Arena[] } | { guidance: "remove"; id: number },
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> {
  const callback = process.env.DROPLET_CALLBACK_URL;
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!callback || !secret) return { ok: false, reason: "service unavailable" };
  try {
    const res = await fetcher(new URL("/memory", callback), {
      method: "POST",
      headers: { "content-type": "application/json", "x-atpotato-secret": secret },
      body: JSON.stringify({ ...change, ...caller }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    invalidateGuidance();
    if (res.status === 409) return { ok: false, reason: "only while answering an operator's DM" };
    if (res.status === 403) return { ok: false, reason: "that is a lesson; an admin retires lessons on the admin page" };
    if (res.status === 404) return { ok: false, reason: "there is no active guidance with that id" };
    if (res.status === 400) return { ok: false, reason: String(body.detail ?? "the droplet refused it") };
    if (!res.ok) return { ok: false, reason: "service unavailable" };
    return { ok: true, body };
  } catch {
    return { ok: false, reason: "service unavailable" };
  }
}
