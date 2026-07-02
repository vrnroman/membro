// Timing policy for the voice pipeline, in one place so the inline request path
// and the background worker agree on how patient to be.
//
// The shape of the promise to the owner: a voice note is NEVER silently lost to
// a passing Gemini rate-limit ("too many requests"). We try a few times inline
// (a couple of seconds — catches a momentary blip), and if the storm is still
// blowing we park the audio in a durable queue and keep retrying in the
// background on a ~10-minute-and-up schedule until it lands.

/** Inline attempts inside the /api/voice request before parking to background. */
export const INLINE_ATTEMPTS = 3;

/** Sleep before inline retry N (1s, then 4s) — snappy, safely under maxDuration. */
export function inlineBackoffMs(attempt: number): number {
  return Math.min(1000 * 4 ** (attempt - 1), 8000);
}

/** First background attempt fires this long after parking. */
export const BG_FIRST_DELAY_MS = 10 * 60_000; // 10 minutes

const BG_BASE_MS = 10 * 60_000; // 10 minutes
const BG_MAX_MS = 30 * 60_000; //  cap between tries

/** Give up (mark failed, keep the audio) after this many background attempts. */
export const MAX_BG_ATTEMPTS = 24; // ~10h of trying — a quota reset lands well inside that

/** Backoff before the next background attempt, given how many have already run. */
export function bgBackoffMs(attemptsDone: number): number {
  return Math.min(BG_BASE_MS * 2 ** Math.max(0, attemptsDone - 1), BG_MAX_MS);
}

/** How often the worker wakes to look for due jobs. */
export const WORKER_POLL_MS = 30_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
