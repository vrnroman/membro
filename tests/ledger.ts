// Keyless, DB-backed test of the Ledger of Owes engine: the additive owed_by
// MIGRATION (a legacy facts table gets the column + backfill), the snooze/flip
// PATCH path, and the chase-card rerun-dedup. Runs the real repo against a
// throwaway SQLite file. Run: npm run test:ledger (also part of npm test).
process.env.MEMBRO_AI = "mock";
process.env.MEMBRO_TZ = "Asia/Singapore";

import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "membro-ledger-"));
process.env.MEMBRO_DATA_DIR = DIR;

// Seed an OLD-schema facts table (no owed_by) + a legacy commitment BEFORE the
// app opens the db, so db()'s migrate() must ALTER the column in and the 'me'
// default must backfill the existing row. This is the real upgrade path on the VM.
{
  const raw = new Database(join(DIR, "membro.db"));
  raw.exec(`
    create table people (id text primary key, name text not null, company text, role text, blurb text, birthday text, next_meeting_at text, last_contact_at text not null, color text not null default 'slate', created_at text not null, updated_at text not null);
    create table facts (id text primary key, person_id text not null, kind text not null default 'fact', content text not null, due_at text, status text not null default 'open', confidence real not null default 1, capture_id text, created_at text not null);
  `);
  const ts = "2026-07-01T00:00:00Z";
  raw.prepare("insert into people (id,name,last_contact_at,created_at,updated_at) values (?,?,?,?,?)").run("legacy-p", "Old Friend", ts, ts, ts);
  raw.prepare("insert into facts (id,person_id,kind,content,due_at,status,created_at) values (?,?,?,?,?,?,?)").run("legacy-f", "legacy-p", "commitment", "the old promise", null, "open", ts);
  raw.close();
}

// Importing repo is lazy; the first call runs SCHEMA (create-if-not-exists skips
// the tables above) + migrate() (adds owed_by + capture_id).
import { getFact, insertPerson, insertFact, listFacts, updateFact, replaceChaseCard, listCards, deletePendingCards } from "@/lib/repo";
import { buildLedger, PersonRow } from "@/lib/nightshift/scout";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TODAY = "2026-07-07";
const ivy = (id: string): PersonRow => ({ id, name: "Ivy", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: "2026-07-01T00:00:00Z" });

async function main() {
  // Migration: the legacy commitment gained owed_by, backfilled to 'me'.
  const legacy = getFact("legacy-f");
  check("migration adds owed_by and backfills a legacy commitment to 'me'", legacy?.owed_by === "me", `got ${legacy?.owed_by}`);

  const { id: pid } = insertPerson({ name: "Ivy" });
  insertFact({ person_id: pid, kind: "commitment", content: "Ivy owes me the budget", due_at: "2026-06-30T09:00:00Z", owed_by: "them" });
  insertFact({ person_id: pid, kind: "commitment", content: "send Ivy the notes", due_at: "2026-07-10T09:00:00Z", owed_by: "me" });

  let ledger = buildLedger([ivy(pid)], listFacts(), TODAY);
  check("a they-owe commitment lands in theyOwe", ledger.theyOwe.some((i) => i.content.includes("budget")));
  check("a you-owe commitment lands in youOwe", ledger.youOwe.some((i) => i.content.includes("send Ivy")));

  const budget = ledger.theyOwe.find((i) => i.content.includes("budget"))!;

  // Snooze = push due_at out (the route computes the date; here we drive updateFact).
  updateFact(budget.factId, { due_at: "2026-07-20T09:00:00Z" });
  check("snooze updates due_at", getFact(budget.factId)?.due_at === "2026-07-20T09:00:00Z");

  // Flip = change direction; the item then moves groups on the next build.
  updateFact(budget.factId, { owed_by: "me" });
  check("flip changes direction me<->them", getFact(budget.factId)?.owed_by === "me");
  ledger = buildLedger([ivy(pid)], listFacts(), TODAY);
  check("a flipped item moves to the other group", ledger.youOwe.some((i) => i.factId === budget.factId) && !ledger.theyOwe.some((i) => i.factId === budget.factId));

  // Chase rerun-dedup: two drafts for the same fact leave exactly one card.
  replaceChaseCard({ person_id: pid, factId: budget.factId, title: "t1", body: "first draft", why: null });
  const id2 = replaceChaseCard({ person_id: pid, factId: budget.factId, title: "t2", body: "second draft", why: null });
  const chaseCards = listCards().filter(
    (c) => (c.meta as { signal?: string }).signal === "chase" && (c.meta as { source_fact_id?: string }).source_fact_id === budget.factId,
  );
  check("chase re-draft replaces, never duplicates", chaseCards.length === 1 && chaseCards[0].id === id2 && chaseCards[0].body === "second draft", `n=${chaseCards.length}`);

  // The night shift clears its own pending drafts, but must SPARE a user's chase.
  deletePendingCards();
  const survived = listCards().filter((c) => (c.meta as { signal?: string }).signal === "chase");
  check("a chase draft survives the night shift's deletePendingCards", survived.length === 1, `n=${survived.length}`);

  console.log("");
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }

  // Same-millisecond orientation. One note routinely files both facts inside a
  // single millisecond, and the tie-break used to compare the two random uuids, so
  // the amber card had a ~50% chance of showing Newer and Older swapped (it made
  // tests/crew.ts fail about half the time). rowid follows insertion order, so the
  // fact filed second is the newer one, every time. 20 rounds: the old code would
  // almost certainly lose at least one.
  {
    const { insertPerson, insertFact, insertConflict, listPendingConflictsForPerson } = await import("@/lib/repo");
    let wrong = 0;
    for (let i = 0; i < 20; i++) {
      const { id: pid } = insertPerson({ name: `Same Ms ${i}` });
      const oldId = insertFact({ person_id: pid, kind: "preference", content: "Loves coffee" });
      const newId = insertFact({ person_id: pid, kind: "preference", content: "Hates coffee now" });
      insertConflict({ personId: pid, newFactId: newId, oldFactId: oldId, reason: "r" });
      const [c] = listPendingConflictsForPerson(pid);
      if (!c || c.newFact.id !== newId || c.oldFact.id !== oldId) wrong++;
    }
    check("same-millisecond facts orient by insertion order, 20/20", wrong === 0, `wrong=${wrong}/20`);
  }

  console.log("All ledger checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
