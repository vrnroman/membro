// Keyless, DB-backed test of the Pre-Read cache: generation, the instant-render
// cache, the coarse "new since last prep" diff, and staleness on fact changes.
// Runs the real repo + generator against a throwaway SQLite file on the mock, so
// it needs no API key. Run: npm run test:briefs (also part of npm test).
process.env.MEMBRO_AI = "mock"; // force the keyless engine, never `claude -p`
process.env.MEMBRO_TZ = "Asia/Singapore";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A fresh data dir per run so the schema is created clean and nothing leaks in.
// Set before the first db() call (all repo functions are lazy), so it takes hold.
process.env.MEMBRO_DATA_DIR = mkdtempSync(join(tmpdir(), "membro-briefs-"));

import { insertPerson, insertFact, getBrief, listPeopleNeedingBrief } from "@/lib/repo";
import { generateBriefFor, parseBrief } from "@/lib/briefs/generate";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const twoDaysAgo = () => new Date(Date.now() - 2 * 86400000).toISOString();

async function main() {
  const { id } = insertPerson({ name: "Nadia", role: "Design lead", company: "Acme" });

  check("no brief is cached for a new person", getBrief(id) === null);
  check("a brand-new person is due for a brief", listPeopleNeedingBrief(twoDaysAgo(), 10).includes(id));

  // File two facts. Marking-stale is a no-op while there is no brief row yet.
  insertFact({ person_id: id, kind: "fact", content: "Leading the design system rewrite" });
  insertFact({ person_id: id, kind: "commitment", content: "I owe her the Q3 roadmap" });

  // First generation: cache miss -> build and store.
  const first = await generateBriefFor(id);
  check(
    "generateBriefFor returns three structured blocks",
    !!first && typeof first.read === "string" && Array.isArray(first.insights) && Array.isArray(first.recommendations),
  );
  const row1 = getBrief(id);
  check("the brief is cached, fresh, and counts its facts", !!row1 && row1.stale === 0 && row1.source_fact_count === 2, `row=${JSON.stringify(row1)}`);
  check("the cached body parses back to the same read (instant render path)", !!row1 && parseBrief(row1.body)?.read === first!.read);
  check("a freshly briefed person is no longer due", !listPeopleNeedingBrief(twoDaysAgo(), 10).includes(id));
  check("recommendations open on a real fact, not a guess", first!.recommendations.some((r) => /design system|roadmap/i.test(r)), `recs=${first!.recommendations.join(" | ")}`);
  check("first brief has no 'new since last prep' line (nothing was cached before)", !first!.insights.some((i) => /new note/i.test(i)), `insights=${first!.insights.join(" | ")}`);

  // A new fact must flag the brief stale (event-driven freshness).
  await sleep(15); // guarantee the new fact's created_at is after the brief's generated_at
  insertFact({ person_id: id, kind: "fact", content: "Just got back from parental leave" });
  const row2 = getBrief(id);
  check("a new fact flags the brief stale", !!row2 && row2.stale === 1);
  check("a stale brief is due for refresh", listPeopleNeedingBrief(twoDaysAgo(), 10).includes(id));

  // Regeneration: the coarse diff surfaces what changed since the last prep.
  const second = await generateBriefFor(id);
  check("regenerating clears the stale flag", getBrief(id)!.stale === 0);
  check("source_fact_count reflects the added fact", getBrief(id)!.source_fact_count === 3);
  check(
    "the coarse diff surfaces the note added since the last prep",
    second!.insights.some((i) => /new note/i.test(i)),
    `insights=${second!.insights.join(" | ")}`,
  );

  // The diary self row is never briefed.
  check("generateBriefFor returns null for the diary self row", (await generateBriefFor("self")) === null);
  check("generateBriefFor returns null for an unknown person", (await generateBriefFor("nope")) === null);

  console.log("");
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All brief-cache checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
