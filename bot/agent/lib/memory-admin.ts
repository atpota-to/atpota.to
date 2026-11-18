import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MemoryDocumentConflictError } from "eve/memory/file";
import {
  type JournalArchive, archiveKey, readArchive, rollUp, updateArchive,
} from "./journal";
import { MEMORY_ACCESS } from "./memory-access";
import { slotKey } from "./memory-key";
import { personScope } from "./person-scope";
import {
  type Note, datedNote, forgetNotes, formatNotes, handOver, logVersion, memoryStore, normalizedNote, parseNotes,
  unpublishableNote,
} from "./published-memory";

/**
 * Poe's memory, read and changed from outside a turn: by an admin on
 * atpota.to (channels/memory.ts, /admin/memory), and by the droplet when
 * someone asks to be forgotten or a month of journal needs summing up.
 *
 * Every write here is conditional on the version just read, like eve's own,
 * so it can't undo a note Poe saved a moment earlier, and every version is
 * handed to the droplet's backup log with who made it.
 */

export const ADMIN_SECRET_HEADER = "x-atpotato-admin-secret";

/**
 * Constant-time compare against ADMIN_SHARED_SECRET, which only the website's
 * admin proxy holds (website/server/admin.ts). It may read and change any of
 * Poe's memory, so it must be neither of the other two secrets: the website's
 * chat secret can only assert a visitor, and the droplet's is on the droplet.
 * Fails closed when unset or when it equals either.
 */
export function adminSecretMatches(presented: string | null): boolean {
  const expected = process.env.ADMIN_SHARED_SECRET;
  if (!expected || !presented) return false;
  if (expected === process.env.WEBSITE_SHARED_SECRET || expected === process.env.DROPLET_SHARED_SECRET) {
    console.error("ADMIN_SHARED_SECRET must differ from WEBSITE_SHARED_SECRET and DROPLET_SHARED_SECRET; refusing admin calls");
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The slots that hold one document for all of Poe, with the scope each is kept under. */
const SHARED_SCOPES = {
  life: "poe-life",
  "operator-dm-life": "poe-operator-dm-life",
  self: "poe-self",
} as const;
/**
 * The dispatch notes slot of 2026-11-02 morning, before guidance: no longer a
 * slot, but its document is handed over once in the snapshot, and the droplet
 * copies its notes into guidance (mentions/src/memory-digest.js seedMemoryLog).
 */
const LEGACY_DISPATCH_NOTES = { slot: "dispatch-notes", scope: "poe-dispatch-notes" } as const;
const JOURNALS = new Set<string>(["life", "operator-dm-life"]);

const Did = z.string().regex(/^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]{1,253})$/);
const Slot = z.enum(["life", "operator-dm-life", "self", "operator-notes", "person"]);
type SlotName = z.infer<typeof Slot>;
const Where = { slot: Slot, did: Did.optional(), by: Did };
const NoteText = z.string().trim().min(1).max(2000);

export const AdminCall = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("overview"), by: Did, operators: z.array(Did).max(20) }),
  z.strictObject({ action: z.literal("read"), ...Where }),
  z.strictObject({ action: z.literal("add"), ...Where, text: NoteText }),
  z.strictObject({ action: z.literal("edit"), ...Where, index: z.number().int().min(0), text: NoteText }),
  z.strictObject({ action: z.literal("remove"), ...Where, index: z.number().int().min(0) }),
  z.strictObject({ action: z.literal("restore"), ...Where, content: z.string().max(65_536) }),
  z.strictObject({ action: z.literal("remove-archived"), ...Where, month: z.string().regex(/^(\d{4}-\d{2}|undated)$/), text: z.string().max(4000) }),
]);
export type AdminCall = z.infer<typeof AdminCall>;

export class AdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Place { slot: SlotName; key: string; label: string; did: string | null }

function placeOf(slot: SlotName, did: string | undefined): Place {
  if (slot === "operator-notes" || slot === "person") {
    if (!did) throw new AdminError(400, `${slot} needs a did`);
    return { slot, key: slotKey(slot, slot === "person" ? personScope(did) : did), label: did, did };
  }
  return { slot, key: slotKey(slot, SHARED_SCOPES[slot]), label: SHARED_SCOPES[slot], did: null };
}

export interface SlotView {
  slot: string;
  scope: string;
  about: string;
  notes: Note[];
  characters: number;
  archive?: { month: string; notes: string[]; summary: string | null }[];
}

async function view(place: Place, signal: AbortSignal): Promise<SlotView> {
  const doc = await memoryStore.read({ key: place.key, signal });
  const notes = doc ? parseNotes(doc.content)?.notes ?? [] : [];
  const about = (MEMORY_ACCESS as Record<string, { about: string }>)[place.slot]?.about ?? "";
  const result: SlotView = {
    slot: place.slot, scope: place.label, about, notes,
    characters: notes.reduce((n, note) => n + note.text.length, 0),
  };
  if (JOURNALS.has(place.slot)) {
    const { archive } = await readArchive(place.key, signal);
    result.archive = archiveView(archive);
  }
  return result;
}

function archiveView(archive: JournalArchive) {
  return Object.keys(archive.months).sort().reverse().map((month) => ({
    month, notes: archive.months[month].notes, summary: archive.months[month].summary ?? null,
  }));
}

/**
 * Change one document: `change` gets the notes and counter as stored and
 * returns the new ones, or throws AdminError. Retries on a conflicting write.
 */
async function changeNotes(
  place: Place, by: string, signal: AbortSignal,
  change: (current: { lastIndex: number; notes: Note[] }) => { lastIndex: number; notes: Note[] },
): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const doc = await memoryStore.read({ key: place.key, signal });
    const current = doc ? parseNotes(doc.content) : { lastIndex: -1, notes: [] };
    if (!current) throw new AdminError(409, "the stored document isn't a memory document");
    const next = change(current);
    const content = formatNotes(next.lastIndex, next.notes);
    if (doc && content === doc.content) return content;
    try {
      await memoryStore.write({ key: place.key, content, expectedVersion: doc?.version ?? null, signal });
    } catch (err) {
      if (MemoryDocumentConflictError.is(err)) continue;
      throw err;
    }
    if (place.slot === "person" && place.did) {
      // The droplet publishes person notes and keeps their history itself.
      await handOver(place.did, content, 5000);
    } else {
      await logVersion({ slot: place.slot, scope: place.label, content, source: `admin:${by}` });
    }
    return content;
  }
  throw new AdminError(409, "the notes kept changing; try again");
}

function noteFor(place: Place, text: string): string {
  if (place.slot === "person") {
    const refusal = unpublishableNote(text);
    if (refusal) throw new AdminError(400, refusal);
    return normalizedNote(text);
  }
  return normalizedNote(datedNote(text));
}

/** Run one admin call. Throws AdminError for a call that can't be done. */
export async function runAdminCall(call: AdminCall, signal: AbortSignal): Promise<unknown> {
  if (call.action === "overview") {
    const shared = await Promise.all((Object.keys(SHARED_SCOPES) as SlotName[]).map((slot) => view(placeOf(slot, undefined), signal)));
    const operators = await Promise.all([...new Set(call.operators)].map((did) => view(placeOf("operator-notes", did), signal)));
    return { slots: [...shared, ...operators] };
  }

  const place = placeOf(call.slot, call.did);
  if (call.action === "read") return view(place, signal);

  if (call.action === "add") {
    const text = noteFor(place, call.text);
    await changeNotes(place, call.by, signal, ({ lastIndex, notes }) =>
      ({ lastIndex: lastIndex + 1, notes: [...notes, { index: lastIndex + 1, text }] }));
    return view(place, signal);
  }

  if (call.action === "edit") {
    await changeNotes(place, call.by, signal, ({ lastIndex, notes }) => {
      const old = notes.find((n) => n.index === call.index);
      if (!old) throw new AdminError(404, `there is no note ${call.index}`);
      // A private note keeps the day it was first saved.
      const day = /^\[\d{4}-\d{2}-\d{2}\] /.exec(old.text)?.[0];
      const text = place.slot === "person" ? noteFor(place, call.text)
        : normalizedNote(`${day ?? ""}${call.text.trim().replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "")}`);
      return { lastIndex, notes: notes.map((n) => (n.index === call.index ? { index: n.index, text } : n)) };
    });
    return view(place, signal);
  }

  if (call.action === "remove") {
    await changeNotes(place, call.by, signal, ({ lastIndex, notes }) => {
      if (!notes.some((n) => n.index === call.index)) throw new AdminError(404, `there is no note ${call.index}`);
      return { lastIndex, notes: notes.filter((n) => n.index !== call.index) };
    });
    return view(place, signal);
  }

  if (call.action === "restore") {
    const restored = parseNotes(call.content);
    if (!restored) throw new AdminError(400, "that version isn't a memory document");
    for (const note of restored.notes) {
      if (note.text !== normalizedNote(note.text)) throw new AdminError(400, "that version has a malformed note");
      if (place.slot === "person" && unpublishableNote(note.text)) throw new AdminError(400, unpublishableNote(note.text)!);
    }
    // Never hand out a number a note has had before: keep the higher counter.
    await changeNotes(place, call.by, signal, ({ lastIndex }) =>
      ({ lastIndex: Math.max(lastIndex, restored.lastIndex), notes: restored.notes }));
    return view(place, signal);
  }

  // remove-archived
  if (!JOURNALS.has(place.slot)) throw new AdminError(400, "only a journal has an archive");
  const changed = await updateArchive(place.key, signal, (archive) => {
    const month = archive.months[call.month];
    const at = month?.notes.indexOf(call.text) ?? -1;
    if (!month || at < 0) return false;
    month.notes.splice(at, 1);
    return true;
  }, { slot: place.slot, scope: place.label, source: `admin:${call.by}` });
  if (!changed) throw new AdminError(404, "that archived note isn't there");
  return view(place, signal);
}

/** Whether a journal note names this person, by DID or by handle. */
export function mentions(note: string, did: string, handle: string | null): boolean {
  const text = note.toLowerCase();
  if (text.includes(did.toLowerCase())) return true;
  const h = handle?.toLowerCase().replace(/^@/, "");
  if (!h || !h.includes(".")) return false;
  const escaped = h.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9.-])@?${escaped}($|[^a-z0-9-])`).test(text);
}

export interface ForgetResult { hadNotes: boolean; published: boolean; journalNotesRemoved: number }

/**
 * "Forget me", done in code: wipe the person's own notes (forgetNotes), then
 * take out every journal note that names them, archived ones too. Poe's
 * instructions already keep people out of the journals; this is for the note
 * that slipped through.
 */
export async function forgetEverywhere(did: string, handle: string | null, signal: AbortSignal): Promise<ForgetResult> {
  const notes = await forgetNotes(did);
  let removed = 0;
  for (const slot of JOURNALS) {
    const place = placeOf(slot as SlotName, undefined);
    let fromJournal = 0;
    await changeNotes(place, "forget", signal, ({ lastIndex, notes: current }) => {
      const kept = current.filter((n) => !mentions(n.text, did, handle));
      fromJournal = current.length - kept.length;
      return { lastIndex, notes: kept };
    }).catch((err) => {
      console.error("forget: journal not scrubbed", slot, err instanceof Error ? err.name : "unknown");
    });
    removed += fromJournal;
    let fromArchive = 0;
    await updateArchive(place.key, signal, (archive) => {
      let any = false;
      fromArchive = 0;
      for (const month of Object.values(archive.months)) {
        const kept = month.notes.filter((n) => !mentions(n, did, handle));
        if (kept.length !== month.notes.length) {
          fromArchive += month.notes.length - kept.length;
          month.notes = kept;
          // The summary may name them too, and is rewritten on the next rollup.
          delete month.summary;
          delete month.summarizedNotes;
          any = true;
        }
      }
      return any;
    }, { slot, scope: place.label, source: "forget" }).catch((err) => {
      fromArchive = 0;
      console.error("forget: journal archive not scrubbed", slot, err instanceof Error ? err.name : "unknown");
    });
    removed += fromArchive;
  }
  return { ...notes, journalNotesRemoved: removed };
}

/**
 * Every private document as it stands, for the droplet to seed its backup log
 * with once: the shared slots, the journals' archives, each operator's notes,
 * and the old dispatch notes. Person notes the droplet already has.
 */
export async function snapshotDocs(operators: readonly string[], signal: AbortSignal): Promise<{ slot: string; scope: string; content: string }[]> {
  const docs: { slot: string; scope: string; content: string }[] = [];
  const places = [
    ...(Object.keys(SHARED_SCOPES) as SlotName[]).map((slot) => placeOf(slot, undefined)),
    ...[...new Set(operators)].filter((did) => Did.safeParse(did).success).map((did) => placeOf("operator-notes", did)),
    { slot: LEGACY_DISPATCH_NOTES.slot, key: slotKey(LEGACY_DISPATCH_NOTES.slot, LEGACY_DISPATCH_NOTES.scope), label: LEGACY_DISPATCH_NOTES.scope, did: null },
  ];
  for (const place of places) {
    const doc = await memoryStore.read({ key: place.key, signal });
    if (doc) docs.push({ slot: place.slot, scope: place.label, content: doc.content });
    if (JOURNALS.has(place.slot)) {
      const archive = await memoryStore.read({ key: archiveKey(place.key), signal });
      if (archive) docs.push({ slot: `${place.slot}:archive`, scope: place.label, content: archive.content });
    }
  }
  return docs;
}

/** Sum up each finished month of both journals that needs it. */
export async function rollUpJournals(
  summarize: (journal: string, month: string, notes: readonly string[]) => Promise<string>,
  signal: AbortSignal, now = Date.now(),
): Promise<Record<string, string[]>> {
  const done: Record<string, string[]> = {};
  for (const slot of JOURNALS) {
    const place = placeOf(slot as SlotName, undefined);
    done[slot] = await rollUp(place.key, slot, place.label, signal, (month, notes) => summarize(slot, month, notes), now);
  }
  return done;
}

export { archiveKey };
