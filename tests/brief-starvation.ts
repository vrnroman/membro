// Regression test for the July 2026 outage: two people whose brief always failed
// held both sweep slots for 4.6 days and nobody else was ever reached.
//
// The mechanism, exactly: a failed generation writes no `briefs` row, and
// listPeopleNeedingBrief sorts never-briefed people FIRST, so the same two came
// back at the head of the queue on every single tick. 576 wasted calls a day, and
// seven of nine people sat with no Pre-Read at all. This file pins the fix: a
// failure is remembered, so it yields its slot.
process.env.MEMBRO_AI = "mock";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MEMBRO_DATA_DIR = mkdtempSync(join(tmpdir(), "membro-starve-"));

import {
  insertPerson,
  insertFact,
  listPeopleNeedingBrief,
  recordBriefFailure,
  clearBriefAttempts,
  getBriefAttempt,
  markBriefStale,
  upsertBrief,
} from "@/lib/repo";
import { MAX_BRIEF_ATTEMPTS, briefBackoffMs } from "@/lib/briefs/policy";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const twoDaysAgo = () => new Date(Date.now() - 2 * 86400000).toISOString();
const BATCH = 2; // the real worker's batch size

// The cast of the original incident: two poison pills at the head, and the people
// who were starved behind them.
const gil = insertPerson({ name: "Gil" }).id;
const kelvin = insertPerson({ name: "Kelvin" }).id;
const lucinda = insertPerson({ name: "Lucinda" }).id;
const helen = insertPerson({ name: "Helen" }).id;
for (const id of [gil, kelvin, lucinda, helen]) insertFact({ person_id: id, kind: "fact", content: "a fact" });

console.log("\nstarvation: the incident, reproduced then fixed");
{
  const due = listPeopleNeedingBrief(twoDaysAgo(), BATCH);
  check("all four are never-briefed, so the batch takes the first two", due.length === 2, JSON.stringify(due));

  // Gil and Kelvin fail, exactly as they did in production.
  for (const id of due) {
    recordBriefFailure(id, "no JSON object in claude -p output", 1, new Date(Date.now() + briefBackoffMs(1)).toISOString());
  }

  // THE REGRESSION. Before the fix this returned [gil, kelvin] again, forever.
  const next = listPeopleNeedingBrief(twoDaysAgo(), BATCH);
  check(
    "the two failures yield their slots instead of re-taking them",
    !next.includes(due[0]) && !next.includes(due[1]),
    `next=${JSON.stringify(next)}`,
  );
  check("the people behind them are finally reached", next.length === 2, JSON.stringify(next));
  check(
    "every person is eventually reachable (nobody is starved)",
    new Set([...due, ...next]).size === 4,
    JSON.stringify([...due, ...next]),
  );
}

console.log("\nstarvation: backoff, give-up, and recovery");
{
  clearBriefAttempts(gil);
  // A failure that has not served its backoff is not due yet.
  recordBriefFailure(gil, "boom", 1, new Date(Date.now() + 60_000).toISOString());
  check("a person inside their backoff is not due", !listPeopleNeedingBrief(twoDaysAgo(), 10).includes(gil));

  // Once the backoff has passed, they come back.
  recordBriefFailure(gil, "boom", 1, new Date(Date.now() - 1000).toISOString());
  check("a person past their backoff is due again", listPeopleNeedingBrief(twoDaysAgo(), 10).includes(gil));

  // Past the cap the backoff has saturated, but they are NEVER dropped for good:
  // a global outage (read-only disk, expired token) is nobody's fault, and an
  // earlier cut of this abandoned all nine people permanently after ~16h of it.
  recordBriefFailure(gil, "boom", MAX_BRIEF_ATTEMPTS + 5, new Date(Date.now() - 1000).toISOString());
  check(
    "a person past the attempt cap is still reachable once their backoff passes",
    listPeopleNeedingBrief(twoDaysAgo(), 10).includes(gil),
  );
  check("the real reason is kept, not swallowed", getBriefAttempt(gil)?.last_error === "boom");

  // ...but a fact change is a fresh start: whatever broke may be gone.
  upsertBrief({ personId: gil, body: JSON.stringify({ read: "r", insights: [], recommendations: [] }), sourceFactCount: 1 });
  markBriefStale(gil);
  check("a fact change clears the give-up and makes them due again", getBriefAttempt(gil) === null);
  check("and they are back in the sweep", listPeopleNeedingBrief(twoDaysAgo(), 10).includes(gil));
}

console.log("\nstarvation: backoff curve");
{
  check("backoff grows", briefBackoffMs(1) < briefBackoffMs(3) && briefBackoffMs(3) < briefBackoffMs(5));
  check("backoff is capped at 6h", briefBackoffMs(50) === 6 * 3600_000, String(briefBackoffMs(50)));
  check("first backoff is at least one tick (5m), never a same-tick retry", briefBackoffMs(1) >= 5 * 60_000);
}

console.log(failures ? `\n${failures} starvation check(s) FAILED\n` : "\nall starvation checks passed\n");
process.exit(failures ? 1 : 0);
