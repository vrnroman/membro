// End-to-end proof of the whole point of the breaker: when the engine is out of
// quota, Membro spawns ONE process and then stops, instead of the 576 a day it
// spawned for 4.6 days in July 2026.
//
// This drives the real ClaudeCliAdapter against a fake `claude` binary that emits
// the exact envelope the real CLI produced during the outage (harvested from the
// session transcripts: a success-shaped envelope whose result is the limit text
// and whose usage is all zeros). Nothing is mocked above the process boundary.
process.env.MEMBRO_AI = "cli";

// This suite deliberately trips the quota breaker over and over, and a trip fires
// the real Telegram announce. On a dev laptop there are no credentials so the send
// throws instantly and harmlessly — but the VM's .env HAS them, so running `npm test`
// there would message the owner for real, and would leave a 12s network fetch
// in-flight that the announceInFlight guard then (correctly) collapses, making the
// injected-sender checks below fail depending on where they ran. Both problems have
// the same one-line cure: no credentials, so sendTelegramMessage always fails fast
// and offline. The delivery path itself is covered by injecting a Sender.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "membro-breaker-"));
process.env.MEMBRO_DATA_DIR = dir;

// The fake CLI: counts its own invocations, then answers exactly like the real one
// did while the weekly limit was blown.
const COUNTER = join(dir, "invocations");
const FAKE = join(dir, "fake-claude");
writeFileSync(
  FAKE,
  `#!/bin/sh
echo x >> "${COUNTER}"
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1750,"num_turns":1,"result":"You've hit your limit \\u00b7 resets 6am (UTC)","stop_reason":"stop_sequence","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
JSON
`,
);
chmodSync(FAKE, 0o755);
process.env.MEMBRO_CLAUDE_BIN = FAKE;

import { QuotaExhaustedError, resetQuotaBreaker, isQuotaBlocked } from "@/lib/ai/quota";

// NOTE: claude-cli reads MEMBRO_CLAUDE_BIN at module scope, and static imports are
// hoisted above the env assignments above, so importing it at the top would bind
// BIN to the REAL `claude` before the fake is installed. Load it lazily instead.
type CliAdapter = InstanceType<typeof import("@/lib/ai/claude-cli").ClaudeCliAdapter>;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
const invocations = () => (existsSync(COUNTER) ? readFileSync(COUNTER, "utf8").trim().split("\n").filter(Boolean).length : 0);

async function main() {
  resetQuotaBreaker();
  const { ClaudeCliAdapter } = await import("@/lib/ai/claude-cli");
  const adapter: CliAdapter = new ClaudeCliAdapter();
  // Guard the guard: if the fake is not wired up, this test would silently drive
  // the real CLI (it did, once, and hung for two minutes).
  if (process.env.MEMBRO_CLAUDE_BIN !== FAKE) throw new Error("fake CLI not wired up");
  const input = {
    person: { id: "p1", name: "Gil", company: null, role: null, blurb: null },
    facts: ["a fact"],
    newFacts: [],
    cadenceDays: null,
    today: "2026-07-12",
  };

  console.log("\nbreaker: the first call discovers the limit");
  let firstErr: unknown;
  try {
    await adapter.brief(input);
    check("first call throws", false, "it resolved");
  } catch (e) {
    firstErr = e;
  }
  check("first call throws QuotaExhaustedError, not a JSON parse error", firstErr instanceof QuotaExhaustedError, String((firstErr as Error)?.message));
  check(
    "it carries the real message instead of swallowing it",
    firstErr instanceof QuotaExhaustedError && /hit your limit/.test(firstErr.raw),
    (firstErr as QuotaExhaustedError)?.raw,
  );
  // The fake uses the UNDATED wording on purpose: "the next 6am UTC" is always
  // within 24h whatever day this test runs, whereas a hardcoded date would drift
  // into the past and get (correctly) clamped. Exact date parsing is pinned with a
  // frozen clock in tests/quota.ts instead.
  const ahead = firstErr instanceof QuotaExhaustedError ? firstErr.resetAt.getTime() - Date.now() : -1;
  check(
    "it learned when the engine comes back",
    firstErr instanceof QuotaExhaustedError && firstErr.resetParsed && ahead > 0 && ahead <= 86400_000,
    `resetAt=${(firstErr as QuotaExhaustedError)?.resetAt?.toISOString()} aheadMs=${ahead}`,
  );
  check("the breaker is now open", isQuotaBlocked());
  check("exactly one process was spawned so far", invocations() === 1, `spawned=${invocations()}`);

  console.log("\nbreaker: the next 24 calls (a day of ticks) spawn nothing");
  let quotaErrors = 0;
  for (let i = 0; i < 24; i++) {
    try {
      await adapter.brief(input);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) quotaErrors++;
    }
  }
  check("every blocked call still reports quota (callers can react)", quotaErrors === 24, String(quotaErrors));
  check(
    "STILL exactly one process spawned: 25 calls, 1 spawn (was 25 spawns)",
    invocations() === 1,
    `spawned=${invocations()}`,
  );

  // The other adapter methods share the same queue and the same breaker.
  console.log("\nbreaker: it covers every AI path, not just briefs");
  for (const call of [
    () => adapter.extract({ text: "hi", today: "2026-07-12", existingNames: [] }),
    () => adapter.assist({ note: "hi", today: "2026-07-12", people: [] }),
    () => adapter.reflect(["hi"], "2026-07-12"),
  ]) {
    try {
      await call();
    } catch {
      /* expected */
    }
  }
  check("extract / assist / reflect are gated too", invocations() === 1, `spawned=${invocations()}`);

  // The rule that keeps an outage from quietly abandoning everyone: a quota failure
  // is the engine being down, not a bad brief, so it must not spend a person's
  // attempts. Without this, 4.6 days of outage burns all 8 tries for all 9 people.
  console.log("\nbreaker: an outage does not burn anyone's retry budget");
  {
    const { listPeopleNeedingBrief, insertPerson, insertFact, getBriefAttempt } = await import("@/lib/repo");
    const { startBriefWorker: _s } = await import("@/lib/briefs/worker"); // ensure it compiles/loads
    void _s;
    const pid = insertPerson({ name: "Outage Victim" }).id;
    insertFact({ person_id: pid, kind: "fact", content: "a fact" });
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

    check("the new person is due before the outage", listPeopleNeedingBrief(twoDaysAgo, 10).includes(pid));
    // Simulate the worker's tick behaviour under a quota block: it must record nothing.
    for (let i = 0; i < 50; i++) {
      try {
        await adapter.brief({ ...input, person: { ...input.person, id: pid } });
      } catch (e) {
        if (!(e instanceof QuotaExhaustedError)) throw e;
        // the worker's rule: quota => do NOT recordBriefFailure
      }
    }
    check("50 quota failures burn zero attempts", getBriefAttempt(pid) === null);
    check("and the person is still due the moment quota returns", listPeopleNeedingBrief(twoDaysAgo, 10).includes(pid));
  }

  console.log("\nbreaker: it reopens on its own once the reset passes");
  resetQuotaBreaker(); // stands in for the clock reaching the reset time
  check("not blocked after the reset", !isQuotaBlocked());
  try {
    await adapter.brief(input);
  } catch {
    /* the fake still answers "limit", so it re-trips: that is correct */
  }
  check("it probes exactly once more after reopening", invocations() === 2, `spawned=${invocations()}`);

  // One ping per OUTAGE, not per probe. There are no Telegram creds in a test run,
  // so sendTelegramMessage throws: a throw means "it tried to send", and returning
  // quietly means "it suppressed". That is the oracle.
  console.log("\nalert: one ping per outage, not one per probe");
  {
    const { notifyQuotaPaused, notifyQuotaResumed } = await import("@/lib/nightshift/quota-alert");
    const { setKv } = await import("@/lib/repo");
    setKv("quota_paused_until", ""); // clean slate

    // Inject the sender so "delivered" is distinguishable from "tried and failed".
    let sent = 0;
    const ok = async () => {
      sent++;
    };
    const broken = async () => {
      sent++;
      throw new Error("telegram down");
    };
    const trip = (mins: number, send: typeof ok) =>
      notifyQuotaPaused("You've hit your org's monthly usage limit", new Date(Date.now() + mins * 60_000), false, send);

    // The no-reset wording mints a NEW estimate (now+30min) on every probe. Keying
    // the guard on that estimate pinged every 30 minutes forever; keying it on the
    // pause means only the first one goes out.
    await trip(30, ok);
    check("the first trip pings", sent === 1, `sent=${sent}`);
    await trip(60, ok);
    await trip(90, ok);
    await trip(120, ok);
    check("the next three probes of the SAME outage stay quiet", sent === 1, `sent=${sent}`);

    // A restart must not re-ping: the marker is in the DB, not in memory.
    await trip(30, ok);
    check("a restart cannot re-ping (the marker is durable)", sent === 1, `sent=${sent}`);

    // ...but once it actually comes back, the next outage is a new outage.
    await notifyQuotaResumed(ok);
    sent = 0;
    await trip(30, ok);
    check("after a resume, a new outage can ping again", sent === 1, `sent=${sent}`);

    // A transient Telegram blip at trip time must NOT silence the whole outage —
    // marking before the send bought "never twice" at the price of "sometimes
    // never", which is the silence this entire run exists to delete.
    await notifyQuotaResumed(ok);
    sent = 0;
    await trip(30, broken).catch(() => {});
    check("a failed send does not latch the marker", sent === 1, `sent=${sent}`);
    await trip(30, ok);
    check("the next probe retries the alert until one lands (at-least-once)", sent === 2, `sent=${sent}`);
    await trip(30, ok);
    check("and once it lands, it goes quiet again", sent === 2, `sent=${sent}`);

    // The marker is only written after a send lands, so simultaneous trips could all
    // read "no marker" and all send. An in-flight guard collapses that burst without
    // giving back at-least-once.
    await notifyQuotaResumed(ok);
    sent = 0;
    let release!: () => void;
    const slow = async () => {
      sent++;
      await new Promise<void>((r) => (release = r));
    };
    const burst = [trip(30, slow), trip(30, slow), trip(30, slow), trip(30, slow)];
    check("a burst of simultaneous trips sends once, not four times", sent === 1, `sent=${sent}`);
    release();
    await Promise.all(burst);
    await notifyQuotaResumed(ok);
  }

  // The check above proves the RULE. This one proves the rule is actually reachable
  // where it ships, which is a different claim and the one that was false: calling
  // notifyQuotaPaused directly bypasses runClaude's `if (blocked) throw` short-
  // circuit, so the "next probe retries" story only held for callers that never
  // exist once the breaker is open. With the DATED wording (2104x in the corpus,
  // the incident's own message) the breaker parks for days, so a single failed send
  // used to mean silence for the entire outage.
  //
  // Oracle: no Telegram creds here, so every real send throws and announceQuotaPause
  // logs "could not announce pause". Counting that line counts real attempts made
  // through the real adapter path.
  console.log("\nalert: the retry is reachable on the BLOCKED path (dated wording, days-long park)");
  {
    const { resetQuotaBreaker: reset } = await import("@/lib/ai/quota");
    const { setKv } = await import("@/lib/repo");
    reset();
    setKv("quota_paused_until", "");

    // A dated reset 3 days out, generated relative to now so this never goes stale.
    const at = new Date(Date.now() + 3 * 86400_000);
    const mon = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const dated = `You've hit your limit \\u00b7 resets ${mon} ${at.getUTCDate()}, 6am (UTC)`;
    writeFileSync(
      FAKE,
      `#!/bin/sh
echo x >> "${COUNTER}"
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"${dated}","usage":{"input_tokens":0,"output_tokens":0}}
JSON
`,
    );
    chmodSync(FAKE, 0o755);

    const errs: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    try {
      for (let i = 0; i < 6; i++) {
        await adapter.brief(input).catch(() => {});
      }
    } finally {
      console.error = realErr;
    }
    const attempts = errs.filter((l) => /could not announce pause/.test(l)).length;
    check("the park really is days long (so no probe would re-announce on its own)", isQuotaBlocked());
    check(
      "a failed alert is retried on the blocked path, not left silent for days",
      attempts >= 2,
      `announce attempts=${attempts}`,
    );
    reset();
    setKv("quota_paused_until", "");
  }

  console.log(failures ? `\n${failures} breaker check(s) FAILED\n` : "\nall breaker checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
