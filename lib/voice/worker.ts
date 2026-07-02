import { claimDueJobs } from "./queue";
import { processJob } from "./process";
import { WORKER_POLL_MS } from "./policy";

// In-process background drain for parked voice notes. The app is a single
// long-lived Node server (systemd `next start` on the VM), so a plain interval
// is enough — no external queue, no cron. Single-user, single process: the
// `running` guard keeps ticks from overlapping and the DB is only touched from
// this one process, so no locking is needed.

let started = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // a previous tick (a slow Gemini call) is still going
  running = true;
  try {
    const jobs = claimDueJobs(3);
    for (const job of jobs) {
      try {
        await processJob(job);
      } catch (e) {
        // processJob handles its own errors; this is just a last-resort guard so
        // one bad job can't kill the loop.
        console.error(`[voice-worker] unexpected error on job ${job.id}:`, e);
      }
    }
  } catch (e) {
    console.error("[voice-worker] tick failed:", e);
  } finally {
    running = false;
  }
}

/** Start the drain loop. Idempotent — safe to call more than once. */
export function startVoiceWorker(): void {
  if (started) return;
  started = true;
  // Sweep shortly after boot to pick up anything left parked by a restart,
  // then poll on the interval.
  setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), WORKER_POLL_MS);
  // Don't let the poller hold the process open on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  console.log("[voice-worker] started");
}
