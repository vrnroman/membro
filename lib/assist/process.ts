import { db } from "@/lib/db";
import { getAdapter } from "@/lib/ai";
import {
  listPeopleIdName,
  listFactContents,
  insertAssist,
  deleteAssistsForCapture,
  insertDiaryEntry,
  deleteDiaryForCapture,
} from "@/lib/repo";
import { SELF_ID } from "@/lib/nightshift/scout";
import {
  type AssistJob,
  rescheduleAssistJob,
  markAssistJobDone,
  markAssistJobFailed,
} from "./queue";
import { backoffMs, MAX_ATTEMPTS } from "./policy";

// Process one queued note: classify it and start the work. The note is already
// saved, so this only ever produces the *extra* (a draft, an advisory, a diary
// entry) and is safe to re-run — it clears its own prior output for the note
// first, and diary entries dedupe by content.

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// Bump attempts and push the next try out, or give up once we've tried enough.
// Shared by the AI-call path and the write path so neither loops forever.
function backOffOrGiveUp(job: AssistJob, error: string): void {
  const attemptsDone = job.attempts + 1;
  if (attemptsDone >= MAX_ATTEMPTS) {
    markAssistJobFailed(job.id, `gave up after ${attemptsDone} tries: ${error}`);
    console.error(`[assist-worker] job ${job.id} failed permanently: ${error}`);
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

export async function processAssistJob(job: AssistJob): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();

  const roster = listPeopleIdName().filter((p) => p.id !== SELF_ID);
  const mentioned = roster.filter((p) => mentionedIn(job.note, p.name));
  const people = mentioned.map((p) => ({ name: p.name, facts: listFactContents(p.id).slice(0, 8) }));

  let out;
  try {
    out = await adapter.assist({ note: job.note, today, people });
  } catch (e) {
    backOffOrGiveUp(job, (e as Error).message);
    return;
  }

  // Apply the result and mark the job done in ONE transaction, so the writes and
  // the completion commit together. If any write throws (a locked DB, a
  // constraint, an empty draft), nothing commits and we take the bounded-retry
  // path below, instead of leaving the job 'queued' to re-run the AI call forever.
  try {
    const apply = db().transaction(() => {
      // Clear any prior output for THIS note so a retry replaces, never duplicates.
      if (job.capture_id) {
        deleteAssistsForCapture(job.capture_id);
        deleteDiaryForCapture(job.capture_id);
      }
      if (out.kind === "draft" || out.kind === "advisory") {
        if (!out.body.trim()) throw new Error("assistant returned an empty draft");
        insertAssist({
          capture_id: job.capture_id,
          person_id: mentioned[0]?.id ?? null,
          kind: out.kind,
          title: out.title.trim() || (out.kind === "draft" ? "Draft" : "A read on this"),
          body: out.body,
          why: out.why?.trim() || null,
        });
      } else if (out.kind === "diary") {
        insertDiaryEntry(job.note.trim(), job.capture_id);
      }
      // 'none' -> nothing to start; the note is already saved.
      markAssistJobDone(job.id);
    });
    apply();
  } catch (e) {
    backOffOrGiveUp(job, (e as Error).message);
    return;
  }
  console.log(`[assist-worker] job ${job.id} -> ${out.kind}`);
}
