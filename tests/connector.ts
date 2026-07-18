// The capture-time Connector: after a fact is filed, when it reveals two people who
// should meet, draft the intro right then. This pins the behaviors the manager named
// at the DONE gate: the fire bar (silence on a weak match), one-per-note, dedup in
// BOTH directions with the nightly pass, pair-memory, and surviving the nightly wipe.
process.env.MEMBRO_AI = "mock";
process.env.MEMBRO_TZ = "Asia/Singapore";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MEMBRO_DATA_DIR = mkdtempSync(join(tmpdir(), "membro-connector-"));

import {
  insertPerson,
  insertFact,
  deleteFact,
  insertCards,
  connectorCoversPair,
  deletePendingCards,
  listCards,
  updateCard,
} from "@/lib/repo";
import { enqueueAssistJob, claimDueAssistJobs } from "@/lib/assist/queue";
import { processAssistJob } from "@/lib/assist/process";
import { topicsOf, sharedTopics, pairKey } from "@/lib/nightshift/topics";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const connectorCards = () => listCards().filter((c) => c.status === "pending" && c.kind === "connector");
const meta = (c: { meta: Record<string, unknown> }) => c.meta as { source?: string; pairKey?: string; topic?: string; topics?: string[]; personIds?: string[]; source_fact_id?: string; capture_id?: string };

// Drive the crew on a note that files `content` about `person`, marking those facts
// as the just-filed ones so the Connector treats them as the trigger.
async function fileAndRunCrew(personId: string, content: string) {
  const factId = insertFact({ person_id: personId, kind: "fact", content });
  enqueueAssistJob({
    captureId: `cap-${factId}`,
    note: content,
    firstAttemptAt: new Date(0).toISOString(),
    crewFacts: [{ personId, factIds: [factId] }],
  });
  for (const job of claimDueAssistJobs(10)) await processAssistJob(job);
  return factId;
}

async function main() {
  console.log("\nconnector: the shared topic logic (D1 — same definition both passes use)");
  {
    const a = topicsOf({ name: "Sarah Kim", company: "backs Fintech startups" }, [{ content: "raising a Stripe integration" }]);
    check("topicsOf pulls capitalized tokens", a.has("Stripe") && a.has("Fintech"));
    check("and drops the person's own name", !a.has("sarah") && !a.has("Sarah"));
    const b = topicsOf({ name: "Dev Rao" }, [{ content: "angel who backs Stripe-era Fintech" }]);
    check("sharedTopics finds the overlap", sharedTopics(a, b).sort().join(",") === "Fintech,Stripe");
    check("pairKey is order-independent", pairKey("x", "y") === pairKey("y", "x"));
  }

  console.log("\nconnector: fires on a real two-sided match, drafts the intro");
  {
    // Ana is raising (a need); Ben is an angel who backs (an offer). Shared topic.
    const ana = insertPerson({ name: "Ana", blurb: "founder around Fintech" }).id;
    const ben = insertPerson({ name: "Ben", blurb: "angel who backs Fintech founders, offers intros" }).id;
    // Seed Ben with a fact carrying the shared topic + an "offer" cue for the mock.
    insertFact({ person_id: ben, kind: "fact", content: "Ben backs Fintech founders and offers help" });

    await fileAndRunCrew(ana, "Ana is raising a round, looking for Fintech investors");
    const cards = connectorCards();
    check("one connector card was created", cards.length === 1, `n=${cards.length}`);
    check("it names the intro in the title", !!cards[0] && /Introduce Ana and Ben/.test(cards[0].title), cards[0]?.title);
    check("it carries a drafted intro body", !!cards[0]?.body.trim());
    check("it is tagged source=capture (survives the nightly wipe)", meta(cards[0]).source === "capture");
    check("meta carries the pair + topic for dedup", meta(cards[0]).pairKey === pairKey(ana, ben) && meta(cards[0]).topic === "Fintech");
  }

  console.log("\nconnector: a spared capture card survives deletePendingCards (the nightly wipe)");
  {
    const before = connectorCards().length;
    deletePendingCards(); // what the nightly run does before rebuilding
    check("the capture connector is still there after the wipe", connectorCards().length === before && before > 0);
  }

  console.log("\nconnector: pair-memory — same pair+topic does not fire again");
  {
    const ana = listCards().find((c) => c.kind === "connector")!;
    const [aId, bId] = meta(ana).personIds!;
    check("connectorCoversPair sees the pair for that topic", connectorCoversPair(aId, bId, { topic: "Fintech" }));
    // Skip it (as the owner would), then file another Fintech fact: must not re-offer.
    updateCard(ana.id, { status: "skipped" });
    const beforeN = connectorCards().length;
    await fileAndRunCrew(aId, "Ana still chasing Fintech money");
    check("a skipped pair+topic is not offered again", connectorCards().length === beforeN, `n=${connectorCards().length}`);
    check("...but pair-memory still remembers it across statuses", connectorCoversPair(aId, bId, { topic: "Fintech", statuses: ["skipped"] }));

    // The materially-new-reason rule: pair-memory is keyed on (pair, TOPIC), so a
    // genuinely new shared topic for that same pair must still be allowed to fire.
    // Ben already offers around Robotics; give Ana a Robotics need.
    insertFact({ person_id: bId, kind: "fact", content: "Ben offers Robotics mentoring and backs founders" });
    const beforeNew = connectorCards().length;
    await fileAndRunCrew(aId, "Ana is now looking for a Robotics advisor, still raising");
    check("a genuinely new topic fires for the same pair", connectorCards().length === beforeNew + 1, `n=${connectorCards().length}`);
  }

  console.log("\nconnector: stays SILENT on a weak match (no two-sided reason)");
  {
    // Two people who merely share a word, neither needing nor offering anything.
    const cal = insertPerson({ name: "Cal" }).id;
    const dot = insertPerson({ name: "Dot" }).id;
    insertFact({ person_id: dot, kind: "fact", content: "Dot mentioned Kubernetes once" });
    const beforeN = connectorCards().length;
    await fileAndRunCrew(cal, "Cal also mentioned Kubernetes");
    check("no card for a mere shared word", connectorCards().length === beforeN, `n=${connectorCards().length}`);
  }

  console.log("\nconnector: dedup vs a nightly pending card for the same pair");
  {
    const eve = insertPerson({ name: "Eve" }).id;
    const fox = insertPerson({ name: "Fox" }).id;
    // Pre-seed a PENDING nightly-style connector for Eve+Fox on a topic UNIQUE to
    // them (so nobody else can match and muddy the count).
    insertCards([
      {
        person_id: eve,
        kind: "connector",
        title: "Introduce Eve and Fox?",
        body: "nightly draft",
        why: "both around Speleology",
        meta: { personIds: [eve, fox], pairKey: pairKey(eve, fox), topic: "Speleology", shared: "Speleology" },
      },
    ]);
    insertFact({ person_id: fox, kind: "fact", content: "Fox offers Speleology mentoring and backs founders" });
    const eveFoxBefore = connectorCards().filter((c) => meta(c).pairKey === pairKey(eve, fox)).length;
    await fileAndRunCrew(eve, "Eve is looking for a Speleology advisor, raising soon");
    const eveFoxAfter = connectorCards().filter((c) => meta(c).pairKey === pairKey(eve, fox)).length;
    check("no second card for a pair that already has a pending connector", eveFoxAfter === eveFoxBefore && eveFoxBefore === 1, `before=${eveFoxBefore} after=${eveFoxAfter}`);
  }

  // Review finding #3: a reprocess that no longer yields a match must REMOVE the old
  // card, not strand it. The cleanup used to be gated behind `if (connector)`.
  console.log("\nconnector: reprocessing a note into silence removes the old card");
  {
    const gia = insertPerson({ name: "Gia" }).id;
    const hal = insertPerson({ name: "Hal" }).id;
    insertFact({ person_id: hal, kind: "fact", content: "Hal offers Cryobiology mentoring and backs founders" });
    const capId = "cap-reproc";
    const fid1 = insertFact({ person_id: gia, kind: "fact", content: "Gia is raising, looking for Cryobiology help" });
    enqueueAssistJob({ captureId: capId, note: "Gia is raising, looking for Cryobiology help", firstAttemptAt: new Date(0).toISOString(), crewFacts: [{ personId: gia, factIds: [fid1] }] });
    for (const j of claimDueAssistJobs(10)) await processAssistJob(j);
    const madeOne = connectorCards().some((c) => meta(c).pairKey === pairKey(gia, hal));
    check("a match created a card", madeOne);
    // Reprocess the SAME capture with a note that no longer matches (no topic/need).
    enqueueAssistJob({ captureId: capId, note: "Gia said hello", firstAttemptAt: new Date(0).toISOString(), crewFacts: [{ personId: gia, factIds: [fid1] }] });
    for (const j of claimDueAssistJobs(10)) await processAssistJob(j);
    check("reprocessing into silence removed the stale card", !connectorCards().some((c) => meta(c).capture_id === capId), JSON.stringify(connectorCards().map((c) => meta(c))));
  }

  // Review finding #2: a capture connector is spared the nightly wipe, so deleting
  // its note must clean it up via the fact cascade (meta.source_fact_id).
  console.log("\nconnector: deleting the source fact cleans up the spared card");
  {
    const ivy = insertPerson({ name: "Ivy" }).id;
    const jon = insertPerson({ name: "Jon" }).id;
    insertFact({ person_id: jon, kind: "fact", content: "Jon offers Volcanology advice and backs founders" });
    const fid = await fileAndRunCrew(ivy, "Ivy is raising, looking for Volcanology expertise");
    check("a card exists", connectorCards().some((c) => meta(c).pairKey === pairKey(ivy, jon)));
    check("and it records its source fact", connectorCards().find((c) => meta(c).pairKey === pairKey(ivy, jon))!.meta.source_fact_id === fid);
    deleteFact(fid);
    check("deleting the source fact removes the spared connector (no orphan)", !connectorCards().some((c) => meta(c).pairKey === pairKey(ivy, jon)));
  }

  console.log(failures ? `\n${failures} connector check(s) FAILED\n` : "\nall connector checks passed\n");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
