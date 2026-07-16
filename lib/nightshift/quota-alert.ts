import { getKv, setKv } from "@/lib/repo";
import { sendTelegramMessage } from "./telegram";

// Two messages, ever: "the brain is parked" and "the brain is back".
//
// This is the gap the July 2026 outage exposed. Every other fix in that run makes
// Membro honest once the owner OPENS it — but he had no reason to open it, because
// from the outside it looked perfectly fine for 4.6 days. Telegram is the one
// channel Membro already uses to reach him off-app (the morning nudge), so it is
// the one place that can say "your app's brain is out" while it is still true.
//
// The guard is the durable bit. The breaker itself lives in memory and is meant to
// (a restart should re-probe rather than inherit a stale pause), but a restart must
// NOT re-announce a pause the owner already knows about. So the announcement is
// keyed in `kv` on the reset instant: same pause, same key, no second message. That
// reuses the table that already holds the nudge's own once-a-day marker, so there
// is no migration and no new state store.

const KEY = "quota_paused_until";

// The kv marker is durable but it is only written AFTER a send lands, which leaves a
// sub-second check-then-act window: several parked calls can all read "no marker"
// and all send before the first one finishes. That produced 8 identical messages
// under concurrent trips. This collapses the burst without giving back
// at-least-once: a failed send still leaves the marker unset, so the next call
// retries. In-memory on purpose, like the breaker itself.
let announceInFlight = false;

/** "Jul 16, 6am (UTC)" — the same shape the CLI's own message uses. */
export function formatReset(at: Date): string {
  const mon = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = at.getUTCDate();
  const h24 = at.getUTCHours();
  const ampm = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mins = at.getUTCMinutes();
  const time = mins ? `${h12}:${String(mins).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
  return `${mon} ${day}, ${time} (UTC)`;
}

/** The send, injectable so a test can tell "delivered" from "tried and failed". */
export type Sender = (text: string) => Promise<unknown>;

/**
 * Announce a pause. Safe to call on every trip and every blocked call: the kv marker
 * makes the rest no-ops, even across a restart.
 */
export async function notifyQuotaPaused(
  raw: string,
  resetAt: Date,
  resetParsed: boolean,
  send: Sender = sendTelegramMessage,
): Promise<void> {
  // Guard on the PRESENCE of a pause, not on its predicted end. Keying on
  // resetAt looked right and was not: for the wordings that carry no reset time
  // ("You've hit your org's monthly usage limit", 14x in the corpus) the estimate
  // is now+30min, so every re-probe minted a new key and sent another message —
  // one ping per half hour, forever, which is the 576-a-day disease with a
  // different symptom. The marker is cleared only by an actual resume, so an
  // outage settles at one ping (a burst of simultaneous trips can briefly send more
  // than one before the first lands; announceInFlight above narrows that window).
  if (getKv(KEY)) return;
  if (announceInFlight) return;
  announceInFlight = true;

  const when = resetParsed
    ? `Back ${formatReset(resetAt)}.`
    : "It will retry on its own and come back when the limit clears.";
  try {
    await send(`Membro's AI is out of quota, so briefs and note processing are paused. ${when}\n\n${raw}`);
    // Mark only AFTER the send actually lands. Marking first looked safer (it can
    // never send twice) but it buys that with the failure this whole run exists to
    // delete: a single network blip at the moment the limit hits would latch the
    // marker, suppress every later attempt, and leave the owner in silence for the
    // entire outage — the exact 4.6 days of nothing that started all this. The cost
    // of this ordering is at most a duplicate if a send times out after delivering.
    // A duplicate is noise; silence is the bug.
    setKv(KEY, resetAt.toISOString()); // value is informational; presence is the guard
  } finally {
    announceInFlight = false;
  }
}

/**
 * The other half: say so when it comes back. Called on a successful AI call, so
 * "back" means actually-worked, not merely "the clock passed the reset time".
 * No-op unless a pause was announced.
 */
export async function notifyQuotaResumed(send: Sender = sendTelegramMessage): Promise<void> {
  if (!getKv(KEY)) return;
  // Clear FIRST here, unlike the pause. The asymmetry is deliberate: this fires on a
  // successful AI call, so the engine is provably back and the app is already
  // telling the truth on its own. A failed "it's back" message is worth losing; a
  // failed "it's down" message is not, which is why that one retries.
  setKv(KEY, "");
  await send("Membro's AI is back. Catching up on briefs now.");
}

/** Is a pause currently announced? (Drives the "resumed" ping and the UI copy.) */
export function quotaPauseAnnounced(): boolean {
  return !!getKv(KEY);
}
