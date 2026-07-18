// Regression test for the two sibling queues, from the high code review.
//
// The brief worker learned that a quota outage is the ENGINE being down and must
// not be charged to an individual item. Its siblings did not, and they are worse
// off than briefs were: their give-up is TERMINAL. The assist queue would mark a
// note 'failed' after ~35 minutes of outage, the voice queue after ~11h (its policy
// literally says "a quota reset lands well inside that", which is false for a weekly
// limit). Neither status is ever re-claimed, so every note captured during a 4.6-day
// outage — its draft, its diary entry, its Researcher brief, its Ledger check —
// would be abandoned for good and would NOT come back when quota did.
process.env.MEMBRO_AI = "mock";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MEMBRO_DATA_DIR = mkdtempSync(join(tmpdir(), "membro-quotajobs-"));

import { db } from "@/lib/db";
import { isGlobalFault } from "@/lib/ai/claude-cli";
import { enqueueAssistJob, claimDueAssistJobs, parkAssistJob, rescheduleAssistJob } from "@/lib/assist/queue";
import { retriedTooLong, RETRY_MIN_ATTEMPTS } from "@/lib/ai/quota";
// Static: unlike claude-cli, quota.ts reads no env at module scope, so hoisting is
// harmless (and top-level await is not available in this cjs output).
import {
  classifyEnvelope,
  AdapterError,
  ENGINE_RETRY_MS,
  PARK_MAX_AGE_MS,
  QUOTA_MAX_MS,
  isGlobalFaultText,
} from "@/lib/ai/quota";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const row = (id: string) =>
  db().prepare("select status, attempts, next_attempt_at from assist_jobs where id = ?").get(id) as {
    status: string;
    attempts: number;
    next_attempt_at: string;
  };

console.log("\nquota-jobs: an outage must not spend a note's attempts");
{
  enqueueAssistJob({ captureId: null, note: "Dana wants the deck", firstAttemptAt: new Date(0).toISOString() });
  const [job] = claimDueAssistJobs(1);
  check("a job is claimable", !!job);

  // A weekly outage: many probes across days, each one parking the job.
  const resetAt = new Date(Date.now() + 4 * 86400_000).toISOString();
  for (let i = 0; i < 40; i++) parkAssistJob(job.id, resetAt, "paused, out of AI quota");

  const r = row(job.id);
  check("40 quota parks burn zero attempts", r.attempts === 0, `attempts=${r.attempts}`);
  check("the job is still queued, never failed", r.status === "queued", r.status);
  check("and it waits for the reset, not a backoff", r.next_attempt_at === resetAt);
}

// The same rule for the OTHER global fault. A quota limit at least announces itself;
// a read-only disk (10x in the real corpus) and an expired token (2x) just come back
// with text and zero tokens. Both are persistent, so they always outlast the ~35min
// give-up, and charging them to a note marks it permanently failed over a fault it
// had nothing to do with.
console.log("\nquota-jobs: an engine-down fault (EROFS / 401) is global too, and must not be charged to a note");
{
  const zero = { output_tokens: 0, input_tokens: 0 };
  const envOf = (result: string) =>
    ({ type: "result", subtype: "success", is_error: false, result, usage: zero }) as never;

  const erofs = classifyEnvelope(envOf("API Error: EROFS: read-only file system, open '/home/x/.claude.json'"), "", Date.now());
  const auth = classifyEnvelope(envOf("Failed to authenticate. API Error: 401 Invalid authentication credentials"), "", Date.now());
  check("EROFS is flagged global (the model was never reached)", erofs.kind === "error" && erofs.global === true);
  check("401 is flagged global", auth.kind === "error" && auth.global === true);

  // A request that really ran and failed is NOT global: it should burn attempts as
  // before, or a genuinely bad note would retry forever and never complete.
  const ran = classifyEnvelope(
    { subtype: "error_during_execution", is_error: true, result: "boom", usage: { output_tokens: 120 } } as never,
    "",
    Date.now(),
  );
  check("a request that actually ran and failed is NOT global", ran.kind === "error" && ran.global === false);

  // THE AXIS THAT MATTERED, and that the tokens-were-spent case above does not
  // touch. The API spends ZERO output tokens rejecting one specific bad request, so
  // "no tokens" cannot mean "global". Inferring it from the token count parked a
  // permanently unprocessable note every 30 minutes forever: never done, never
  // failed, and logged as "AI engine unavailable" while the disk and token were
  // both fine. Both of these are reachable from a real multi-photo capture.
  const tooLong = classifyEnvelope(
    envOf("API Error: 400 invalid_request_error: prompt is too long: 213476 tokens > 200000 maximum"),
    "",
    Date.now(),
  );
  check(
    "a zero-token per-request rejection (prompt too long) is NOT global",
    tooLong.kind === "error" && tooLong.global === false,
    JSON.stringify(tooLong),
  );
  const badImage = classifyEnvelope(envOf("API Error: 400 invalid_request_error: image exceeds 5 MB maximum"), "", Date.now());
  check("a zero-token oversized-image rejection is NOT global", badImage.kind === "error" && badImage.global === false);
  const timedOut = classifyEnvelope(envOf("Command failed: claude -p ... timed out after 120000ms"), "", Date.now());
  check("a timeout is NOT global (the model may well have been running)", timedOut.kind === "error" && timedOut.global === false);

  // ...and the converse the verifier proved: the SAME real fault (broken auth) in a
  // shape with no envelope at all (a logged-out CLI exits 1 with stderr only) used
  // to default to global:false and destroy the note, while the enveloped 401 parked.
  check("a logged-out CLI's stderr is recognised as global", isGlobalFaultText("Invalid API key · Please run /login"));
  check("a missing binary is global", isGlobalFaultText("spawn claude ENOENT"));
  check("EROFS text is global wherever it appears", isGlobalFaultText("Error: EROFS: read-only file system"));
  check("a too-long prompt is never global, in any shape", !isGlobalFaultText("prompt is too long: 213476 tokens > 200000 maximum"));
  check("a global AdapterError carries the flag through", new AdapterError("x", true).global === true);
  check("engine retry is a bounded 30min, not a guess at a deadline", ENGINE_RETRY_MS === 30 * 60_000);
  // Parking spends no attempts, so something must stop a mis-judged fault parking a
  // note forever — but that backstop must never fire during the real thing it exists
  // for, a 7-day weekly outage.
  check("the park backstop outlasts the longest real outage (7d weekly limit)", PARK_MAX_AGE_MS > QUOTA_MAX_MS);
  check("but it is finite, so every fault class terminates", Number.isFinite(PARK_MAX_AGE_MS) && PARK_MAX_AGE_MS > 0);

  check("credit-balance exhaustion is global (seen in the CLI binary)", isGlobalFaultText("Credit balance is too low"));
}

// THE AXIS THE SUITE WAS MISSING: the fault decides `global`, the note NEVER does.
//
// These are ordinary English words, and node's execFile builds `err.message` by
// echoing the whole command line back — prompt included. Classifying that string let
// the owner's own note decide how a failure was handled: one identical killed-process
// fault, and "room 401" / "the API credentials" / a link ending in "/login" each
// parked a perfectly ordinary note for ten days, logged as "AI engine unavailable"
// while the disk and token were healthy. isGlobalFault reads stderr + err.code only,
// which is the engine talking about itself.
console.log("\nquota-jobs: the note text can never decide how a fault is handled");
{
  const killed = (note: string) =>
    // Exactly what node hands us when the CLI is killed: the args, verbatim.
    new Error(`Command failed: /usr/bin/claude -p ${note} --output-format json`);

  for (const note of [
    "Meeting with Sam moved to room 401 tomorrow",
    "Tom is sending over the API credentials on Monday",
    "Priya sent the portal link https://acme.com/login for the demo",
    "Ask legal whether that NDA clause is unauthorized",
    "Dana wants the deck by Friday",
  ]) {
    // Same fault every time, only the note varies: the verdict must not move.
    check(`same fault, note "${note.slice(0, 30)}..." => not global`, isGlobalFault(killed(note), "") === false);
    // And the words really are in err.message — proving the guarantee comes from
    // refusing to read it, not from luck.
    check(`  (and err.message really does carry the note)`, /401|credentials|login|unauthorized|deck/i.test(killed(note).message));
  }

  // The real global shapes still land, from the engine's own channels.
  check("logged-out is global via stderr", isGlobalFault(new Error("Command failed"), "Invalid API key · Please run /login"));
  check(
    "a missing binary is global via err.code, not its message",
    isGlobalFault(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), ""),
  );
  check("a killed/timed-out run with clean stderr is NOT global", isGlobalFault(killed("anything"), "") === false);

  enqueueAssistJob({ captureId: null, note: "note during an EROFS outage", firstAttemptAt: new Date(0).toISOString() });
  const jobs = claimDueAssistJobs(10);
  const j = jobs[jobs.length - 1];
  for (let i = 0; i < 30; i++) parkAssistJob(j.id, new Date(Date.now() + ENGINE_RETRY_MS).toISOString(), "engine down");
  check("30 engine-down parks burn zero attempts", row(j.id).attempts === 0, `attempts=${row(j.id).attempts}`);
  check("the note is still queued, not failed", row(j.id).status === "queued", row(j.id).status);
}

console.log("\nquota-jobs: a REAL per-note failure still burns attempts (the park is not a free pass)");
{
  enqueueAssistJob({ captureId: null, note: "another note", firstAttemptAt: new Date(0).toISOString() });
  const jobs = claimDueAssistJobs(5);
  const j = jobs[jobs.length - 1];
  rescheduleAssistJob(j.id, new Date(Date.now() + 1000).toISOString(), "a real model hiccup");
  check("a genuine failure still counts", row(j.id).attempts === 1, `attempts=${row(j.id).attempts}`);
}

// The unified per-request give-up: retry ~10h (wall-clock), then give up — but only
// after a floor of real attempts, so a note that sat parked through a multi-day
// outage still gets genuine tries instead of insta-giving-up on its first hiccup.
console.log("\nquota-jobs: the shared ~10h retry give-up (retriedTooLong)");
{
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 11 * 3600_000).toISOString(); // aged past the 10h bound
  const ancient = new Date(Date.now() - 5 * 86400_000).toISOString(); // parked through a long outage
  check("a fresh note never gives up, however many attempts", !retriedTooLong(now, 50));
  check("an aged note gives up once past the attempt floor", retriedTooLong(old, RETRY_MIN_ATTEMPTS));
  check("an aged note with too few attempts keeps trying (park-through-outage guard)", !retriedTooLong(ancient, RETRY_MIN_ATTEMPTS - 1));
  check("a bad timestamp still terminates on attempts alone (never loops forever)", retriedTooLong("not-a-date", RETRY_MIN_ATTEMPTS));
  const future = new Date(Date.now() + 3 * 3600_000).toISOString(); // clock skew: created "in the future"
  check("a future created_at cannot loop forever (terminates on the floor)", retriedTooLong(future, RETRY_MIN_ATTEMPTS));
  check("a future created_at still respects the floor first", !retriedTooLong(future, RETRY_MIN_ATTEMPTS - 1));
}

console.log(failures ? `\n${failures} quota-jobs check(s) FAILED\n` : "\nall quota-jobs checks passed\n");
process.exit(failures ? 1 : 0);
