// Timing for the async assistant pass. An assist failure is a transient `claude -p`
// hiccup, so the backoff is short. How LONG to keep retrying before giving up is no
// longer set here: it is the shared wall-clock bound RETRY_MAX_AGE_MS (~10h) in
// lib/ai/quota.ts, so brief / assist / voice all agree. The note is already saved and
// visible in Notes either way; only the drafting is retried.

export const WORKER_POLL_MS = 15_000;

const BASE_MS = 30_000; //  first retry after ~30s
const MAX_MS = 10 * 60_000; // cap between tries

// When a job is claimed, push its next_attempt_at out by this much so a second
// drain (or a crash mid-process) cannot re-run the same expensive AI call right
// away. Normal completion overrides this (done / failed / rescheduled).
export const LEASE_MS = 2 * 60_000;

export function backoffMs(attemptsDone: number): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, attemptsDone - 1), MAX_MS);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
