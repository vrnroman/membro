import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { LEASE_MS } from "./policy";

// Durable queue for the assistant pass, the sibling of lib/voice/queue.ts. A
// captured note is filed first, then queued here; the worker drains it. Plain
// typed wrappers over assist_jobs.

export type AssistJob = {
  id: string;
  capture_id: string | null;
  note: string;
  status: "queued" | "done" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
};

const now = () => new Date().toISOString();

/** Queue a captured note for the assistant. Returns the new job id. */
export function enqueueAssistJob(job: { captureId: string | null; note: string; firstAttemptAt: string }): string {
  const id = randomUUID();
  const ts = now();
  db()
    .prepare(
      `insert into assist_jobs (id, capture_id, note, status, attempts, next_attempt_at, created_at, updated_at)
       values (@id, @capture, @note, 'queued', 0, @next, @ts, @ts)`,
    )
    .run({ id, capture: job.captureId, note: job.note, next: job.firstAttemptAt, ts });
  return id;
}

// Atomically claim due jobs by leasing them: within one transaction, select the
// due rows and push their next_attempt_at out. A concurrent drain (or a restart
// mid-flight) then won't re-run the same job until the lease expires; normal
// completion updates the row well before that.
export function claimDueAssistJobs(limit = 3): AssistJob[] {
  const d = db();
  const claim = d.transaction((lim: number) => {
    const rows = d
      .prepare(
        `select * from assist_jobs
         where status = 'queued' and next_attempt_at <= ?
         order by next_attempt_at asc
         limit ?`,
      )
      .all(now(), lim) as AssistJob[];
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const upd = d.prepare("update assist_jobs set next_attempt_at = ? where id = ?");
    for (const r of rows) upd.run(lease, r.id);
    return rows;
  });
  return claim(limit);
}

export function rescheduleAssistJob(id: string, nextAttemptAt: string, error: string): void {
  db()
    .prepare(
      "update assist_jobs set attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ? where id = ?",
    )
    .run(nextAttemptAt, error, now(), id);
}

export function markAssistJobDone(id: string): void {
  db().prepare("update assist_jobs set status = 'done', updated_at = ? where id = ?").run(now(), id);
}

export function markAssistJobFailed(id: string, error: string): void {
  db()
    .prepare("update assist_jobs set status = 'failed', last_error = ?, updated_at = ? where id = ?")
    .run(error, now(), id);
}
