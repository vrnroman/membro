// Retry discipline for the Pre-Read sweep. The sibling of lib/assist/policy.ts,
// tuned for a background cache-warmer rather than a note the owner is waiting on.
//
// The numbers are deliberately slacker than assist's. A brief is a nice-to-have
// that the first-open path builds on demand anyway, and the sweep is a backstop,
// so a person who keeps failing should get out of the way rather than be chased.

// The tick is every 5 minutes, so a base shorter than that would just retry on the
// very next tick and re-create the hammer this exists to stop.
const BASE_MS = 5 * 60_000;
const MAX_MS = 6 * 3600_000; // ~6h: past this, waiting longer helps nobody

/**
 * The point where the backoff has fully saturated (8 failures => the 6h cap), used
 * only to word the log line. It is deliberately NOT a give-up: a person is never
 * dropped from the sweep, because the failure is often global (a read-only disk, an
 * expired token) and abandoning all nine people over it — permanently, across
 * restarts — is the shape of the very outage this file exists to prevent.
 */
export const MAX_BRIEF_ATTEMPTS = 8;

/** 5m, 10m, 20m, 40m ... capped at 6h. */
export function briefBackoffMs(attemptsDone: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attemptsDone - 1));
}
