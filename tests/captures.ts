// Keyless, DB-backed test of the Notes inbox reprocess loop: capture a note, then
// edit-and-reprocess it the way the inbox does, and prove the note is fixed in
// place — its old facts are replaced (never duplicated), the wrong contact a
// mis-heard name created is pruned, the note keeps its identity and source, and a
// plain edit that keeps the same person leaves that person intact. Runs the real
// repo + capture core against a throwaway SQLite file on the mock adapter.
// Run: npm run test:captures (also part of npm test).
process.env.MEMBRO_AI = "mock";
process.env.MEMBRO_FORCE_MOCK = "1";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "membro-captures-"));
process.env.MEMBRO_DATA_DIR = DIR;

import { fileNote } from "@/lib/capture";
import { listPeople, listFacts, getCapture, listCapturesWithFiled } from "@/lib/repo";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // 1. First capture (a voice note that misheard "Joanne" as "John").
  const first = await fileNote(
    { text: "Met John yesterday. John got promoted to lead at Acme.", sourceType: "voice" },
    undefined,
  );
  const captureId = first.captureId;
  check("first capture returns its note id", !!captureId, `id=${captureId}`);
  check("first capture files the (mis-heard) person", first.landed.some((l) => l.person === "John" && l.created), `landed=${JSON.stringify(first.landed)}`);

  let people = listPeople();
  const john = people.find((p) => p.name === "John");
  check("John is on file after the first capture", !!john, `people=${people.map((p) => p.name).join(",")}`);

  let facts = listFacts();
  check("the note's facts carry its capture id (lineage)", facts.length > 0 && facts.every((f) => f.person_id === john!.id), `facts=${facts.length}`);
  const filedFirst = listCapturesWithFiled().find((c) => c.id === captureId);
  check("the inbox shows what the note filed", !!filedFirst && filedFirst.filed.length === facts.length && filedFirst.filed.every((f) => f.personName === "John"), `filed=${JSON.stringify(filedFirst?.filed)}`);

  // 2. Reprocess with the corrected name — the fix-it loop the inbox drives.
  const fixed = await fileNote(
    { text: "Met Joanne yesterday. Joanne got promoted to lead at Acme.", sourceType: "voice" },
    { captureId },
  );
  check("reprocess reuses the same note (no new note)", fixed.captureId === captureId, `got ${fixed.captureId}`);
  check("only one note exists after reprocess (not a duplicate)", listCapturesWithFiled().length === 1, `n=${listCapturesWithFiled().length}`);

  const cap = getCapture(captureId)!;
  check("the note now holds the corrected text", cap.body === "Met Joanne yesterday. Joanne got promoted to lead at Acme.", `body=${cap.body}`);
  check("the note keeps its source (still a voice note)", cap.source_type === "voice", `src=${cap.source_type}`);

  people = listPeople();
  const joanne = people.find((p) => p.name === "Joanne");
  check("the corrected person is now on file", !!joanne, `people=${people.map((p) => p.name).join(",")}`);
  check("the mis-heard person is gone (pruned, not stranded)", !people.some((p) => p.name === "John"), `people=${people.map((p) => p.name).join(",")}`);
  check("reprocess reports the removed contact", (fixed.removedPeople ?? []).includes(john!.id), `removed=${JSON.stringify(fixed.removedPeople)}`);

  facts = listFacts();
  check("every fact now belongs to the corrected person", facts.length > 0 && facts.every((f) => f.person_id === joanne!.id), `facts=${JSON.stringify(facts.map((f) => f.person_id))}`);
  const joanneCount = facts.length;

  // 3. Reprocess again with a plain edit that keeps the SAME person — facts must be
  //    replaced, not stacked, and the person must survive (nothing to prune).
  const edited = await fileNote(
    { text: "Joanne got promoted to lead at Acme. Joanne prefers tea.", sourceType: "voice" },
    { captureId },
  );
  people = listPeople();
  check("keeping the same person does not prune it", people.some((p) => p.name === "Joanne"), `people=${people.map((p) => p.name).join(",")}`);
  check("a same-person edit prunes nobody", (edited.removedPeople ?? []).length === 0, `removed=${JSON.stringify(edited.removedPeople)}`);

  const after = listFacts().filter((f) => f.person_id === joanne!.id);
  check("facts are replaced, never accumulated across edits", after.length > 0 && after.length !== joanneCount + facts.length, `before=${joanneCount} after=${after.length}`);
  check("the newest edit's fact is on file", after.some((f) => /tea/i.test(f.content)), `facts=${after.map((f) => f.content).join(" | ")}`);
  check("total facts equal one person's current set (no orphans left behind)", listFacts().length === after.length, `total=${listFacts().length} joanne=${after.length}`);

  console.log("");
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All captures/reprocess checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
