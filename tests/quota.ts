// Quota breaker tests. The fixtures are not invented: every message below was
// harvested from the 2,756 real `claude -p` session transcripts the July 2026
// outage left on the VM, with its real occurrence count, before those transcripts
// were deleted. That corpus is why this file tests four limit wordings instead of
// the one everybody remembers, and why it tests the two zero-usage messages that
// are NOT quota at all.
import {
  classifyEnvelope,
  parseResetAt,
  QUOTA_FALLBACK_MS,
  QUOTA_MAX_MS,
  QUOTA_MIN_MS,
  quotaBlock,
  resetQuotaBreaker,
  tripQuotaBreaker,
  isQuotaBlocked,
  type ClaudeEnvelope,
} from "@/lib/ai/quota";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// The real envelope shape, confirmed against a live run on the VM.
const zeroUsage = { output_tokens: 0, input_tokens: 0 };
const realUsage = { output_tokens: 142, input_tokens: 6 };
function env(result: string, usage: object | null = zeroUsage): ClaudeEnvelope {
  return { type: "result", subtype: "success", is_error: false, api_error_status: null, result, usage } as ClaudeEnvelope;
}

const NOW = Date.parse("2026-07-12T09:00:00Z");

console.log("\nquota: the four real limit wordings from the corpus");
{
  // 2104x in the corpus. The dated form: reset is four days out.
  const c = classifyEnvelope(env("You've hit your limit · resets Jul 16, 6am (UTC)"), "", NOW);
  check("dated form classifies as quota", c.kind === "quota");
  if (c.kind === "quota") {
    check("dated form parses the reset", c.resetParsed, c.resetAt.toISOString());
    check(
      "dated reset is Jul 16 06:00 UTC",
      c.resetAt.toISOString() === "2026-07-16T06:00:00.000Z",
      c.resetAt.toISOString(),
    );
  }
}
{
  // 526x. Undated: the next 6am UTC after "now" (09:00 Jul 12) is Jul 13.
  const c = classifyEnvelope(env("You've hit your limit · resets 6am (UTC)"), "", NOW);
  check("undated form classifies as quota", c.kind === "quota");
  if (c.kind === "quota") {
    check("undated rolls to next day", c.resetAt.toISOString() === "2026-07-13T06:00:00.000Z", c.resetAt.toISOString());
  }
}
{
  // 30x. Different hour, proving the hour is not a constant to hardcode.
  const c = classifyEnvelope(env("You've hit your limit · resets 2am (UTC)"), "", NOW);
  check("undated 2am classifies as quota", c.kind === "quota");
  if (c.kind === "quota") {
    check("undated 2am rolls to next day", c.resetAt.toISOString() === "2026-07-13T02:00:00.000Z", c.resetAt.toISOString());
  }
}
{
  // 14x. No reset time at all: the fallback must fire and must NOT claim to know.
  const c = classifyEnvelope(env("You've hit your org's monthly usage limit"), "", NOW);
  check("monthly form classifies as quota", c.kind === "quota");
  if (c.kind === "quota") {
    check("monthly form admits it does not know the reset", !c.resetParsed);
    check(
      "monthly form falls back to a short pause",
      c.resetAt.getTime() === NOW + QUOTA_FALLBACK_MS,
      c.resetAt.toISOString(),
    );
  }
}

console.log("\nquota: the zero-usage messages that are NOT quota (the trap)");
{
  // 10x in the corpus. Zero usage, real text, but a filesystem bug: pausing for
  // days on this would be the original incident wearing a new hat.
  const c = classifyEnvelope(env("API Error: EROFS: read-only file system, open '/home/x/.claude.json'"), "", NOW);
  check("EROFS is an error, not quota", c.kind === "error", c.kind);
}
{
  // 2x. Same shape, auth problem. Must surface loudly, not park the app.
  const c = classifyEnvelope(env("Failed to authenticate. API Error: 401 Invalid authentication credentials"), "", NOW);
  check("401 is an error, not quota", c.kind === "error", c.kind);
}

console.log("\nquota: real generations are never mistaken for a limit");
{
  const c = classifyEnvelope(env('{"read":"Gil is a collaborator","insights":[],"recommendations":[]}', realUsage), "", NOW);
  check("a real generation is ok", c.kind === "ok");
}
{
  // The nastiest false positive available: a genuine brief that happens to discuss
  // a limit. Real tokens were spent, so it is a real answer.
  const c = classifyEnvelope(env('{"read":"Ana raised the credit limit issue"}', realUsage), "", NOW);
  check("a real generation mentioning 'limit' is still ok", c.kind === "ok", c.kind);
}
{
  // An unparsed envelope means `usage` is UNKNOWN, so we cannot prove the model
  // never ran — and we must not guess. This test used to assert the opposite and
  // was pinning a real bug: matching the bare word "limit" against whatever landed
  // on stdout would park every AI path (and fire a false "out of quota" alert) on a
  // run that actually succeeded. Falling through to `ok` is the OLD behaviour, and
  // the old behaviour was right here: parseJsonObject digs the JSON out of prose.
  const c = classifyEnvelope(null, "You've hit your limit · resets 6am (UTC)", NOW);
  check("an unparsed envelope is never guessed to be quota", c.kind === "ok", c.kind);
}
{
  // The false positive that motivates the rule: a truncated brief that happens to
  // discuss a limit. It really is a generation; parking the app on it would be a
  // self-inflicted outage.
  const c = classifyEnvelope(null, 'Some notice\n{"read":"Ana raised the credit limit issue"}', NOW);
  check("a truncated real brief mentioning 'limit' is not quota", c.kind === "ok", c.kind);
}
{
  // Same shape, but the envelope parsed and PROVES no tokens were spent.
  const c = classifyEnvelope(env("You've hit your limit · resets 6am (UTC)"), "", NOW);
  check("a provable zero-usage limit reply IS quota", c.kind === "quota", c.kind);
}
{
  const c = classifyEnvelope({ subtype: "error_during_execution", is_error: true, result: "boom" }, "", NOW);
  check("is_error envelope is an error", c.kind === "error");
}

console.log("\nquota: an untrusted reset fails SHORT, never long");
{
  // THE regression. The breaker self-clears exactly at resetAt, so every outage
  // ends with a probe at the boundary; if the server has not flipped yet, that
  // probe gets the same dated message with a now-PAST reset. Rolling that forward
  // a year and capping at 7 days would black the app out for a week at the precise
  // moment it was recovering. An untrusted delta must land on the short fallback.
  const justPassed = parseResetAt("resets Jul 16, 6am (UTC)", Date.parse("2026-07-16T06:00:05Z"));
  const ahead = justPassed.at.getTime() - Date.parse("2026-07-16T06:00:05Z");
  check("a just-passed reset probes again in minutes, not days", ahead === QUOTA_FALLBACK_MS, `aheadMs=${ahead}`);
  check("and it does not claim to know the reset", !justPassed.parsed);
}
{
  // A stale year would park the engine for months. It must fail short too.
  const far = parseResetAt("resets Jan 1, 6am (UTC)", Date.parse("2026-02-01T00:00:00Z"));
  const ahead = far.at.getTime() - Date.parse("2026-02-01T00:00:00Z");
  check("an ~11-month-out reset falls back short", ahead === QUOTA_FALLBACK_MS, `aheadMs=${ahead}`);
  check("an untrusted reset stops claiming to be parsed", !far.parsed);
  check("nothing ever exceeds the 7-day cap", ahead <= QUOTA_MAX_MS);
}
{
  // The genuine year-rollover the roll-forward exists for: on New Year's Eve, a
  // "Jan 1" reset really is next year, and it is a day away, so it stays trusted.
  const nye = parseResetAt("resets Jan 1, 6am (UTC)", Date.parse("2026-12-31T12:00:00Z"));
  check("a real new-year rollover is still parsed", nye.parsed, nye.at.toISOString());
  check("and lands on Jan 1", nye.at.toISOString() === "2027-01-01T06:00:00.000Z", nye.at.toISOString());
}
{
  const soon = parseResetAt("resets 6am (UTC)", Date.parse("2026-07-12T05:59:30Z"));
  check("a reset 30s away is floored to the minimum", soon.at.getTime() - Date.parse("2026-07-12T05:59:30Z") >= QUOTA_MIN_MS);
}

console.log("\nquota: the wording drifts (it is written server-side, not by the CLI)");
{
  // CLI 2.1.211 says "at" instead of the comma and names the zone Etc/UTC. The VM is
  // still on 2.1.138 (comma form), so both have to parse or the countdown quietly
  // disappears the day the VM updates.
  const newForm = parseResetAt("resets Jul 16 at 6pm (Etc/UTC)", NOW);
  check("the 2.1.211 'at' + Etc/UTC form parses", newForm.parsed, newForm.at.toISOString());
  check("and lands on 18:00", newForm.at.toISOString() === "2026-07-16T18:00:00.000Z", newForm.at.toISOString());
}
{
  const mins = parseResetAt("resets Jul 16 at 6:30am (UTC)", NOW);
  check("a reset with minutes parses", mins.parsed && mins.at.toISOString() === "2026-07-16T06:30:00.000Z", mins.at.toISOString());
}
{
  // A zone we cannot place must NOT be guessed at as UTC: that would be wrong by
  // hours, and a confidently wrong countdown is worse than none.
  const other = parseResetAt("resets Jul 16 at 6am (America/New_York)", NOW);
  check("a non-UTC zone falls back rather than guessing", !other.parsed);
  check("and probes again shortly", other.at.getTime() === NOW + QUOTA_FALLBACK_MS);
}
{
  const c = classifyEnvelope(env(""), "", NOW);
  check("an empty result is an error, not a silent pass to the JSON parser", c.kind === "error", c.kind);
}

console.log("\nquota: the breaker gates and self-clears");
{
  resetQuotaBreaker();
  check("starts closed", !isQuotaBlocked(NOW));
  const first = tripQuotaBreaker("limit", new Date(NOW + 3600_000), true, new Date(NOW));
  check("first trip reports the transition (so we ping once)", first);
  const second = tripQuotaBreaker("limit", new Date(NOW + 3600_000), true, new Date(NOW));
  check("a second trip is not a transition (so we do not ping again)", !second);
  check("blocked while parked", isQuotaBlocked(NOW + 60_000));
  check("self-clears once the reset passes", !isQuotaBlocked(NOW + 3600_001));
  check("block is gone after clearing", quotaBlock(NOW + 3600_001) === null);
  resetQuotaBreaker();
}

console.log(failures ? `\n${failures} quota check(s) FAILED\n` : "\nall quota checks passed\n");
process.exit(failures ? 1 : 0);
