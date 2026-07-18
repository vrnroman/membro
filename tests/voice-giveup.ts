// The unified ~10h retry give-up for voice, and the salvage that makes it safe.
//
// A voice note becomes a visible Notes entry only when filing SUCCEEDS, so a job
// that keeps failing to file would otherwise vanish: the transcript sits invisible in
// voice_jobs forever. When the worker finally gives up (~10h), it must salvage the
// transcript into the Notes inbox so the owner can reprocess it by hand. This drives
// the REAL voice worker against a fake `claude` that fails per-request (returns
// non-JSON), which is the transient error the give-up is for.
process.env.MEMBRO_AI = "cli";
process.env.MEMBRO_DISABLE_ALERTS = "1";

import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "membro-voicegiveup-"));
process.env.MEMBRO_DATA_DIR = dir;

// A fake CLI that returns a well-formed envelope whose RESULT is not JSON, with real
// tokens spent — so it classifies as a genuine per-request failure (the extract
// parser throws "no JSON object"), NOT a global outage.
const FAKE = join(dir, "fake-claude");
writeFileSync(
  FAKE,
  `#!/bin/sh
cat <<'JSON'
{"type":"result","subtype":"success","is_error":false,"result":"sorry, no structured output","usage":{"input_tokens":5,"output_tokens":7}}
JSON
`,
);
chmodSync(FAKE, 0o755);
process.env.MEMBRO_CLAUDE_BIN = FAKE;

import { db } from "@/lib/db";
import { enqueueVoiceJob, claimDueJobs } from "@/lib/voice/queue";
import { listCapturesWithFiled } from "@/lib/repo";
import { RETRY_MIN_ATTEMPTS } from "@/lib/ai/quota";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const jobRow = (id: string) =>
  db().prepare("select status, attempts from voice_jobs where id = ?").get(id) as { status: string; attempts: number };
const age = (id: string, ms: number, attempts: number) =>
  db().prepare("update voice_jobs set created_at = ?, attempts = ? where id = ?").run(new Date(Date.now() - ms).toISOString(), attempts, id);

async function main() {
  const { processJob } = await import("@/lib/voice/process"); // after MEMBRO_CLAUDE_BIN is set

  console.log("\nvoice give-up: a fresh failing note keeps retrying, does not give up");
  {
    const id = enqueueVoiceJob({ audioBase64: "x", mimeType: "audio/m4a", prefixText: "", names: [], transcript: "Met Dana about the Q3 contract", firstAttemptAt: new Date(0).toISOString() });
    // Fresh (created now), so even with many attempts it must not give up.
    age(id, 0, 50);
    const [job] = claimDueJobs(5);
    await processJob(job);
    const r = jobRow(id);
    check("a fresh note stays queued (retries), not failed", r.status === "queued", r.status);
    check("no premature salvage capture", !listCapturesWithFiled(50).some((c) => /Q3 contract/.test(c.body)));
  }

  console.log("\nvoice give-up: an aged, still-failing note gives up AND salvages the transcript to Notes");
  {
    const id = enqueueVoiceJob({ audioBase64: "x", mimeType: "audio/m4a", prefixText: "", names: [], transcript: "I promised Priya the deck by Friday", firstAttemptAt: new Date(0).toISOString() });
    age(id, 11 * 3600_000, RETRY_MIN_ATTEMPTS); // past 10h, past the attempt floor
    const job = claimDueJobs(5).find((j) => j.id === id)!;
    await processJob(job);
    const r = jobRow(id);
    check("the job is marked failed after ~10h", r.status === "failed", r.status);
    const salvaged = listCapturesWithFiled(50).find((c) => /promised Priya the deck/.test(c.body));
    check("the transcript is salvaged into the Notes inbox (not lost)", !!salvaged, JSON.stringify(listCapturesWithFiled(50).map((c) => c.body)));
    check("it is filed as a voice capture", salvaged?.source_type === "voice");
  }

  // Review finding #2: the transcript is produced THIS run — stage-1 (transcribe)
  // succeeds and writes it to the DB, but the in-memory job.transcript stays null —
  // then stage-2 filing hiccups at the give-up boundary. The salvage must use the
  // fresh transcript, not the stale field. Drive the REAL stage-1 by mocking Gemini's
  // fetch so it returns a transcript; stage-2 still hits the fake CLI and fails.
  console.log("\nvoice give-up: salvages the transcript produced THIS run, not the stale in-memory field");
  {
    process.env.GEMINI_API_KEY = "fake-key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("generativelanguage")
        ? { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Ravi wants the pricing sheet next week" }] } }] }) }
        : realFetch(url as never)) as typeof fetch;
    try {
      // transcript null at enqueue, so stage-1 runs and produces it THIS run.
      const id = enqueueVoiceJob({ audioBase64: "x", mimeType: "audio/m4a", prefixText: "", names: [], transcript: null, firstAttemptAt: new Date(0).toISOString() });
      age(id, 11 * 3600_000, RETRY_MIN_ATTEMPTS);
      const job = claimDueJobs(5).find((j) => j.id === id)!;
      check("the claimed job's in-memory transcript is null (the bug's precondition)", job.transcript === null);
      await processJob(job);
      check("the job is failed", jobRow(id).status === "failed", jobRow(id).status);
      check("the fresh transcript is salvaged, not lost to the stale field", listCapturesWithFiled(50).some((c) => /Ravi wants the pricing sheet/.test(c.body)));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  }

  console.log("\nvoice give-up: an aged note with too few attempts keeps trying (park-through-outage guard)");
  {
    const id = enqueueVoiceJob({ audioBase64: "x", mimeType: "audio/m4a", prefixText: "", names: [], transcript: "Sarah moved to Berlin", firstAttemptAt: new Date(0).toISOString() });
    age(id, 30 * 86400_000, 1); // very old (parked long) but only 1 real try so far (this run = 2nd)
    const job = claimDueJobs(5).find((j) => j.id === id)!;
    await processJob(job);
    check("still queued, not given up, despite old created_at", jobRow(id).status === "queued", jobRow(id).status);
  }

  console.log(failures ? `\n${failures} voice give-up check(s) FAILED\n` : "\nall voice give-up checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
