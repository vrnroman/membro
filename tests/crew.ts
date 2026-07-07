// Keyless, DB-backed test of the per-note CREW: the crew_facts MIGRATION (a legacy
// assist_jobs table gains the column), the Ledger member end to end (a filed
// contradiction becomes a pending conflict, dedupes on a re-run, and resolves), and
// the Researcher member (a new company leaves a stamped brief, a plain note leaves
// none). Runs the real repo + worker against a throwaway SQLite file on the mock.
// Run: npm run test:crew (also part of npm test).
process.env.MEMBRO_AI = "mock";

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "membro-crew-"));
process.env.MEMBRO_DATA_DIR = DIR;

// Seed an OLD-schema assist_jobs table (no crew_facts) BEFORE the app opens the db,
// so db()'s migrate() must ALTER the column in. This is the real upgrade path on the VM.
{
  const raw = new Database(join(DIR, "membro.db"));
  raw.exec(`
    create table assist_jobs (id text primary key, capture_id text, note text not null, status text not null default 'queued' check (status in ('queued','done','failed')), attempts integer not null default 0, next_attempt_at text not null, last_error text, created_at text not null, updated_at text not null);
  `);
  const ts = "2026-07-01T00:00:00Z";
  raw
    .prepare("insert into assist_jobs (id, note, status, attempts, next_attempt_at, created_at, updated_at) values (?,?,?,?,?,?,?)")
    .run("legacy-job", "old note", "done", 0, ts, ts, ts);
  raw.close();
}

import { db } from "@/lib/db";
import {
  insertPerson,
  insertFact,
  getFact,
  listPendingConflictsForPerson,
  resolveConflict,
  deleteFact,
  listPendingAssists,
} from "@/lib/repo";
import { enqueueAssistJob, claimDueAssistJobs } from "@/lib/assist/queue";
import { processAssistJob } from "@/lib/assist/process";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Drain every currently-queued crew job through the real worker path.
async function drain() {
  for (const job of claimDueAssistJobs(10)) await processAssistJob(job);
}

async function main() {
  // Migration: the legacy assist_jobs table gained the crew_facts column.
  const cols = (db().prepare("pragma table_info(assist_jobs)").all() as { name: string }[]).map((c) => c.name);
  check("migration adds crew_facts to a legacy assist_jobs table", cols.includes("crew_facts"));

  // ── Ledger member end to end ────────────────────────────────────────────────
  const { id: pid } = insertPerson({ name: "Dana" });
  const oldId = insertFact({ person_id: pid, kind: "preference", content: "Loves coffee" });
  const newId = insertFact({ person_id: pid, kind: "preference", content: "Hates coffee now, switched to tea" });

  enqueueAssistJob({
    captureId: null,
    note: "Dana hates coffee now.",
    firstAttemptAt: new Date().toISOString(),
    crewFacts: [{ personId: pid, factIds: [newId] }],
  });
  await drain();

  const conflicts = listPendingConflictsForPerson(pid);
  check(
    "the Ledger member flags the contradiction",
    conflicts.length === 1 && conflicts[0].newFact.id === newId && conflicts[0].oldFact.id === oldId,
    `n=${conflicts.length}`,
  );

  // Idempotency: re-running the same crew facts must not stack a duplicate.
  enqueueAssistJob({
    captureId: null,
    note: "Dana hates coffee now.",
    firstAttemptAt: new Date().toISOString(),
    crewFacts: [{ personId: pid, factIds: [newId] }],
  });
  await drain();
  check("re-detecting the same pair does not duplicate", listPendingConflictsForPerson(pid).length === 1);

  // Resolve keep_new the way the /api/conflicts route now does it: delete the loser
  // only; its ON DELETE CASCADE drops the conflict row.
  deleteFact(oldId);
  check("keep_new deletes the older fact", getFact(oldId) === null);
  check("keep_new keeps the newer fact", getFact(newId) !== null);
  check("keep_new clears the pending contradiction via cascade", listPendingConflictsForPerson(pid).length === 0);

  // Mirror-pair: BOTH captures' crew jobs notice the same contradiction (each treats
  // its own fact as "new"). It must be recorded ONCE, oriented newer-as-new.
  const { id: pid3 } = insertPerson({ name: "Uma" });
  const older = insertFact({ person_id: pid3, kind: "preference", content: "Loves the open office" });
  await new Promise((r) => setTimeout(r, 20)); // guarantee a strictly later created_at
  const newer = insertFact({ person_id: pid3, kind: "preference", content: "Hates the open office now, wants to go remote" });
  enqueueAssistJob({ captureId: null, note: "Uma loves the open office", firstAttemptAt: new Date().toISOString(), crewFacts: [{ personId: pid3, factIds: [older] }] });
  enqueueAssistJob({ captureId: null, note: "Uma hates the open office now", firstAttemptAt: new Date().toISOString(), crewFacts: [{ personId: pid3, factIds: [newer] }] });
  await drain();
  const uma = listPendingConflictsForPerson(pid3);
  check("mirror-pair captures record one conflict, not two", uma.length === 1, `n=${uma.length}`);
  check("the conflict is oriented newer-as-new", uma[0]?.newFact.id === newer && uma[0]?.oldFact.id === older);

  // keep_both just dismisses: both facts stay, the flag clears, and it never re-raises.
  resolveConflict(uma[0].id, "keep_both");
  check("keep_both keeps both facts", getFact(older) !== null && getFact(newer) !== null);
  check("keep_both dismisses the flag", listPendingConflictsForPerson(pid3).length === 0);

  // ── Researcher member end to end ────────────────────────────────────────────
  insertPerson({ name: "Sam" });
  enqueueAssistJob({
    captureId: "cap-r",
    note: "Had a call with the team at Northwind Labs about a pilot.",
    firstAttemptAt: new Date().toISOString(),
    crewFacts: [],
  });
  await drain();
  const briefs = listPendingAssists().filter((a) => (a.meta as { crew?: string }).crew === "researcher");
  check(
    "the Researcher leaves a stamped brief for a new company",
    briefs.length === 1 && briefs[0].title.includes("Northwind Labs"),
    `n=${briefs.length}`,
  );
  check("the research brief is stored as an advisory-kind row (zero-migration)", briefs[0]?.kind === "advisory");

  enqueueAssistJob({
    captureId: "cap-r2",
    note: "Quick lunch with Sam, all good.",
    firstAttemptAt: new Date().toISOString(),
    crewFacts: [],
  });
  await drain();
  const plain = listPendingAssists().filter(
    (a) => (a.meta as { crew?: string }).crew === "researcher" && a.capture_id === "cap-r2",
  );
  check("a note naming no new company leaves no brief", plain.length === 0, `n=${plain.length}`);

  // #10: a company already briefed on an earlier note is not re-briefed on a later
  // one (knownSubjects now includes prior researched subjects), even though it never
  // became a saved contact.
  enqueueAssistJob({
    captureId: "cap-r3",
    note: "Another sync with the folks at Northwind Labs coming up.",
    firstAttemptAt: new Date().toISOString(),
    crewFacts: [],
  });
  await drain();
  const reBrief = listPendingAssists().filter(
    (a) => (a.meta as { crew?: string }).crew === "researcher" && a.capture_id === "cap-r3",
  );
  check("an already-briefed company is not re-briefed on a later note", reBrief.length === 0, `n=${reBrief.length}`);

  console.log("");
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All crew checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
