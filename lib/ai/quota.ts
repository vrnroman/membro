// The quota circuit breaker: what Membro does when its brain is out of credit.
//
// Why this exists. In July 2026 the Claude subscription hit its WEEKLY limit.
// Every `claude -p` came back with a plain-text "You've hit your limit · resets
// Jul 16, 6am (UTC)" and the adapter, which only looked for a non-zero exit with
// empty stdout, handed that string to the JSON parser and reported "no JSON
// object in claude -p output". The brief worker then retried it 576 times a day
// for 4.6 days (its normal rate is 5-13) while seven of nine people sat with no
// Pre-Read at all and nothing anywhere said why. This module is the thing that
// was missing: it recognises "the engine is out of credit", learns when it comes
// back, and makes every caller stop until then.
//
// HOW WE DETECT IT — and why it is not the obvious way. A limit reply is NOT an
// error as far as the CLI is concerned: it arrives as a normal assistant message
// (the transcript shows `model:"<synthetic>"`, `stop_reason:"stop_sequence"`) and
// the envelope comes back `subtype:"success", is_error:false`. So `is_error` can
// never catch it. The wording is server-side, not in the CLI binary, so it can be
// reworded without a release, which makes a text match alone brittle too.
//
// The one thing that cannot lie is the token count. A reply with TEXT in it but
// `output_tokens: 0` never came from a real generation: the model was never run.
// That is structural and language-independent, so it is the primary gate.
//
// But zero-usage on its own does NOT mean "out of quota" — that was the trap.
// Harvesting the 2,756 real session transcripts before deleting them turned up
// twelve zero-usage replies that are nothing of the kind:
//     10x  "API Error: EROFS: read-only file system, open '.../.claude.json'"
//      2x  "Failed to authenticate. API Error: 401 Invalid authentication credentials"
// Backing off for up to seven days on a broken auth token would be the original
// bug wearing a new hat. So detection is two levels: zero-usage proves "this is
// not a real generation", and only then does the wording decide WHICH kind. Any
// mention of a limit is quota; anything else is a plain adapter failure that must
// surface loudly and immediately instead of parking the app.

/** The shape of `claude -p --output-format json`, as far as we rely on it. */
export type ClaudeEnvelope = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result?: string;
  usage?: { output_tokens?: number; input_tokens?: number } | null;
};

// A reply with no reset time at all ("You've hit your org's monthly usage limit",
// seen 14x in the corpus) still has to pause for SOMETHING. Short on purpose: a
// blocked call costs zero tokens, so the cost of guessing low is one wasted probe,
// while guessing high keeps a working engine parked. The worker's own backoff is
// what stops this from becoming a hammer.
export const QUOTA_FALLBACK_MS = 30 * 60_000;
// Never park for less than this (a reset one second away is a hammer) and never
// for more than this (a mis-parsed year, or a skewed clock, must not freeze the
// app for months — that is the incident, rewritten).
export const QUOTA_MIN_MS = 60_000;
export const QUOTA_MAX_MS = 7 * 86400_000;

/** Out of credit. Carries when it comes back, so callers can say so. */
export class QuotaExhaustedError extends Error {
  readonly resetAt: Date;
  /** False when we had to fall back: we know it is paused, not when it returns. */
  readonly resetParsed: boolean;
  readonly raw: string;
  constructor(raw: string, resetAt: Date, resetParsed: boolean) {
    super(`claude -p is out of quota: ${raw}`);
    this.name = "QuotaExhaustedError";
    this.resetAt = resetAt;
    this.resetParsed = resetParsed;
    this.raw = raw;
  }
}

/**
 * The CLI answered, but with something that is not a generation (auth, FS, ...).
 *
 * `global` marks the ones that are the ENGINE being down rather than this
 * particular request being bad: the reply carried text but spent zero tokens, so
 * the model was never reached at all. The real corpus has exactly two of these,
 * and both are persistent by nature — a read-only disk stays read-only, an expired
 * token stays expired:
 *     10x  "API Error: EROFS: read-only file system, open '.../.claude.json'"
 *      2x  "Failed to authenticate. API Error: 401 Invalid authentication credentials"
 * They matter because a caller must not charge them to one note. A timeout or a
 * killed process is NOT global: the model may well have been running, and that is
 * a per-request failure that should burn its attempts as usual.
 */
export class AdapterError extends Error {
  readonly raw: string;
  readonly global: boolean;
  // The CLEAN fault text: stderr, an err.code label, or the CLI's synthetic reply.
  // NEVER err.message or stdout — node echoes the whole prompt into err.message, so
  // describing a fault from `raw` would let the owner's note pick the cause (a note
  // mentioning "read-only" would make a login outage read as a disk problem). This
  // is the same contamination isGlobalFault guards against; describeGlobalFault must
  // only ever see this field.
  readonly faultSignal: string;
  constructor(raw: string, isGlobal = false, faultSignal = "") {
    super(`claude -p returned no usable output: ${raw}`);
    this.name = "AdapterError";
    this.raw = raw;
    this.global = isGlobal;
    this.faultSignal = faultSignal || raw;
  }
}

/**
 * How long to hold work when the engine itself is unavailable but says nothing
 * about when it will be back. Unlike a quota limit there is no reset to read: a
 * read-only disk or a dead token needs a human, so this is just "check back
 * regularly and heal the moment it is fixed", not a guess at a deadline.
 */
export const ENGINE_RETRY_MS = 30 * 60_000;

/**
 * The backstop on parking. A park spends no attempts, which is the point, but it
 * means a job held by a fault we mis-classified as global would retry forever:
 * never done, never failed, never seen. Past this age a parked job stops being
 * parked and takes the ordinary give-up path, so every fault class terminates.
 *
 * Comfortably longer than QUOTA_MAX_MS (7 days) so a genuine weekly outage — the
 * whole reason parking exists — never trips it.
 */
export const PARK_MAX_AGE_MS = 10 * 86400_000;

// How long a PER-REQUEST failure (a transient claude -p hiccup: a malformed output,
// a one-off timeout, a bad parse — NOT a global outage, which parks without spending
// a retry) keeps being retried before the worker gives up. One number so the three
// workers agree; each keeps its own backoff shape, only this bound is shared.
export const RETRY_MAX_AGE_MS = 10 * 3600_000; // 10 hours

// The floor that makes the wall-clock bound safe. Age alone is not enough: a job that
// parked through a multi-day outage (park spends no attempts) is already older than
// 10h before its FIRST real hiccup, so an age-only test would give up instantly with
// zero genuine retries — the opposite of "retry ~10h". Requiring a minimum number of
// actual attempts guarantees every job gets real per-request tries regardless of how
// long it sat parked.
export const RETRY_MIN_ATTEMPTS = 6;

/**
 * Has this item been retried long enough to give up? True only when it has BOTH aged
 * past the bound AND had a floor of genuine attempts (see RETRY_MIN_ATTEMPTS). A
 * fresh, steadily-failing note gives up at ~10h; a note that sat parked through an
 * outage still gets its floor of real tries first. An unparseable timestamp counts as
 * old, so it terminates on attempts alone rather than never.
 */
export function retriedTooLong(createdAtISO: string, attemptsDone: number): boolean {
  const age = Date.now() - Date.parse(createdAtISO);
  // "Aged" is anything that is NOT a normal, fresh, positive age within the bound: a
  // negative age (a future created_at from clock skew) and a NaN (a bad timestamp)
  // both count as aged, so the attempt floor terminates them rather than letting an
  // anomalous timestamp loop forever. Only a genuine 0..10h age keeps retrying.
  const aged = !(age >= 0 && age <= RETRY_MAX_AGE_MS);
  return aged && attemptsDone >= RETRY_MIN_ATTEMPTS;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Every dated and undated form the real corpus contains:
//   "You've hit your limit · resets Jul 16, 6am (UTC)"   (2104x)
//   "You've hit your limit · resets 6am (UTC)"            (526x)
//   "You've hit your limit · resets 2am (UTC)"            (30x)
// The hour varies, the date is often absent, and the year is NEVER given.
//
// The separator and the zone are both loose on purpose: this wording is written by
// the server, not the CLI, so it drifts without a release. CLI 2.1.211 already says
// "resets Jul 16 at 6pm (Etc/UTC)" — "at" instead of the comma — while the VM's
// 2.1.138 still uses the comma. Both parse here. Failing to parse is not dangerous
// (it falls back to a 30-min probe and the copy stops claiming a time), but the
// countdown is the nice part, so it is worth not losing it to a comma.
const RESET_RE =
  /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s*,?\s*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]{1,40})\)/i;

// We can only trust an hour we can place on a real timeline. UTC we can; anything
// else would need a timezone database to convert and would be wrong by hours if we
// guessed, so an unrecognised zone falls back rather than inventing a countdown.
const UTC_ZONE_RE = /^(?:etc\/)?(?:utc|gmt|z)$/i;

/** Anything mentioning a limit, so a reworded message still lands. */
const LIMIT_RE = /\blimits?\b/i;

// The faults that are the ENGINE, not this request. Matched against the shapes we
// have actually observed, and nothing else.
//
// The obvious shortcut — "zero output tokens means the fault is global" — is an
// invalid inference, and an expensive one. Zero tokens proves only that no
// generation happened; the API also spends zero tokens REJECTING one specific
// request ("prompt is too long: 213476 tokens > 200000 maximum", an oversized
// image — both reachable from a multi-photo capture). Treating that as global
// parks a permanently unprocessable note every 30 minutes forever: never done,
// never failed, and logged as "AI engine unavailable" pointing a future debugger at
// a disk and a token that are both perfectly healthy. That is this incident's
// misdiagnosis wearing a new hat.
//
// So the default is NOT global: an unrecognised fault burns attempts and
// terminates (bounded, honest). Only these earn a park.
// Note "invalid api key" and "/login" sit here while "invalid_request_error" does
// NOT: the first two mean the engine will not talk to us at all, the third means it
// talked to us and rejected this particular note.
const GLOBAL_FAULT_RE =
  /EROFS|read-only file system|\bENOENT\b|command not found|not logged ?in|\b401\b|\b403\b|unauthorized|invalid authentication|authentication_error|invalid api key|credentials|\/login\b|claude login|credit balance/i;

/**
 * Is this failure about the engine rather than the request? Deliberately narrow;
 * see GLOBAL_FAULT_RE. Never matches a per-request rejection (a too-long prompt) or
 * a timeout, both of which must keep burning attempts so they can terminate.
 *
 * CALLER CONTRACT, and it is load-bearing: pass only text the ENGINE wrote about
 * ITSELF — a synthetic zero-token reply, or the process's stderr. Never pass
 * anything carrying the request: not `err.message` (node echoes the whole command
 * line, prompt included), not stdout, not generated output. These words are
 * ordinary English and appear in real notes ("moved to room 401", "sending the API
 * credentials", a link ending in /login), so feeding it request text lets the note
 * decide how a failure is handled.
 */
export function isGlobalFaultText(raw: string): boolean {
  return GLOBAL_FAULT_RE.test(raw);
}

/**
 * Turn a raw global-fault string into a plain cause and where to act, for the alert
 * and the profile card. It names the cause and points at the VM; it deliberately
 * does NOT hand over a command to paste. `claude login` is actively wrong here (the
 * service runs on an OAuth token the interactive CLI does not use), and the real
 * EROFS case was fixed by a systemd ReadWritePaths change, not a one-liner. A
 * confidently wrong instruction wastes more time than an honest "look here", and it
 * rots on the next infra change; a description does not.
 */
export function describeGlobalFault(raw: string): { cause: string; action: string } {
  const r = raw.toLowerCase();
  if (/erofs|read-only file system/.test(r))
    return { cause: "the disk it writes to is read-only", action: "check the VM disk and the service's write paths" };
  if (/\b401\b|\b403\b|unauthorized|invalid authentication|authentication_error|invalid api key|\/login|claude login|not logged ?in|logged out|credentials/.test(r))
    return { cause: "its login has expired", action: "re-authenticate the Claude CLI on the VM" };
  if (/credit balance/.test(r))
    return { cause: "the account is out of credit", action: "top up the Claude account" };
  if (/enoent|command not found|eacces/.test(r))
    return { cause: "the Claude CLI is missing or not runnable", action: "check the Claude CLI install on the VM" };
  return { cause: "the AI engine is not responding", action: "check the service on the VM" };
}

/**
 * Pull the reset moment out of a limit message. Returns `parsed:false` when the
 * message carries no usable time (the monthly-limit form), so a caller can say
 * "paused" honestly instead of inventing a countdown it does not know.
 */
export function parseResetAt(raw: string, nowMs: number): { at: Date; parsed: boolean } {
  const fallback = { at: new Date(nowMs + QUOTA_FALLBACK_MS), parsed: false };
  const m = RESET_RE.exec(raw);
  if (!m) return fallback;

  const [, monRaw, dayRaw, hourRaw, minRaw, ampm, zone] = m;
  if (!UTC_ZONE_RE.test(zone.trim())) return fallback; // an hour we cannot place
  let hour = parseInt(hourRaw, 10) % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  const min = minRaw ? parseInt(minRaw, 10) : 0;

  const now = new Date(nowMs);
  let at: Date;

  if (monRaw && dayRaw) {
    const mon = MONTHS.indexOf(monRaw.toLowerCase().slice(0, 3));
    if (mon === -1) return fallback;
    // The year is never in the message. Assume the current one, then roll forward
    // if that lands in the past (a New Year's Eve limit resets in January).
    at = new Date(Date.UTC(now.getUTCFullYear(), mon, parseInt(dayRaw, 10), hour, min, 0, 0));
    if (at.getTime() < nowMs)
      at = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, parseInt(dayRaw, 10), hour, min, 0, 0));
  } else {
    // Undated: the next time that hour comes round in UTC.
    at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0));
    if (at.getTime() <= nowMs) at = new Date(at.getTime() + 86400_000);
  }

  const delta = at.getTime() - nowMs;

  // An implausibly distant reset is a reset we misread, and the ONLY safe way to be
  // wrong is to be wrong short. Guessing low costs one probe (a blocked call spends
  // zero tokens); guessing high keeps a working engine parked, which is the whole
  // incident. So an untrusted delta lands on the short fallback, never on the cap.
  //
  // This path is reached constantly, not rarely: the breaker self-clears exactly AT
  // resetAt, so every outage ends with a probe aimed at the boundary. If the server
  // has not flipped yet (a clock a second fast, or "6am" being a rounded label),
  // that probe returns the SAME dated message with a now-past reset — which the
  // year-roll above turns into "+1 year". Capping that at 7 days would black the app
  // out for a week at the exact moment it was recovering.
  if (delta > QUOTA_MAX_MS) return fallback;

  // A reset moments away is real, just imminent: floor it so we do not spin.
  return { at: new Date(nowMs + Math.max(QUOTA_MIN_MS, delta)), parsed: true };
}

export type Classified =
  | { kind: "ok"; text: string }
  | { kind: "quota"; raw: string; resetAt: Date; resetParsed: boolean }
  // `global` = the engine never ran the model (see AdapterError): not this
  // request's fault, so a caller must not charge it to one item.
  | { kind: "error"; raw: string; global: boolean };

/**
 * Decide what a finished `claude -p` run actually produced.
 *
 * `stdout` is passed for the case where the envelope did not parse at all (an
 * older CLI, or a crash mid-write), so a limit message printed bare still lands.
 */
export function classifyEnvelope(env: ClaudeEnvelope | null, stdout: string, nowMs: number): Classified {
  const text = (env?.result ?? stdout ?? "").toString();
  const trimmed = text.trim();
  const outTokens = env?.usage?.output_tokens;

  // Nothing came back at all. Not a generation, not a limit, just empty. Say so
  // here: letting it through would hand "" to the JSON parser and reproduce the
  // exact "no JSON object in claude -p output" symptom this module exists to kill.
  if (trimmed === "") return { kind: "error", raw: "claude -p returned empty output", global: false };

  // THE GATE, and it is a narrow one on purpose: we call it quota only when the
  // envelope PROVES the model never ran (text came back, `output_tokens` is 0).
  //
  // The tempting extra clause — "no usage field, but the text says limit" — is a
  // trap. When the envelope does not parse (a notice printed before the JSON, or a
  // 16MB maxBuffer truncating a long research run) `usage` is simply unknown, and
  // matching the bare word "limit" against the model's own PROSE would park every
  // AI path and fire a false "out of quota" alert on a run that actually
  // succeeded. The old code handed that stdout to parseJsonObject, whose whole job
  // is digging a JSON object out of surrounding prose, and it worked. So when we
  // cannot prove it, we do not guess: fall through and let the parser try, exactly
  // as before.
  //
  // The cost of this narrowness is a false NEGATIVE if the CLI ever reports usage
  // on a limit reply: we would miss it and fall back to the old symptom. That is
  // survivable, because it is the per-person backoff (not this detector) that
  // actually bounds the retry rate — 36 calls/day worst case, versus the 576/day
  // of the incident.
  if (outTokens === 0) {
    if (LIMIT_RE.test(trimmed)) {
      const { at, parsed } = parseResetAt(trimmed, nowMs);
      return { kind: "quota", raw: trimmed, resetAt: at, resetParsed: parsed };
    }
    // Zero-usage and not a limit. That alone does NOT say whose fault it is: a
    // read-only disk (10x in the corpus) and an expired token (2x) are the engine,
    // while a rejected over-long prompt is this request. Only the wording separates
    // them, so ask it.
    //
    // Passing `trimmed` to the matcher is safe HERE, but not for the reason it first
    // appears. "Zero output tokens means this text is synthetic, never the model's
    // own words" is FALSE in general — a real assistant message can report
    // `output_tokens: 0` at the top level while the true count sits nested under
    // `usage.iterations[]` (9 such messages in 103,754 real ones). What makes it safe
    // is narrower: `-p`'s *result envelope* computes its own aggregate over the whole
    // run, so a generation that produced text always reports non-zero here and never
    // reaches this branch.
    return { kind: "error", raw: trimmed, global: isGlobalFaultText(trimmed) };
  }

  // Real CLI-level failures. These never carried the outage, but they are the signal
  // the old code threw away, so surface them rather than parse-fail later.
  //
  // Never global. Not "because tokens were spent" — these arms are also reached when
  // `usage` is absent entirely, so the token count is unknown here, not proven. The
  // real reason is that `trimmed` at this point may BE the model's generated output,
  // and generated text must never decide how a failure is handled: a brief that
  // happens to mention credentials or a room number 401 would otherwise classify
  // itself as a global engine fault. When we cannot tell, per-request is the safe
  // answer — it burns attempts and terminates instead of parking for days.
  if (env?.is_error === true) return { kind: "error", raw: trimmed || "is_error", global: false };
  if (env?.api_error_status)
    return { kind: "error", raw: `api_error_status=${env.api_error_status}: ${trimmed}`, global: false };
  if (env?.subtype && env.subtype !== "success")
    return { kind: "error", raw: `subtype=${env.subtype}: ${trimmed}`, global: false };

  return { kind: "ok", text };
}

// ── The breaker itself ───────────────────────────────────────────────────────
// Process-wide, because the thing it protects is process-wide: one subscription,
// one CLI, one serialized queue. Deliberately in memory and not in the DB — a
// restart SHOULD re-probe rather than inherit a stale pause, and one probe costs
// nothing (a blocked call spends zero tokens).

type Block = { resetAt: Date; resetParsed: boolean; raw: string; since: Date };

const g = globalThis as unknown as { __membroQuotaBlock?: Block | null };

/** Record that we are out of credit until `resetAt`. Returns true on transition. */
export function tripQuotaBreaker(raw: string, resetAt: Date, resetParsed: boolean, now = new Date()): boolean {
  const first = !isQuotaBlocked(now.getTime());
  g.__membroQuotaBlock = { resetAt, resetParsed, raw, since: first ? now : (g.__membroQuotaBlock?.since ?? now) };
  return first;
}

/** The live block, or null once the reset time has passed. Self-clearing. */
export function quotaBlock(nowMs = Date.now()): Block | null {
  const b = g.__membroQuotaBlock;
  if (!b) return null;
  if (b.resetAt.getTime() <= nowMs) {
    g.__membroQuotaBlock = null;
    return null;
  }
  return b;
}

export function isQuotaBlocked(nowMs = Date.now()): boolean {
  return quotaBlock(nowMs) !== null;
}

/** Test seam: forget any block. */
export function resetQuotaBreaker(): void {
  g.__membroQuotaBlock = null;
}
