import { claimDueAssistJobs } from "./queue";
import { processAssistJob } from "./process";
import { WORKER_POLL_MS } from "./policy";

// In-process drain for the assistant queue, the sibling of lib/voice/worker.ts.
// Single long-lived Node server, single-user, so a plain interval + a `running`
// guard is enough; no external queue.

let started = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const jobs = claimDueAssistJobs(3);
    for (const job of jobs) {
      try {
        await processAssistJob(job);
      } catch (e) {
        console.error(`[assist-worker] unexpected error on job ${job.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[assist-worker] tick failed:", e);
  } finally {
    running = false;
  }
}

/** Start the drain loop. Idempotent. */
export function startAssistWorker(): void {
  if (started) return;
  started = true;
  setTimeout(() => void tick(), 4_000);
  const timer = setInterval(() => void tick(), WORKER_POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[assist-worker] started");
}
