// Keyless end-to-end test of the Membro pipeline: capture -> scatter -> scout ->
// build cards, all on the deterministic mock. Run with: npm test
import { MockAdapter } from "@/lib/ai/mock";
import { scout, horizon, isActionSignal, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { dueNudges, formatNudge } from "@/lib/nightshift/nudge";
import { isoToLocalDate } from "@/lib/today";

const TODAY = "2026-06-27";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
  const cards = await Promise.all(signals.map((s) => mock.buildCard(s)));
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

  // 6. Assistant classifier: the note starts the right kind of work.
  const task = await mock.assist({ note: "I promised to send Tom the Q3 deck by Thursday.", today: TODAY, people: [{ name: "Tom", facts: [] }] });
  check("task note -> draft", task.kind === "draft" && task.body.trim().length > 0, `got ${task.kind}`);
  const situation = await mock.assist({ note: "My manager seemed annoyed and I am not sure what to say back.", today: TODAY, people: [] });
  check("situation note -> advisory", situation.kind === "advisory" && situation.body.trim().length > 0, `got ${situation.kind}`);
  const diary = await mock.assist({ note: "I felt calm and grateful after a good run.", today: TODAY, people: [] });
  check("first-person note -> diary", diary.kind === "diary", `got ${diary.kind}`);
  const diaryNamed = await mock.assist({ note: "I felt proud after my chat with Tom.", today: TODAY, people: [{ name: "Tom", facts: [] }] });
  check("first-person note naming a person -> still diary", diaryNamed.kind === "diary", `got ${diaryNamed.kind}`);
  const info = await mock.assist({ note: "Priya joined the platform team.", today: TODAY, people: [{ name: "Priya", facts: [] }] });
  check("plain info -> none", info.kind === "none", `got ${info.kind}`);

  // 7. Dated events: a soon date is an Action item, a far one is on the horizon.
  const datedPeople: PersonRow[] = [
    { id: "d1", name: "Nadia", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
  ];
  const datedFacts: FactRow[] = [
    { id: "df1", person_id: "d1", kind: "date", content: "Product launch", due_at: `${addDays(TODAY, 10)}T09:00:00Z`, status: "open" },
    { id: "df2", person_id: "d1", kind: "date", content: "Offsite in Lisbon", due_at: `${addDays(TODAY, 60)}T09:00:00Z`, status: "open" },
  ];
  const datedSignals = scout(datedPeople, datedFacts, TODAY, 50);
  const soon = datedSignals.find((s) => s.type === "dated");
  check("soon dated event is a dated action signal", !!soon && isActionSignal(soon), `types: ${datedSignals.map((s) => s.type).join(",")}`);
  check("far dated event is NOT an action signal", !datedSignals.some((s) => s.type === "dated" && (s as { event: string }).event === "Offsite in Lisbon"));
  const far = horizon(datedPeople, datedFacts, TODAY);
  check("far dated event is on the horizon", far.length === 1 && far[0].event === "Offsite in Lisbon", `horizon: ${far.map((e) => e.event).join(",")}`);

  // Overdue open date facts must not fall through both surfaces.
  const overdueFacts: FactRow[] = [
    { id: "df3", person_id: "d1", kind: "date", content: "Missed launch", due_at: `${addDays(TODAY, -5)}T09:00:00Z`, status: "open" },
  ];
  const overdueSignals = scout(datedPeople, overdueFacts, TODAY, 50);
  const overdue = overdueSignals.find((s) => s.type === "dated");
  check("overdue open date is still a dated action item", !!overdue && (overdue as { whenLabel: string }).whenLabel === "overdue", `types: ${overdueSignals.map((s) => s.type).join(",")}`);
  check("overdue date is not on the horizon", horizon(datedPeople, overdueFacts, TODAY).length === 0);

  // 8. The diary self row never produces a relationship signal.
  const selfPeople: PersonRow[] = [
    { id: "self", name: "You", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: "2020-01-01T00:00:00Z" },
  ];
  const selfFacts: FactRow[] = [{ id: "sf1", person_id: "self", kind: "commitment", content: "meditate", due_at: null, status: "open" }];
  check("self row yields no signals", scout(selfPeople, selfFacts, TODAY).length === 0);

  // 9. Morning nudge: only what's due today or tomorrow, most urgent first,
  //    rendered as one flat message. Overdue / undated / far-out are left out.
  const nudgePeople: PersonRow[] = [
    { id: "n1", name: "Alice", company: null, role: null, blurb: null, birthday: "1990-06-27", next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` }, // birthday today
    { id: "n2", name: "Bob", company: null, role: null, blurb: null, birthday: null, next_meeting_at: `${addDays(TODAY, 1)}T09:00:00Z`, last_contact_at: `${TODAY}T12:00:00Z` }, // meeting tomorrow
    { id: "n3", name: "Cara", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
    { id: "n4", name: "Deb", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
  ];
  const nudgeFacts: FactRow[] = [
    { id: "nf1", person_id: "n3", kind: "commitment", content: "send the deck", due_at: `${TODAY}T09:00:00Z`, status: "open" }, // due today
    { id: "nf2", person_id: "n3", kind: "commitment", content: "call the vendor", due_at: `${addDays(TODAY, -2)}T09:00:00Z`, status: "open" }, // overdue -> excluded
    { id: "nf3", person_id: "n3", kind: "commitment", content: "review the doc", due_at: null, status: "open" }, // undated -> excluded
    { id: "nf4", person_id: "n4", kind: "date", content: "Product launch", due_at: `${addDays(TODAY, 1)}T09:00:00Z`, status: "open" }, // tomorrow
    { id: "nf5", person_id: "n4", kind: "date", content: "Offsite in Lisbon", due_at: `${addDays(TODAY, 40)}T09:00:00Z`, status: "open" }, // far -> excluded
  ];
  const nudges = dueNudges(nudgePeople, nudgeFacts, TODAY);
  check("nudge picks exactly the 4 due-today/tomorrow items", nudges.length === 4, `got ${nudges.length}: ${nudges.map((n) => n.text).join(" | ")}`);
  check("nudge order is today-first then most-urgent type", nudges.map((n) => n.type).join(",") === "commitment,birthday,meeting,dated", `got ${nudges.map((n) => `${n.type}:${n.daysUntil}`).join(",")}`);
  const msg = formatNudge(nudges);
  check("nudge message names the promised person and day", !!msg && msg.includes("You promised Cara: send the deck (due today).") && msg.includes("Alice's birthday today.") && msg.includes("You meet Bob tomorrow.") && msg.includes("Product launch tomorrow."), `msg=${msg}`);
  check("nudge message drops overdue / undated / far items", !!msg && !msg.includes("call the vendor") && !msg.includes("review the doc") && !msg.includes("Lisbon"), `msg=${msg}`);
  check("nudge message is one bullet per line, no wrapper/preamble", !!msg && msg.split("\n").length === nudges.length && msg.split("\n").every((l) => l.startsWith("• ")) && !/^(reminder|nudge|membro|good morning)/i.test(msg), `msg=${JSON.stringify(msg)}`);
  check("nudge message has no em/en dash", !!msg && !/[—–]/.test(msg), `msg=${msg}`);
  check("nothing due + silent -> no message", formatNudge(dueNudges([], [], TODAY)) === null);
  check("nothing due + notifyWhenEmpty -> all-clear line", formatNudge(dueNudges([], [], TODAY), { notifyWhenEmpty: true }) === "Nothing due today or tomorrow.");

  // 10. Nudge hardening: timezone boundary, unparseable dates, length cap, and
  //     content sanitizing. (Owner TZ defaults to Asia/Singapore, UTC+8.)
  const tzPeople: PersonRow[] = [
    { id: "t1", name: "Evening", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
  ];
  // 20:00 UTC on TODAY is 04:00 the NEXT day in Singapore -> genuinely tomorrow.
  const tzFacts: FactRow[] = [
    { id: "tf1", person_id: "t1", kind: "date", content: "Evening deadline", due_at: `${TODAY}T20:00:00Z`, status: "open" },
  ];
  const tzNudges = dueNudges(tzPeople, tzFacts, TODAY);
  check("late-UTC event is bucketed on the owner's day (tomorrow, not today)", tzNudges.length === 1 && tzNudges[0].daysUntil === 1 && tzNudges[0].text === "Evening deadline tomorrow.", `got ${JSON.stringify(tzNudges)}`);

  // Unparseable / malformed due dates must be excluded, never crash or mislabel.
  const badFacts: FactRow[] = [
    { id: "bf1", person_id: "t1", kind: "date", content: "Broken date", due_at: "not-a-date", status: "open" },
    { id: "bf2", person_id: "t1", kind: "commitment", content: "unresolved", due_at: "next Thursday", status: "open" },
  ];
  let threw = false;
  let badNudges: ReturnType<typeof dueNudges> = [];
  try {
    badNudges = dueNudges(tzPeople, badFacts, TODAY);
  } catch {
    threw = true;
  }
  check("malformed due dates are excluded, not a crash", !threw && badNudges.length === 0, `threw=${threw} got ${JSON.stringify(badNudges)}`);

  // A fact typed across multiple lines stays one bullet on one line.
  const nlFacts: FactRow[] = [
    { id: "nl1", person_id: "t1", kind: "commitment", content: "send the deck\nand the signed contract", due_at: `${TODAY}T02:00:00Z`, status: "open" },
  ];
  const nlMsg = formatNudge(dueNudges(tzPeople, nlFacts, TODAY));
  check("a newline in a fact does not break the one-bullet-per-line layout", !!nlMsg && nlMsg.split("\n").length === 1 && nlMsg.startsWith("• ") && nlMsg.includes("send the deck and the signed contract"), `msg=${JSON.stringify(nlMsg)}`);

  // Content ending in punctuation must not double the terminal period.
  const punctFacts: FactRow[] = [
    { id: "pf1", person_id: "t1", kind: "date", content: "Product launch.", due_at: `${TODAY}T02:00:00Z`, status: "open" },
  ];
  const punctMsg = formatNudge(dueNudges(tzPeople, punctFacts, TODAY));
  check("trailing punctuation is not doubled", punctMsg === "• Product launch today.", `msg=${JSON.stringify(punctMsg)}`);

  // Many due items must stay under Telegram's 4096-char limit with a "+N more".
  const many = Array.from({ length: 300 }, (_, i) => ({ type: "birthday" as const, daysUntil: 0 as const, text: `Person Number ${i} has a birthday today.` }));
  const capped = formatNudge(many)!;
  check("a huge nudge is capped under Telegram's 4096 limit", capped.length <= 4096, `len=${capped.length}`);
  check("a capped nudge summarizes the remainder as (+N more)", /\(\+\d+ more\)$/.test(capped), `tail=${JSON.stringify(capped.slice(-40))}`);
  // A single oversized first bullet, plus more items, must still cap under 4096.
  const bigFirst = formatNudge([
    { type: "commitment" as const, daysUntil: 0 as const, text: "x".repeat(4090) },
    { type: "birthday" as const, daysUntil: 0 as const, text: "Alice's birthday today." },
    { type: "birthday" as const, daysUntil: 0 as const, text: "Bob's birthday today." },
  ])!;
  check("an oversized first bullet is still capped under 4096", bigFirst.length <= 4096, `len=${bigFirst.length}`);

  // isoToLocalDate: a bare owner-local date must not be shifted through UTC (a
  // west-of-UTC MEMBRO_TZ would otherwise roll it back a day).
  check("bare owner-local date is not shifted by timezone", isoToLocalDate("2026-07-04", "America/New_York") === "2026-07-04" && isoToLocalDate("2026-07-04", "Asia/Singapore") === "2026-07-04", `NY=${isoToLocalDate("2026-07-04", "America/New_York")}`);
  // A real instant IS reduced in the given zone.
  check("an evening-UTC instant reduces to the owner's next day", isoToLocalDate("2026-07-04T20:00:00Z", "Asia/Singapore") === "2026-07-05", `got ${isoToLocalDate("2026-07-04T20:00:00Z", "Asia/Singapore")}`);

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
