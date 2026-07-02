// Timing for the async assistant pass. Unlike voice (which waits out Gemini
// rate limits for many minutes), an assist failure is a transient `claude -p`
// hiccup, so the backoff is short and the give-up bound is tight. The note is
// already saved either way; only the drafting is retried.

export const WORKER_POLL_MS = 15_000;

const BASE_MS = 30_000; //  first retry after ~30s
const MAX_MS = 10 * 60_000; // cap between tries

export const MAX_ATTEMPTS = 8; // give up (mark failed) after this many tries

// When a job is claimed, push its next_attempt_at out by this much so a second
// drain (or a crash mid-process) cannot re-run the same expensive AI call right
// away. Normal completion overrides this (done / failed / rescheduled).
export const LEASE_MS = 2 * 60_000;

export function backoffMs(attemptsDone: number): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, attemptsDone - 1), MAX_MS);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
