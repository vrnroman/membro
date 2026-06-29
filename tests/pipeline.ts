// Keyless end-to-end test of the Membro pipeline: capture -> scatter -> scout ->
// build cards, all on the deterministic mock. Run with: npm test
import { MockAdapter } from "@/lib/ai/mock";
import { scout, PersonRow, FactRow } from "@/lib/nightshift/scout";

const TODAY = "2026-06-27";

const DEMO =
  "Just got out of the team sync. Maya got promoted to product lead, and she spent two years in our Berlin office before this. Her son Leo just started kindergarten. Tom mentioned his birthday is next week, and I promised to send him the Q3 deck before Thursday. Priya is moving to the Berlin office next month and wants to connect with anyone who has worked there.";

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
  const mock = new MockAdapter();

  // 1. Scatter: one note -> several people.
  const { entities } = await mock.extract({ text: DEMO, today: TODAY, existingNames: [] });
  const names = entities.map((e) => e.name);
  check("Maya extracted", names.includes("Maya"));
  check("Tom extracted", names.includes("Tom"));
  check("Priya extracted", names.includes("Priya"));
  check("Berlin is NOT a person", !names.includes("Berlin"), `got: ${names.join(", ")}`);

  const tom = entities.find((e) => e.name === "Tom");
  check("Tom has a commitment", !!tom?.facts.some((f) => f.kind === "commitment"));
  check("Tom has a birthday", !!tom?.birthday, `birthday=${tom?.birthday}`);

  // 2. Simulate the capture write into rows (mirrors the route).
  const people: PersonRow[] = entities.map((e, i) => ({
    id: `p${i}`,
    name: e.name,
    company: e.company ?? null,
    role: e.role ?? null,
    blurb: e.blurb ?? null,
    birthday: e.birthday ? `${TODAY.slice(0, 4)}-${e.birthday.length === 5 ? e.birthday : e.birthday.slice(5)}` : null,
    next_meeting_at: null,
    last_contact_at: `${TODAY}T12:00:00Z`,
  }));
  const facts: FactRow[] = entities.flatMap((e, i) =>
    e.facts.map((f, j) => ({ id: `p${i}-f${j}`, person_id: `p${i}`, kind: f.kind, content: f.content, due_at: f.due_at ?? null, status: "open" as const })),
  );

  // 3. Scout finds what's ripe.
  const signals = scout(people, facts, TODAY);
  const types = signals.map((s) => s.type);
  check("found a connector signal", types.includes("connector"));
  check("found a commitment signal", types.includes("commitment"));
  check("found a birthday signal", types.includes("birthday"));

  const connector = signals.find((s) => s.type === "connector");
  if (connector && connector.type === "connector") {
    const pair = [connector.personA.name, connector.personB.name].sort().join("+");
    check("connector links Maya and Priya via Berlin", pair === "Maya+Priya" && connector.shared.toLowerCase().includes("berlin"), `pair=${pair} shared=${connector.shared}`);
  }

  // 4. Builder turns each signal into a finished card.
  const cards = await Promise.all(signals.map((s) => mock.buildCard(s, TODAY)));
  check("every card has a non-empty body", cards.every((c) => c.body.trim().length > 0));
  check("every card has a why", cards.every((c) => c.why.trim().length > 0));
  check("a connector card was built", cards.some((c) => c.kind === "connector"));

  // 4b. Hardening: weak/descriptor mentions and verb-starts don't become people.
  const noise = await mock.extract({
    text: "Berlin is cold today. Caught up with Maya, who got promoted.",
    today: TODAY,
    existingNames: [],
  });
  const noiseNames = noise.entities.map((e) => e.name);
  check('"Caught" is not treated as a person', !noiseNames.includes("Caught"), `got: ${noiseNames.join(", ")}`);
  const berlin = noise.entities.find((e) => e.name === "Berlin");
  check('"Berlin is cold" would be quarantined (low confidence)', !berlin || berlin.confidence < 0.7, `berlin conf=${berlin?.confidence}`);
  const noiseMaya = noise.entities.find((e) => e.name === "Maya");
  check('real person "Maya who got promoted" stays high-confidence', !!noiseMaya && noiseMaya.confidence >= 0.7, `maya conf=${noiseMaya?.confidence}`);

  // 5. Brief generation.
  const brief = await mock.brief({ id: "p0", name: "Maya", company: null, role: null, blurb: null }, ["Got promoted to product lead"]);
  check("brief is non-empty", brief.trim().length > 0);

  console.log("");
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All pipeline checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
