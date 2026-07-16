import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

// Durable queue for voice notes waiting out a Gemini rate-limit. Plain typed
// wrappers over the voice_jobs table; the worker and the /api/voice route both
// go through here so the audio and its state live in one place (SQLite).

export type VoiceJob = {
  id: string;
  audio_base64: string;
  mime_type: string;
  prefix_text: string;
  names: string[];
  transcript: string | null;
  status: "queued" | "done" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
};

type VoiceJobRow = Omit<VoiceJob, "names"> & { names: string };

function hydrate(r: VoiceJobRow): VoiceJob {
  let names: string[] = [];
  try {
    const parsed = JSON.parse(r.names);
    if (Array.isArray(parsed)) names = parsed.filter((n): n is string => typeof n === "string");
  } catch {
    /* keep [] */
  }
  return { ...r, names };
}

const now = () => new Date().toISOString();

/** Park a voice note for the background worker. Returns the new job id. */
export function enqueueVoiceJob(job: {
  audioBase64: string;
  mimeType: string;
  prefixText?: string;
  names?: string[];
  transcript?: string | null;
  firstAttemptAt: string;
}): string {
  const id = randomUUID();
  const ts = now();
  db()
    .prepare(
      `insert into voice_jobs
         (id, audio_base64, mime_type, prefix_text, names, transcript, status, attempts, next_attempt_at, created_at, updated_at)
       values (@id, @audio, @mime, @prefix, @names, @transcript, 'queued', 0, @next, @ts, @ts)`,
    )
    .run({
      id,
      audio: job.audioBase64,
      mime: job.mimeType,
      prefix: job.prefixText ?? "",
      names: JSON.stringify(job.names ?? []),
      transcript: job.transcript ?? null,
      next: job.firstAttemptAt,
      ts,
    });
  return id;
}

/** Jobs that are due to run now, oldest first. */
export function claimDueJobs(limit = 3): VoiceJob[] {
  return (
    db()
      .prepare(
        `select * from voice_jobs
         where status = 'queued' and next_attempt_at <= ?
         order by next_attempt_at asc
         limit ?`,
      )
      .all(now(), limit) as VoiceJobRow[]
  ).map(hydrate);
}

/** Store the transcript so a later filing retry never re-hits Gemini. */
export function markTranscribed(id: string, transcript: string): void {
  db()
    .prepare("update voice_jobs set transcript = ?, updated_at = ? where id = ?")
    .run(transcript, now(), id);
}

/**
 * Push the next try out WITHOUT spending an attempt: the engine is out of quota,
 * which is not this note's fault and which retrying cannot fix any sooner.
 *
 * MAX_BG_ATTEMPTS buys ~10h, and policy.ts used to justify that with "a quota reset
 * lands well inside that". A WEEKLY limit does not: it can be days out. Charging it
 * to the job marks the note 'failed' — a state the queue never re-selects — so the
 * transcript survives but is never filed, and that person silently loses the
 * history forever.
 */
export function parkVoiceJob(id: string, nextAttemptAt: string, reason: string): void {
  db()
    .prepare("update voice_jobs set next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?")
    .run(nextAttemptAt, reason, now(), id);
}

/** Bump the attempt count and push the next try out to `nextAttemptAt`. */
export function rescheduleJob(id: string, nextAttemptAt: string, error: string): void {
  db()
    .prepare(
      "update voice_jobs set attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?",
    )
    .run(nextAttemptAt, error, now(), id);
}

/** The note landed — drop the audio, we don't need it anymore. */
export function markJobDone(id: string): void {
  db().prepare("delete from voice_jobs where id = ?").run(id);
}

/** Gave up. Keep the row (and audio) so it can be inspected / retried by hand. */
export function markJobFailed(id: string, error: string): void {
  db()
    .prepare("update voice_jobs set status = 'failed', last_error = ?, updated_at = ? where id = ?")
    .run(error, now(), id);
}

/** How many notes are currently waiting in the background. */
export function countQueuedJobs(): number {
  return (db().prepare("select count(*) as n from voice_jobs where status = 'queued'").get() as { n: number }).n;
}
