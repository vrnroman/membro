import { db } from "@/lib/db";
import { getAdapter } from "@/lib/ai";
import type { AiAdapter, AssistOutput, ResearchBrief } from "@/lib/ai/types";
import {
  listPeople,
  listPeopleIdName,
  listFactContents,
  listFactsForPerson,
  listResearchedSubjects,
  getPerson,
  insertAssist,
  insertConflict,
  deleteAssistsForCapture,
  insertDiaryEntry,
  deleteDiaryForCapture,
} from "@/lib/repo";
import { SELF_ID } from "@/lib/nightshift/scout";
import {
  type AssistJob,
  type CrewFacts,
  rescheduleAssistJob,
  markAssistJobDone,
  markAssistJobFailed,
} from "./queue";
import { backoffMs, MAX_ATTEMPTS } from "./policy";

// Process one queued note as the per-note CREW: several members wake around the
// note and each does its own thing.
//   Drafter / Advisor / Diarist  (adapter.assist) — a draft, a read+reply, a diary
//     entry, or nothing. Durable: a failure retries the whole job.
//   Researcher                    (adapter.research) — a short web-grounded brief on
//     any company / topic the note names that is not on file. Best-effort.
//   Ledger                        (adapter.detectConflicts) — flags a freshly filed
//     fact that actively contradicts one already on file. Best-effort.
// The whole note is already saved before this runs, so this only ever produces the
// *extra*, and it is safe to re-run: it clears its own prior output for the note
// first, conflicts dedupe by fact pair, and diary entries dedupe by content.

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// Bump attempts and push the next try out, or give up once we've tried enough.
// Shared by the AI-call path and the write path so neither loops forever.
function backOffOrGiveUp(job: AssistJob, error: string): void {
  const attemptsDone = job.attempts + 1;
  if (attemptsDone >= MAX_ATTEMPTS) {
    markAssistJobFailed(job.id, `gave up after ${attemptsDone} tries: ${error}`);
    console.error(`[crew] job ${job.id} failed permanently: ${error}`);
    return;
  }
  rescheduleAssistJob(job.id, isoIn(backoffMs(attemptsDone)), error);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Which people already on file does this note name? Best-effort grounding for
// the drafter. Case-SENSITIVE on the stored (capitalized) name so a person named
// "Bill" does not match the common word "bill" in "pay the electric bill" and
// get a wrong-context draft attributed to them.
function mentionedIn(note: string, name: string): boolean {
  const first = name.trim().split(/\s+/)[0];
  if (!first) return false;
  return new RegExp(`\\b${escapeRegex(first)}\\b`).test(note);
}

// Company / person names already on file OR already briefed, so the Researcher
// skips anything the owner has logged before AND never re-briefs the same company
// on a later note (even one that never became a saved contact).
function knownSubjects(): string[] {
  const set = new Set<string>();
  for (const p of listPeople()) {
    if (p.name) set.add(p.name);
    if (p.company) set.add(p.company);
  }
  for (const s of listResearchedSubjects()) set.add(s);
  return [...set];
}

// Very common sentence-openers that are capitalized only because they start a
// sentence, never a subject worth researching.
const SENTENCE_OPENERS = new Set([
  "the", "i", "we", "my", "he", "she", "they", "a", "an", "this", "that", "it", "his", "her", "their",
  "had", "met", "saw", "got", "just", "today", "tomorrow", "yesterday", "also", "then", "after", "before",
  "when", "while", "grabbed", "called", "texted", "spoke", "talked", "caught", "went", "quick", "great", "good",
]);

// Cheap gate before spending a web-search call: does the note plausibly name a
// subject the Researcher could brief? Returns false for pure-lowercase diary lines
// and notes whose only capitalized words are sentence-openers or people/companies
// already known. Lenient: any unfamiliar capitalized token lets the note through
// and the model makes the real call (it stays silent on household names anyway).
function mayNameNewSubject(note: string, known: string[]): boolean {
  const knownFirst = new Set(known.map((k) => k.toLowerCase().split(/\s+/)[0]));
  for (const m of note.matchAll(/\b([A-Z][A-Za-z0-9&.\-]{1,})\b/g)) {
    const low = m[1].toLowerCase();
    if (knownFirst.has(low) || SENTENCE_OPENERS.has(low)) continue;
    return true;
  }
  return false;
}

type FoundConflict = { personId: string; newFactId: string; oldFactId: string; reason: string };

// The Ledger member: for every person the note filed facts about, compare those new
// facts against everything else on file for them. Best-effort per person — one
// person's AI hiccup must not lose the others. Never throws.
async function detectAllConflicts(job: AssistJob, today: string, adapter: AiAdapter): Promise<FoundConflict[]> {
  const out: FoundConflict[] = [];
  if (!job.crew_facts) return out;
  let crew: unknown;
  try {
    crew = JSON.parse(job.crew_facts);
  } catch {
    return out;
  }
  if (!Array.isArray(crew)) return out; // valid JSON that is not an array must not throw the for-of
  for (const cf of crew as CrewFacts[]) {
    if (!cf || !cf.personId || !Array.isArray(cf.factIds) || cf.factIds.length === 0) continue;
    if (cf.personId === SELF_ID) continue; // the diary thread is not a relationship
    try {
      const person = getPerson(cf.personId);
      if (!person) continue;
      const all = listFactsForPerson(cf.personId);
      const newIds = new Set(cf.factIds);
      // Cap what we send: the assist path already slices to a handful, and an
      // unbounded history would inflate cost and can overflow the model context
      // (which the catch below would swallow, silently stopping detection here).
      const newFacts = all.filter((f) => newIds.has(f.id)).slice(0, 20).map((f) => ({ id: f.id, content: f.content }));
      const existingFacts = all.filter((f) => !newIds.has(f.id)).slice(0, 40).map((f) => ({ id: f.id, content: f.content }));
      if (!newFacts.length || !existingFacts.length) continue;
      const found = await adapter.detectConflicts({ personName: person.name, newFacts, existingFacts, today });
      for (const c of found) {
        out.push({ personId: cf.personId, newFactId: c.newFactId, oldFactId: c.oldFactId, reason: c.reason });
      }
    } catch (e) {
      console.error(`[crew] ledger failed for person ${cf.personId} on job ${job.id}:`, (e as Error).message);
    }
  }
  return out;
}

export async function processAssistJob(job: AssistJob): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();
  const hasNote = job.note.trim().length > 0;

  // Drafter / Advisor / Diarist. Durable — a failure here retries the whole job.
  // Skipped for a photo-only note (no text to classify); the Ledger still runs.
  let out: AssistOutput = { kind: "none", title: "", body: "", why: "" };
  let mentioned: { id: string; name: string }[] = [];
  if (hasNote) {
    const roster = listPeopleIdName().filter((p) => p.id !== SELF_ID);
    mentioned = roster.filter((p) => mentionedIn(job.note, p.name));
    const people = mentioned.map((p) => ({ name: p.name, facts: listFactContents(p.id).slice(0, 8) }));
    try {
      out = await adapter.assist({ note: job.note, today, people });
    } catch (e) {
      backOffOrGiveUp(job, (e as Error).message);
      return;
    }
  }

  // Researcher. Best-effort — a failure must not block the assist output, the
  // Ledger, or the job completing. A cheap proper-noun gate skips the web-search
  // call entirely for diary lines and notes that name nothing new.
  let briefs: ResearchBrief[] = [];
  if (hasNote) {
    const known = knownSubjects();
    if (mayNameNewSubject(job.note, known)) {
      try {
        briefs = await adapter.research({ note: job.note, today, knownSubjects: known });
      } catch (e) {
        console.error(`[crew] researcher failed on job ${job.id}:`, (e as Error).message);
      }
    }
  }

  // Ledger. Best-effort, computed before the write so its rows commit atomically
  // with the rest.
  const conflicts = await detectAllConflicts(job, today, adapter);

  // One transaction: replace this note's prior crew output, write the new output,
  // record any contradictions, mark the job done. If any write throws, nothing
  // commits and we take the bounded-retry path instead of re-running forever.
  try {
    const apply = db().transaction(() => {
      // Clear any prior output for THIS note so a retry replaces, never duplicates.
      if (job.capture_id) {
        deleteAssistsForCapture(job.capture_id);
        deleteDiaryForCapture(job.capture_id);
      }
      if (out.kind === "draft" || out.kind === "advisory") {
        // An empty draft is a rare model hiccup. Skip it (the note is already saved)
        // rather than throwing, which would roll back the best-effort Ledger + Research
        // writes in this same transaction and fail the whole job.
        if (out.body.trim()) {
          insertAssist({
            capture_id: job.capture_id,
            person_id: mentioned[0]?.id ?? null,
            kind: out.kind,
            title: out.title.trim() || (out.kind === "draft" ? "Draft" : "A read on this"),
            body: out.body,
            why: out.why?.trim() || null,
            meta: { crew: out.kind === "draft" ? "drafter" : "advisor" },
          });
        } else {
          console.warn(`[crew] job ${job.id}: ${out.kind} came back empty, skipping it`);
        }
      } else if (out.kind === "diary") {
        insertDiaryEntry(job.note.trim(), job.capture_id);
      }
      // Researcher briefs live on the same "Ready to review" surface as the drafts.
      // Zero-migration home: an 'advisory'-kind row stamped with the crew member, so
      // the review UI labels it "Background" off meta.crew rather than the kind.
      for (const b of briefs) {
        insertAssist({
          capture_id: job.capture_id,
          person_id: null,
          kind: "advisory",
          title: b.subject,
          body: b.body,
          why: b.why || null,
          meta: { crew: "researcher", subject: b.subject },
        });
      }
      // insertConflict dedupes by fact pair, so a retry never stacks duplicates.
      for (const c of conflicts) {
        insertConflict({ personId: c.personId, newFactId: c.newFactId, oldFactId: c.oldFactId, reason: c.reason });
      }
      markAssistJobDone(job.id);
    });
    apply();
  } catch (e) {
    backOffOrGiveUp(job, (e as Error).message);
    return;
  }
  console.log(
    `[crew] job ${job.id} -> ${out.kind}` +
      `${briefs.length ? ` +${briefs.length} brief(s)` : ""}` +
      `${conflicts.length ? ` +${conflicts.length} conflict(s)` : ""}`,
  );
}
