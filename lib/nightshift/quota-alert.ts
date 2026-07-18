import { getKv, setKv } from "@/lib/repo";
import { describeGlobalFault } from "@/lib/ai/quota";
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
export async function notifyQuotaResumed(send: Sender = sendTelegramMessage): Promise<boolean> {
  if (!getKv(KEY)) return false;
  // Clear FIRST here, unlike the pause. The asymmetry is deliberate: this fires on a
  // successful AI call, so the engine is provably back and the app is already
  // telling the truth on its own. A failed "it's back" message is worth losing; a
  // failed "it's down" message is not, which is why that one retries.
  setKv(KEY, "");
  await send("Membro's AI is back. Catching up on briefs now.");
  return true; // told the caller a "back" message went out, so it does not send another
}

/** Is a pause currently announced? (Drives the "resumed" ping and the UI copy.) */
export function quotaPauseAnnounced(): boolean {
  return !!getKv(KEY);
}

// ── Engine broken (not merely out of credit) ─────────────────────────────────
//
// The sibling of the quota alert, for the OTHER global outage class: a read-only
// disk, an expired login, a missing binary. It differs in the one way that made it
// worth its own code rather than a copy: quota states its own reset, so one message
// is obviously right and obviously timed, but a broken engine has NO reset (a human
// must fix it) and a single AdapterError can be a one-off timeout. So this one does
// not speak on first sight. It records WHEN the fault was first seen (engine-wide,
// from whichever path saw it first), and only pings once it has persisted past a
// wall-clock bar AND a fresh probe is still failing in the same tick — so it can
// never cry wolf for a blip or an already-healed fault. That caution is doubly
// wanted right now: a stray probe already messaged the owner once this session.

// 30 minutes: every fault in this class is persistent by nature (a real one is still
// failing at 30 min, so waiting costs nothing for true cases), and the margin keeps
// a transient blip well clear of the loud channel.
const ENGINE_ALERT_AFTER_MS = 30 * 60_000;

const SINCE = "engine_fault_since"; // ISO of first sighting; absence = engine healthy
const RAW = "engine_fault_raw"; // the raw text, for naming the cause
const ALERTED = "engine_fault_alerted"; // "1" once the Telegram has gone out

let engineAnnounceInFlight = false;

/**
 * Record that the engine looks broken, starting the persistence clock. Set-if-absent
 * so the clock marks the FIRST sighting, and callable from any path (the adapter
 * chokepoint sees it first). Never sends anything itself.
 */
export function noteEngineFault(raw: string): void {
  if (!getKv(SINCE)) setKv(SINCE, new Date().toISOString());
  setKv(RAW, raw.slice(0, 300)); // keep the latest wording for the cause lookup
}

/**
 * Fire the off-app alert IF the fault has persisted past the bar. Call this from a
 * tick that just saw the fault fail for real, so the alert is always backed by a
 * live failing probe. Idempotent per outage: the ALERTED marker makes later calls
 * no-ops until a success clears it.
 */
export async function maybeAlertEngineFault(send: Sender = sendTelegramMessage): Promise<void> {
  const since = getKv(SINCE);
  if (!since || getKv(ALERTED)) return;
  if (Date.now() - Date.parse(since) < ENGINE_ALERT_AFTER_MS) return; // not persistent yet
  if (engineAnnounceInFlight) return;
  engineAnnounceInFlight = true;
  try {
    const { cause, action } = describeGlobalFault(getKv(RAW) || "");
    await send(
      `Membro's AI has been down since ${sinceLabel(since)}. Looks like ${cause}, so briefs and note processing are paused. To fix: ${action}.`,
    );
    setKv(ALERTED, "1"); // mark only after it lands, same reasoning as the quota path
  } finally {
    engineAnnounceInFlight = false;
  }
}

/**
 * The engine answered. Clear the fault, and if we had alerted, say it is back. Call
 * on any successful AI call. No-op when the engine was never marked down.
 */
export async function clearEngineFault(send: Sender = sendTelegramMessage, alreadyAnnounced = false): Promise<void> {
  if (!getKv(SINCE)) return;
  const wasAlerted = !!getKv(ALERTED);
  setKv(SINCE, "");
  setKv(RAW, "");
  setKv(ALERTED, "");
  // Say "back" only if we'd announced this fault AND nothing else already said it
  // this same recovery (the quota resume may have spoken first — one fact, one
  // message).
  if (wasAlerted && !alreadyAnnounced) await send("Membro's AI is back. Catching up now.");
}

/** Is an engine fault currently recorded (whether or not it has been announced)? */
export function engineFaultPending(): boolean {
  return !!getKv(SINCE);
}

/** The live broken-engine state for the profile card on open (null = healthy). */
export function engineFaultState(): { cause: string; action: string } | null {
  if (!getKv(SINCE)) return null;
  return describeGlobalFault(getKv(RAW) || "");
}

function sinceLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "a while ago";
  return formatReset(at); // reuse the "Jul 16, 6am (UTC)" shape
}
