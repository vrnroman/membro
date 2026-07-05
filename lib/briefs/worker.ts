import { listPeopleNeedingBrief } from "@/lib/repo";
import { generateBriefFor, BRIEF_STALE_DAYS } from "./generate";

// Background Pre-Read refresh: the sibling of lib/assist/worker.ts. It keeps the
// briefs cache warm so opening any profile is instant and reflects the latest
// note. Each tick regenerates a small batch of the most-deserving briefs — people
// with none yet, then the ones a fact change flagged stale, then the oldest past
// the freshness window. Bounded per tick because each brief is a serialized
// `claude -p` call; the rest wait for the next tick. Idempotent and safe to rerun:
// a regenerate overwrites the one row for that person.
//
// This is the backstop. The primary freshness triggers are event-driven: a fact
// change flags the brief stale, and opening a person with no brief builds one on
// the spot. The sweep just drains what those leave behind.

const POLL_MS = 5 * 60_000; // every 5 minutes: a prep brief is not real-time
// Briefs regenerated per tick. Kept small on purpose: `claude -p` runs one at a
// time through a single process-wide queue shared with the assist worker AND the
// interactive first-open brief, so a large batch could make a just-opened profile
// wait behind the sweep. Two per 5 minutes keeps the cache warming without
// starving the foreground request.
const BATCH = 2;
const FIRST_DELAY_MS = 20_000; // let the server settle before the first pass

let started = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap: a slow batch must not stack
  running = true;
  try {
    const cutoff = new Date(Date.now() - BRIEF_STALE_DAYS * 86400000).toISOString();
    const due = listPeopleNeedingBrief(cutoff, BATCH);
    for (const personId of due) {
      try {
        await generateBriefFor(personId);
      } catch (e) {
        // One person's AI hiccup must not stop the batch; they stay due for next tick.
        console.error(`[brief-worker] could not refresh ${personId}:`, (e as Error).message);
      }
    }
    if (due.length) console.log(`[brief-worker] refreshed ${due.length} brief(s)`);
  } catch (e) {
    console.error("[brief-worker] tick failed:", e);
  } finally {
    running = false;
  }
}

/** Start the refresh loop. Idempotent. */
export function startBriefWorker(): void {
  if (started) return;
  started = true;
  setTimeout(() => void tick(), FIRST_DELAY_MS);
  const timer = setInterval(() => void tick(), POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[brief-worker] started");
}
