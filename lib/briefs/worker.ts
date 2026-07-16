import { listPeopleNeedingBrief, recordBriefFailure, clearBriefAttempts, getBriefAttempt } from "@/lib/repo";
import { generateBriefFor, BRIEF_STALE_DAYS } from "./generate";
import { briefBackoffMs, MAX_BRIEF_ATTEMPTS } from "./policy";
import { QuotaExhaustedError, quotaBlock } from "@/lib/ai/quota";

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
//
// It also has to fail well, which it did not. In July 2026 two people whose
// generation always failed sat at the head of the queue (a failure writes no brief
// row, and never-briefed sorts first) and held both slots on every tick for 4.6
// days: 576 wasted calls a day, seven of nine people with no brief at all, and a
// log line that cheerfully said "refreshed 2 brief(s)" the entire time. Three
// things came out of that and they are all here: failures back off (policy.ts), a
// parked engine is recognised rather than hammered (quota.ts), and the log counts
// what actually WORKED instead of what was attempted.

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
    // The engine is parked (out of quota). Every call would come straight back as
    // the same error, so do not spend a tick discovering that person by person.
    // The breaker self-clears once the reset passes; the next tick picks up.
    const blocked = quotaBlock();
    if (blocked) {
      // While everything else is parked, this tick is the only thing still beating,
      // so it is where the off-app alert gets its retries. If the first send failed,
      // nothing else would try again for days (the dated wording parks that long).
      // kv-guarded, so it goes quiet the moment one message lands.
      void retryQuotaAnnounce(blocked.raw, blocked.resetAt, blocked.resetParsed);
      return;
    }

    const cutoff = new Date(Date.now() - BRIEF_STALE_DAYS * 86400000).toISOString();
    const due = listPeopleNeedingBrief(cutoff, BATCH);
    let refreshed = 0;

    for (const personId of due) {
      try {
        await generateBriefFor(personId);
        clearBriefAttempts(personId); // clean slate after a good one
        refreshed++;
      } catch (e) {
        if (e instanceof QuotaExhaustedError) {
          // Not this person's fault: the whole engine is out. Burning an attempt
          // here would spend all 8 tries during an outage and permanently give up
          // on someone whose brief is perfectly fine. Stop the batch instead —
          // everyone behind them would fail identically.
          console.error(`<3>[brief-worker] paused, out of AI quota: ${e.message}`);
          break;
        }
        // A real, person-specific failure. Remember it, back them off, and let the
        // queue behind them move.
        const msg = (e as Error).message;
        const attempts = (getBriefAttempt(personId)?.attempts ?? 0) + 1;
        const next = new Date(Date.now() + briefBackoffMs(attempts)).toISOString();
        recordBriefFailure(personId, msg, attempts, next);
        // Never "gave up", only "slowed down": past MAX_BRIEF_ATTEMPTS the backoff
        // has saturated at 6h and they keep their place in the queue, so whatever
        // was broken can heal on its own without anyone touching the app.
        const saturated = attempts >= MAX_BRIEF_ATTEMPTS;
        console.error(
          `<3>[brief-worker] could not refresh ${personId} (attempt ${attempts}${
            saturated ? ", now retrying at the slowest rate" : ""
          }, next after ${next}): ${msg}`,
        );
      }
    }
    // Count what actually worked. The old line reported `due.length`, so it read
    // "refreshed 2 brief(s)" 288 times a day through an outage that refreshed none.
    if (refreshed) console.log(`[brief-worker] refreshed ${refreshed} brief(s)`);
  } catch (e) {
    console.error("<3>[brief-worker] tick failed:", e);
  } finally {
    running = false;
  }
}

// Lazily imported and never awaited: a Telegram outage must not take the sweep down
// with it, and the alert module reaches the DB + network.
async function retryQuotaAnnounce(raw: string, resetAt: Date, resetParsed: boolean): Promise<void> {
  try {
    const { notifyQuotaPaused } = await import("@/lib/nightshift/quota-alert");
    await notifyQuotaPaused(raw, resetAt, resetParsed);
  } catch (e) {
    console.error(`<3>[brief-worker] could not announce quota pause: ${(e as Error).message}`);
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
