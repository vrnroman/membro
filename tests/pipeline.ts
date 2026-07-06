// Keyless end-to-end test of the Membro pipeline: capture -> scatter -> scout ->
// build cards, all on the deterministic mock. Run with: npm test
import { MockAdapter } from "@/lib/ai/mock";
import {
  scout,
  horizon,
  isActionSignal,
  contactCadenceDays,
  coolingThreshold,
  buildLedger,
  COLD_DAYS,
  MIN_COOLING_DAYS,
  PersonRow,
  FactRow,
} from "@/lib/nightshift/scout";
import { dueNudges, formatNudge, topWarmKeep, computeNudge } from "@/lib/nightshift/nudge";
import type { Signal } from "@/lib/ai/types";
import { isoToLocalDate } from "@/lib/today";

const TODAY = "2026-06-27";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A plain fact filed `daysAgo` before TODAY — the raw material for contact cadence.
function factDaysAgo(pid: string, j: number, daysAgo: number): FactRow {
  return { id: `${pid}-c${j}`, person_id: pid, kind: "fact", content: "chatted", due_at: null, status: "open", owed_by: "me", created_at: `${addDays(TODAY, -daysAgo)}T12:00:00Z` };
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
    e.facts.map((f, j) => ({ id: `p${i}-f${j}`, person_id: `p${i}`, kind: f.kind, content: f.content, due_at: f.due_at ?? null, status: "open" as const, owed_by: f.owed_by ?? ("me" as const), created_at: `${TODAY}T12:00:00Z` })),
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

  // 5. Pre-Read: the brief is now three structured blocks, not a string.
  const brief = await mock.brief({
    person: { id: "p0", name: "Maya", company: null, role: null, blurb: null },
    facts: ["Got promoted to product lead", "I owe her the onboarding doc"],
    newFacts: [],
    cadenceDays: null,
    today: TODAY,
  });
  check("brief read is non-empty", brief.read.trim().length > 0);
  check("brief has recommendations", brief.recommendations.length > 0 && brief.recommendations.every((r) => r.trim().length > 0));
  check("brief opens with a real fact (grounded, not generic)", brief.recommendations.some((r) => /product lead/i.test(r)), `recs=${brief.recommendations.join(" | ")}`);
  check("brief spots the open thread it owes", brief.insights.concat(brief.recommendations).some((s) => /onboarding doc/i.test(s)), `insights=${brief.insights.join(" | ")}`);
  check("brief has no em/en dash", !/[—–]/.test([brief.read, ...brief.insights, ...brief.recommendations].join(" ")));

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
    { id: "df1", person_id: "d1", kind: "date", content: "Product launch", due_at: `${addDays(TODAY, 10)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
    { id: "df2", person_id: "d1", kind: "date", content: "Offsite in Lisbon", due_at: `${addDays(TODAY, 60)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
  ];
  const datedSignals = scout(datedPeople, datedFacts, TODAY, 50);
  const soon = datedSignals.find((s) => s.type === "dated");
  check("soon dated event is a dated action signal", !!soon && isActionSignal(soon), `types: ${datedSignals.map((s) => s.type).join(",")}`);
  check("far dated event is NOT an action signal", !datedSignals.some((s) => s.type === "dated" && (s as { event: string }).event === "Offsite in Lisbon"));
  const far = horizon(datedPeople, datedFacts, TODAY);
  check("far dated event is on the horizon", far.length === 1 && far[0].event === "Offsite in Lisbon", `horizon: ${far.map((e) => e.event).join(",")}`);

  // Overdue open date facts must not fall through both surfaces.
  const overdueFacts: FactRow[] = [
    { id: "df3", person_id: "d1", kind: "date", content: "Missed launch", due_at: `${addDays(TODAY, -5)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
  ];
  const overdueSignals = scout(datedPeople, overdueFacts, TODAY, 50);
  const overdue = overdueSignals.find((s) => s.type === "dated");
  check("overdue open date is still a dated action item", !!overdue && (overdue as { whenLabel: string }).whenLabel === "overdue", `types: ${overdueSignals.map((s) => s.type).join(",")}`);
  check("overdue date is not on the horizon", horizon(datedPeople, overdueFacts, TODAY).length === 0);

  // 8. The diary self row never produces a relationship signal.
  const selfPeople: PersonRow[] = [
    { id: "self", name: "You", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: "2020-01-01T00:00:00Z" },
  ];
  const selfFacts: FactRow[] = [{ id: "sf1", person_id: "self", kind: "commitment", content: "meditate", due_at: null, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }];
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
    { id: "nf1", person_id: "n3", kind: "commitment", content: "send the deck", due_at: `${TODAY}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // due today
    { id: "nf2", person_id: "n3", kind: "commitment", content: "call the vendor", due_at: `${addDays(TODAY, -2)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // overdue -> excluded
    { id: "nf3", person_id: "n3", kind: "commitment", content: "review the doc", due_at: null, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // undated -> excluded
    { id: "nf4", person_id: "n4", kind: "date", content: "Product launch", due_at: `${addDays(TODAY, 1)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // tomorrow
    { id: "nf5", person_id: "n4", kind: "date", content: "Offsite in Lisbon", due_at: `${addDays(TODAY, 40)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // far -> excluded
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
    { id: "tf1", person_id: "t1", kind: "date", content: "Evening deadline", due_at: `${TODAY}T20:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
  ];
  const tzNudges = dueNudges(tzPeople, tzFacts, TODAY);
  check("late-UTC event is bucketed on the owner's day (tomorrow, not today)", tzNudges.length === 1 && tzNudges[0].daysUntil === 1 && tzNudges[0].text === "Evening deadline tomorrow.", `got ${JSON.stringify(tzNudges)}`);

  // Unparseable / malformed due dates must be excluded, never crash or mislabel.
  const badFacts: FactRow[] = [
    { id: "bf1", person_id: "t1", kind: "date", content: "Broken date", due_at: "not-a-date", status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
    { id: "bf2", person_id: "t1", kind: "commitment", content: "unresolved", due_at: "next Thursday", status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
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
    { id: "nl1", person_id: "t1", kind: "commitment", content: "send the deck\nand the signed contract", due_at: `${TODAY}T02:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
  ];
  const nlMsg = formatNudge(dueNudges(tzPeople, nlFacts, TODAY));
  check("a newline in a fact does not break the one-bullet-per-line layout", !!nlMsg && nlMsg.split("\n").length === 1 && nlMsg.startsWith("• ") && nlMsg.includes("send the deck and the signed contract"), `msg=${JSON.stringify(nlMsg)}`);

  // Content ending in punctuation must not double the terminal period.
  const punctFacts: FactRow[] = [
    { id: "pf1", person_id: "t1", kind: "date", content: "Product launch.", due_at: `${TODAY}T02:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
  ];
  const punctMsg = formatNudge(dueNudges(tzPeople, punctFacts, TODAY));
  check("trailing punctuation is not doubled", punctMsg === "• Product launch today.", `msg=${JSON.stringify(punctMsg)}`);

  // Many due items must stay under Telegram's 4096-char limit with a "+N more".
  const many = Array.from({ length: 300 }, (_, i) => ({ type: "birthday" as const, daysUntil: 0 as const, text: `Person Number ${i} has a birthday today.`, personId: `pm${i}` }));
  const capped = formatNudge(many)!;
  check("a huge nudge is capped under Telegram's 4096 limit", capped.length <= 4096, `len=${capped.length}`);
  check("a capped nudge summarizes the remainder as (+N more)", /\(\+\d+ more\)$/.test(capped), `tail=${JSON.stringify(capped.slice(-40))}`);
  // A single oversized first bullet, plus more items, must still cap under 4096.
  const bigFirst = formatNudge([
    { type: "commitment" as const, daysUntil: 0 as const, text: "x".repeat(4090), personId: "bx1" },
    { type: "birthday" as const, daysUntil: 0 as const, text: "Alice's birthday today.", personId: "bx2" },
    { type: "birthday" as const, daysUntil: 0 as const, text: "Bob's birthday today.", personId: "bx3" },
  ])!;
  check("an oversized first bullet is still capped under 4096", bigFirst.length <= 4096, `len=${bigFirst.length}`);
  // The warm-keep line stays inside the cap even on a maxed-out day (budgeted, not sliced).
  const bigWarm = formatNudge(many, { warmKeep: "Worth a hello: Somebody With A Fairly Long Name (quiet for 42 days)." })!;
  check("a warm-keep on a huge day is not truncated mid-teaser", bigWarm.length <= 4096 && bigWarm.trim().endsWith("days)."), `len=${bigWarm.length} tail=${JSON.stringify(bigWarm.slice(-30))}`);

  // isoToLocalDate: a bare owner-local date must not be shifted through UTC (a
  // west-of-UTC MEMBRO_TZ would otherwise roll it back a day).
  check("bare owner-local date is not shifted by timezone", isoToLocalDate("2026-07-04", "America/New_York") === "2026-07-04" && isoToLocalDate("2026-07-04", "Asia/Singapore") === "2026-07-04", `NY=${isoToLocalDate("2026-07-04", "America/New_York")}`);
  // A real instant IS reduced in the given zone.
  check("an evening-UTC instant reduces to the owner's next day", isoToLocalDate("2026-07-04T20:00:00Z", "Asia/Singapore") === "2026-07-05", `got ${isoToLocalDate("2026-07-04T20:00:00Z", "Asia/Singapore")}`);

  // 11. Warm-Keeper: cooling judged against each person's OWN cadence, not one
  //     flat number, plus the single-line morning teaser.
  const weekly = [35, 28, 21].map((d) => `${addDays(TODAY, -d)}T12:00:00Z`);
  check("cadence of a steady weekly contact reads ~7 days", contactCadenceDays(weekly) === 7, `got ${contactCadenceDays(weekly)}`);
  check("cadence is null with too little history (< 3 contact days)", contactCadenceDays([`${addDays(TODAY, -10)}T12:00:00Z`]) === null);
  check(
    "several facts on one day count as one contact, not a burst",
    contactCadenceDays([`${TODAY}T09:00:00Z`, `${TODAY}T10:00:00Z`, `${TODAY}T11:00:00Z`]) === null,
    "one calendar day is one contact",
  );
  check(
    "cadence uses a real observed gap, not an average, so one long lapse can't inflate it ([7,180] -> 7)",
    contactCadenceDays([`${addDays(TODAY, -187)}T12:00:00Z`, `${addDays(TODAY, -180)}T12:00:00Z`, `${TODAY}T12:00:00Z`]) === 7,
    `got ${contactCadenceDays([`${addDays(TODAY, -187)}T12:00:00Z`, `${addDays(TODAY, -180)}T12:00:00Z`, `${TODAY}T12:00:00Z`])}`,
  );
  check("cooling threshold floors a frequent contact at MIN_COOLING_DAYS", coolingThreshold(2) === MIN_COOLING_DAYS);
  check("cooling threshold stretches a slow cadence by the factor", coolingThreshold(30) === 60);
  check("cooling threshold falls back to the flat COLD_DAYS with no rhythm", coolingThreshold(null) === COLD_DAYS);

  const wkPeople: PersonRow[] = [
    { id: "wk1", name: "Wren", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -21)}T12:00:00Z` }, // weekly, quiet 21d
    { id: "wk2", name: "Zed", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -40)}T12:00:00Z` }, // weekly, quiet 40d (more overdue)
    { id: "wk3", name: "Vale", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -21)}T12:00:00Z` }, // thin history, quiet 21d
    { id: "wk4", name: "Rio", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -5)}T12:00:00Z` }, // near-daily, quiet 5d
  ];
  const wkFacts: FactRow[] = [
    ...[35, 28, 21].map((d, j) => factDaysAgo("wk1", j, d)), // Wren: ~7d rhythm
    ...[54, 47, 40].map((d, j) => factDaysAgo("wk2", j, d)), // Zed: ~7d rhythm, last spoke 40d ago
    factDaysAgo("wk3", 0, 21), // Vale: one contact only
    ...[9, 7, 5].map((d, j) => factDaysAgo("wk4", j, d)), // Rio: ~2d rhythm
  ];
  const wkColds = scout(wkPeople, wkFacts, TODAY, 50)
    .filter((s) => s.type === "cold")
    .map((s) => (s as { person: { name: string } }).person.name);
  check("cadence-aware: a weekly friend quiet 21 days IS cooling (a flat 45 would miss them)", wkColds.includes("Wren"), `colds=${wkColds.join(",")}`);
  check("thin history falls back to the flat 45-day backstop (Vale not cold at 21 days)", !wkColds.includes("Vale"), `colds=${wkColds.join(",")}`);
  check("the floor protects a frequent contact quiet only 5 days (Rio not cold)", !wkColds.includes("Rio"), `colds=${wkColds.join(",")}`);

  const teaser = topWarmKeep(wkPeople, wkFacts, TODAY);
  check("warm-keep picks the most overdue-vs-cadence (Zed at 40d over Wren at 21d)", !!teaser && teaser.includes("Zed") && !teaser.includes("Wren"), `teaser=${teaser}`);
  check("warm-keep teaser is specific about the rhythm and the gap", !!teaser && /every 7 days/.test(teaser) && /quiet for 40/.test(teaser), `teaser=${teaser}`);
  check(
    "warm-keep teaser is warm: no status label, no dash, no guilt",
    !!teaser && teaser.startsWith("Worth a hello:") && !/[—–]/.test(teaser) && !/cooling|at risk|overdue/i.test(teaser),
    `teaser=${teaser}`,
  );
  check("no cooling relationships -> no warm-keep", topWarmKeep(nudgePeople, nudgeFacts, TODAY) === null);

  // The warm-keep rides the morning nudge as ONE trailing line (capped, no guilt list).
  const withWarm = formatNudge(dueNudges(nudgePeople, nudgeFacts, TODAY), { warmKeep: teaser });
  check(
    "nudge appends the single warm-keep after the due items",
    !!withWarm && withWarm.includes(teaser!) && (withWarm.match(/Worth a hello:/g) || []).length === 1,
    `msg=${withWarm}`,
  );
  // On a quiet day the warm-keep is sent alone WHEN empty-day nudges are on (the
  // default), and honors the opt-out when the owner silenced empty days.
  check("a quiet day sends the warm-keep alone when empty nudges are on", formatNudge([], { warmKeep: teaser, notifyWhenEmpty: true }) === teaser);
  check("empty-day opt-out silences even a warm-keep", formatNudge([], { warmKeep: teaser, notifyWhenEmpty: false }) === null);
  check("nothing cooling and silent-empty sends nothing", formatNudge([], { warmKeep: null, notifyWhenEmpty: false }) === null);

  // Dedup: a person who is BOTH due and cooling is named once (in the due items),
  // and the warm-keep falls through to the next-best cooling person.
  const dupPeople: PersonRow[] = [
    { id: "dp1", name: "Dawn", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -40)}T12:00:00Z` }, // cooling (most overdue) AND owes a report today
    { id: "dp2", name: "Fox", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${addDays(TODAY, -25)}T12:00:00Z` }, // cooling only, less overdue
  ];
  const dupFacts: FactRow[] = [
    ...[54, 47, 40].map((d, j) => factDaysAgo("dp1", j, d)),
    { id: "dp1-owe", person_id: "dp1", kind: "commitment", content: "send the report", due_at: `${TODAY}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${addDays(TODAY, -40)}T12:00:00Z` },
    ...[39, 32, 25].map((d, j) => factDaysAgo("dp2", j, d)),
  ];
  check("without dedup, the most-overdue cooling person (Dawn) is the warm-keep", (topWarmKeep(dupPeople, dupFacts, TODAY) ?? "").includes("Dawn"));
  const cn = computeNudge(dupPeople, dupFacts, TODAY);
  check(
    "computeNudge does not double-name: Dawn is a due item, so the warm-keep is Fox",
    cn.items.some((i) => i.personId === "dp1") && !!cn.warmKeep && cn.warmKeep.includes("Fox") && !cn.warmKeep.includes("Dawn"),
    `items=${cn.items.map((i) => i.text).join(" | ")} warm=${cn.warmKeep}`,
  );

  // 12. Ledger of Owes: direction extraction, both-sided ledger, the you-owe
  //     filter on Today/nudge, and the friendly chase draft.
  const owes = await mock.extract({
    text: "Tom will send me the contract next week. I promised to send Priya the deck.",
    today: TODAY,
    existingNames: [],
  });
  const oweTom = owes.entities.find((e) => e.name === "Tom");
  const owePriya = owes.entities.find((e) => e.name === "Priya");
  check("a 'they will send me' promise is a commitment owed_by them", !!oweTom?.facts.some((f) => f.kind === "commitment" && f.owed_by === "them"), `tom=${JSON.stringify(oweTom?.facts)}`);
  check("an 'I promised to send' is a commitment owed_by me", !!owePriya?.facts.some((f) => f.kind === "commitment" && f.owed_by === "me"), `priya=${JSON.stringify(owePriya?.facts)}`);

  const owePeople: PersonRow[] = [
    { id: "o1", name: "Ana", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
    { id: "o2", name: "Ben", company: null, role: null, blurb: null, birthday: null, next_meeting_at: null, last_contact_at: `${TODAY}T12:00:00Z` },
  ];
  const oweFacts: FactRow[] = [
    { id: "of1", person_id: "o1", kind: "commitment", content: "send Ana the deck", due_at: `${addDays(TODAY, -3)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // you owe, overdue
    { id: "of2", person_id: "o1", kind: "commitment", content: "reply to Ana", due_at: `${addDays(TODAY, 2)}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // you owe, soon
    { id: "of3", person_id: "o2", kind: "commitment", content: "the quarter numbers", due_at: `${addDays(TODAY, -1)}T09:00:00Z`, status: "open", owed_by: "them", created_at: `${TODAY}T12:00:00Z` }, // they owe, overdue
    { id: "of4", person_id: "o2", kind: "commitment", content: "a callback", due_at: null, status: "open", owed_by: "them", created_at: `${TODAY}T12:00:00Z` }, // they owe, undated
    { id: "of5", person_id: "o1", kind: "commitment", content: "old thing", due_at: null, status: "done", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }, // done -> excluded
  ];
  const ledger = buildLedger(owePeople, oweFacts, TODAY);
  check("ledger splits by direction", ledger.youOwe.length === 2 && ledger.theyOwe.length === 2, `you=${ledger.youOwe.length} they=${ledger.theyOwe.length}`);
  check("ledger excludes done commitments", ![...ledger.youOwe, ...ledger.theyOwe].some((i) => i.factId === "of5"));
  check("you-owe is sorted most-overdue first", ledger.youOwe[0].factId === "of1" && ledger.youOwe[0].overdue === true, `order=${ledger.youOwe.map((i) => i.factId).join(",")}`);
  check("an undated owe sorts to the bottom of its group", ledger.theyOwe[ledger.theyOwe.length - 1].factId === "of4" && ledger.theyOwe[ledger.theyOwe.length - 1].dueLabel === null);
  check("overdue flag matches the label", ledger.theyOwe.find((i) => i.factId === "of3")?.overdue === true && ledger.theyOwe.find((i) => i.factId === "of3")?.dueLabel === "overdue");
  const malformedLedger = buildLedger(owePeople, [{ id: "mf1", person_id: "o1", kind: "commitment", content: "broken date owe", due_at: "not-a-date", status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` }], TODAY);
  check("an unparseable due_at shows no chip (not a literal 'unknown')", malformedLedger.youOwe.length === 1 && malformedLedger.youOwe[0].dueLabel === null && malformedLedger.youOwe[0].daysUntil === null, `got ${JSON.stringify(malformedLedger.youOwe[0])}`);

  // Today + nudge stay one-directional: a they-owe is never a to-do or a nudge.
  const oweSignals = scout(owePeople, oweFacts, TODAY, 50).filter((s) => s.type === "commitment");
  check("the commitment signal carries the direction", oweSignals.some((s) => s.type === "commitment" && s.owedBy === "them") && oweSignals.some((s) => s.type === "commitment" && s.owedBy === "me"));
  const dueTodayFacts: FactRow[] = [
    { id: "dt1", person_id: "o1", kind: "commitment", content: "send Ana the file", due_at: `${TODAY}T09:00:00Z`, status: "open", owed_by: "me", created_at: `${TODAY}T12:00:00Z` },
    { id: "dt2", person_id: "o2", kind: "commitment", content: "the sign off", due_at: `${TODAY}T09:00:00Z`, status: "open", owed_by: "them", created_at: `${TODAY}T12:00:00Z` },
  ];
  const dueMsg = dueNudges(owePeople, dueTodayFacts, TODAY);
  check("nudge includes the you-owe due today", dueMsg.some((i) => i.text.includes("send Ana the file")));
  check("nudge excludes a they-owe (never 'You promised' for what is owed to you)", !dueMsg.some((i) => i.text.includes("sign off")), `msg=${dueMsg.map((i) => i.text).join(" | ")}`);

  // The chase: a warm, anchored reminder that never sounds like chasing.
  const chaseSignal: Signal = { type: "chase", person: { id: "c1", name: "Dana", company: null, role: null, blurb: null }, item: "the signed contract", dueLabel: null, facts: [], factId: "cf1" };
  const chaseCard = await mock.buildCard(chaseSignal);
  check("chase drafts a nudge anchored to the real item", chaseCard.kind === "nudge" && /signed contract/i.test(chaseCard.body));
  check("chase copy never uses pressure or timing words", !/\b(overdue|late|still waiting|reminder|asap|urgent|owe|behind)\b/i.test(chaseCard.body), `body=${chaseCard.body}`);
  check("chase copy has no em/en dash", !/[—–]/.test(chaseCard.body + " " + chaseCard.title), `text=${chaseCard.title} | ${chaseCard.body}`);

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
