import type { PersonLite, Signal } from "@/lib/ai/types";
import { isoToLocalDate, ownerTz } from "@/lib/today";

// The Scout is pure, deterministic business logic — no AI. It scans the owner's
// people and facts and surfaces what is "ripe" enough to deserve a finished
// card. The AI Builder only ever sees the signals this produces.

export type PersonRow = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  blurb: string | null;
  birthday: string | null; // YYYY-MM-DD
  next_meeting_at: string | null;
  last_contact_at: string;
};

export type OwedBy = "me" | "them"; // direction of a commitment: I owe them / they owe me

export type FactRow = {
  id: string;
  person_id: string;
  kind: "fact" | "date" | "commitment" | "preference";
  content: string;
  due_at: string | null;
  status: "open" | "done";
  owed_by: OwedBy;
  created_at: string; // when we filed it — the raw signal for contact cadence
};

export const COLD_DAYS = 45;
export const BIRTHDAY_WINDOW = 30;
export const MEETING_WINDOW = 7;
export const DATED_WINDOW = 30; // a one-off dated event this close is an action item

// Warm-Keeper: judge cooling against each person's OWN contact rhythm instead of
// one flat number, so a friend you usually talk to weekly, gone quiet for a
// month, is caught while a yearly contact at 45 days is left alone. Below
// MIN_CONTACT_DAYS distinct contact days we can't read a rhythm and fall back to
// the flat COLD_DAYS backstop. With enough history a person is "cooling" once
// they have been silent for their median gap stretched by COOLING_FACTOR, but
// never before MIN_COOLING_DAYS (so a near-daily contact is not nagged after a
// two-day gap). These are deliberately one-line tunable.
export const MIN_CONTACT_DAYS = 3;
export const COOLING_FACTOR = 2;
export const MIN_COOLING_DAYS = 14;

// The owner's own diary thread lives on a reserved "person" row so it reuses the
// people/facts storage. It is never a relationship: the Scout skips it, and the
// People index hides it (the Diary tab is its surface).
export const SELF_ID = "self";

// Certainty split, used to route what the Scout finds to the right screen.
// "Action" signals are grounded in a date the owner set or something they said
// directly (a meeting, a promise, a birthday) — clear to-dos. "Idea" signals are
// speculative things the owner may or may not act on (a heuristic intro, a nudge
// to reconnect) and live on the opt-in Suggestions screen.
export type ActionSignal = Extract<Signal, { type: "meeting" | "commitment" | "birthday" | "dated" }>;
export type IdeaSignal = Extract<Signal, { type: "connector" | "cold" }>;

export function isActionSignal(s: Signal): s is ActionSignal {
  return s.type === "meeting" || s.type === "commitment" || s.type === "birthday" || s.type === "dated";
}

export function isIdeaSignal(s: Signal): s is IdeaSignal {
  return s.type === "connector" || s.type === "cold";
}

function lite(p: PersonRow): PersonLite {
  return { id: p.id, name: p.name, company: p.company, role: p.role, blurb: p.blurb };
}

// Whole-day distance between two instants, measured in the owner's timezone.
// Reducing each instant to its owner-local calendar date (not a raw UTC
// substring) means an evening event is counted on the day the owner lives it, in
// step with the owner-local "today" the callers pass in. Returns NaN for an
// unparseable date so a malformed due_at is excluded, never mislabeled.
function dayDiff(fromISO: string, toISO: string): number {
  const tz = ownerTz();
  const a = isoToLocalDate(fromISO, tz);
  const b = isoToLocalDate(toISO, tz);
  if (a === null || b === null) return NaN;
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// The distinct owner-local calendar days on which we filed something about a
// person, oldest first. Several facts from one capture share a day, so a day
// counts as one "contact" no matter how many facts it produced — this is what
// keeps a single chatty note from reading as a burst of contact.
function contactDays(factCreatedAt: string[], tz: string): string[] {
  const days = new Set<string>();
  for (const iso of factCreatedAt) {
    const d = isoToLocalDate(iso, tz);
    if (d) days.add(d);
  }
  return [...days].sort();
}

// A person's own "how often do we talk" baseline: the median whole-day gap
// between their consecutive contact days, or null when there is too little
// history (< MIN_CONTACT_DAYS distinct days) to trust a rhythm. The median (not
// the mean) shrugs off one unusually long or short gap. Reused in three places:
// Warm-Keeper cooling detection, the morning nudge, and the Pre-Read rhythm read.
export function contactCadenceDays(factCreatedAt: string[], tz: string = ownerTz()): number | null {
  const days = contactDays(factCreatedAt, tz);
  if (days.length < MIN_CONTACT_DAYS) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    gaps.push(Math.round((Date.parse(days[i] + "T00:00:00Z") - Date.parse(days[i - 1] + "T00:00:00Z")) / 86400000));
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  // Use the lower-middle order statistic, never the AVERAGE of the two middles, so
  // one long lapse can't inflate the rhythm: a weekly friend with gaps [7, 180]
  // reads 7, not ~94 (which would never flag them as cooling). Always a real
  // observed gap, which is what "how often do we usually talk" should mean.
  const median = gaps.length % 2 ? gaps[mid] : gaps[mid - 1];
  return Math.max(1, median);
}

// How many quiet days make a person "cooling": their cadence stretched by
// COOLING_FACTOR (floored at MIN_COOLING_DAYS so a daily contact is not nagged
// after a short gap), or the flat COLD_DAYS backstop when we can't read a rhythm.
export function coolingThreshold(cadence: number | null): number {
  if (cadence === null) return COLD_DAYS;
  return Math.max(MIN_COOLING_DAYS, Math.round(cadence * COOLING_FACTOR));
}

// Days until the next anniversary of a birthday (ignores the stored year).
function daysUntilBirthday(today: string, birthday: string): number {
  const [, mm, dd] = birthday.slice(0, 10).split("-").map(Number);
  const t = new Date(today.slice(0, 10) + "T00:00:00Z");
  const year = t.getUTCFullYear();
  let next = Date.UTC(year, mm - 1, dd);
  const todayMs = Date.UTC(year, t.getUTCMonth(), t.getUTCDate());
  if (next < todayMs) next = Date.UTC(year + 1, mm - 1, dd);
  return Math.round((next - todayMs) / 86400000);
}

// Topic tokens used to spot two people who should be introduced: capitalized
// words of length >= 4 drawn from a person's facts and company, minus their own
// name tokens. Crude but real — "Berlin", "Stripe", "Series B".
const TOPIC_STOP = new Set([
  "got", "moving", "mentioned", "promised", "started", "wants", "spent", "just", "her", "his",
  "they", "next", "this", "that", "with", "from", "into", "before", "after", "really", "very",
]);

function topics(p: PersonRow, facts: FactRow[]): Set<string> {
  const own = new Set(p.name.toLowerCase().split(/\s+/));
  const out = new Set<string>();
  const haystack = [p.company || "", p.blurb || "", ...facts.map((f) => f.content)].join(" ");
  for (const m of haystack.matchAll(/\b([A-Z][A-Za-z]{3,})\b/g)) {
    const tok = m[1];
    const low = tok.toLowerCase();
    if (own.has(low) || TOPIC_STOP.has(low)) continue;
    out.add(tok);
  }
  return out;
}

function meetingLabel(today: string, whenISO: string): string {
  const d = dayDiff(today, whenISO);
  if (Number.isNaN(d)) return "unknown"; // unparseable due_at: never emit "in NaN days"
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

export function scout(people: PersonRow[], facts: FactRow[], today: string, limit = 8): Signal[] {
  people = people.filter((p) => p.id !== SELF_ID); // the diary thread is never a signal
  const factsByPerson = new Map<string, FactRow[]>();
  for (const f of facts) {
    const arr = factsByPerson.get(f.person_id) || [];
    arr.push(f);
    factsByPerson.set(f.person_id, arr);
  }
  const recentFacts = (id: string) => (factsByPerson.get(id) || []).slice(0, 4).map((f) => f.content);

  const signals: { signal: Signal; rank: number }[] = [];
  const peopleWithMeeting = new Set<string>();

  for (const p of people) {
    const pf = factsByPerson.get(p.id) || [];

    // Meetings (most urgent).
    if (p.next_meeting_at && dayDiff(today, p.next_meeting_at) >= 0 && dayDiff(today, p.next_meeting_at) <= MEETING_WINDOW) {
      peopleWithMeeting.add(p.id);
      signals.push({
        signal: { type: "meeting", person: lite(p), whenLabel: meetingLabel(today, p.next_meeting_at), facts: recentFacts(p.id) },
        rank: 0 + dayDiff(today, p.next_meeting_at),
      });
    }

    // Open commitments (both directions; consumers filter by owed_by).
    for (const f of pf) {
      if (f.kind === "commitment" && f.status === "open") {
        const dueLabel = f.due_at ? meetingLabel(today, f.due_at) : null;
        signals.push({
          signal: { type: "commitment", person: lite(p), commitment: f.content, dueLabel, owedBy: f.owed_by, facts: recentFacts(p.id), factId: f.id },
          rank: 10 + (f.due_at ? Math.max(0, dayDiff(today, f.due_at)) : 5),
        });
      }
    }

    // One-off dated events coming up (a deadline, a trip, a recital). These are
    // already extracted with an absolute due_at but were never surfaced before.
    for (const f of pf) {
      if (f.kind === "date" && f.status === "open" && f.due_at) {
        const d = dayDiff(today, f.due_at);
        // Include overdue (d < 0): an open past-due date stays an action item
        // ("overdue") until dismissed, rather than vanishing from both this list
        // and the horizon. Only future-far events (d > window) go to the horizon.
        if (d <= DATED_WINDOW) {
          signals.push({
            signal: {
              type: "dated",
              person: lite(p),
              event: f.content,
              whenLabel: meetingLabel(today, f.due_at),
              daysUntil: d,
              facts: recentFacts(p.id),
              factId: f.id,
            },
            rank: 15 + d,
          });
        }
      }
    }

    // Birthdays in the window.
    if (p.birthday) {
      const d = daysUntilBirthday(today, p.birthday);
      if (d <= BIRTHDAY_WINDOW) {
        signals.push({ signal: { type: "birthday", person: lite(p), daysUntil: d, facts: recentFacts(p.id) }, rank: 20 + d });
      }
    }
  }

  // Connectors: pairs sharing a topic.
  const topicMap = new Map<string, PersonRow[]>();
  const personTopics = new Map<string, Set<string>>();
  for (const p of people) personTopics.set(p.id, topics(p, factsByPerson.get(p.id) || []));
  for (const p of people) {
    for (const t of personTopics.get(p.id)!) {
      const arr = topicMap.get(t) || [];
      arr.push(p);
      topicMap.set(t, arr);
    }
  }
  const seenPair = new Set<string>();
  for (const [topic, group] of topicMap) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const key = [a.id, b.id].sort().join("|");
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        signals.push({
          signal: { type: "connector", personA: lite(a), personB: lite(b), shared: topic, facts: [...recentFacts(a.id), ...recentFacts(b.id)].slice(0, 4) },
          rank: 40,
        });
      }
    }
  }

  // Cooling relationships, judged against each person's OWN cadence (Warm-Keeper).
  // Skip anyone with an upcoming meeting — you are about to see them.
  for (const p of people) {
    if (peopleWithMeeting.has(p.id)) continue;
    const daysSince = dayDiff(p.last_contact_at, today);
    if (Number.isNaN(daysSince)) continue; // unparseable last_contact_at: never flag
    const cadenceDays = contactCadenceDays((factsByPerson.get(p.id) || []).map((f) => f.created_at));
    const threshold = coolingThreshold(cadenceDays);
    if (daysSince >= threshold) {
      // Rank by how far past the person's own threshold they are, so the most
      // overdue-relative-to-their-rhythm surfaces first (a weekly friend quiet a
      // month beats a rare contact just tipping over). Stays in the cold band
      // (below meetings/commitments/dates/birthdays/connectors) so certain items lead.
      const overdue = daysSince / threshold; // >= 1 at flag time
      signals.push({
        signal: { type: "cold", person: lite(p), daysSince, cadenceDays, facts: recentFacts(p.id) },
        rank: 60 + Math.max(0, Math.round(40 - overdue * 8)),
      });
    }
  }

  return signals
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((s) => s.signal);
}

export type HorizonEvent = {
  personId: string;
  personName: string;
  event: string;
  due_at: string;
  daysUntil: number;
};

// Dated events too far out to be an action item yet: a quiet "on the horizon"
// band so nothing you told Membro silently disappears until its day arrives.
// The complement of the `dated` signal, which covers the next DATED_WINDOW days.
export function horizon(people: PersonRow[], facts: FactRow[], today: string, limit = 20): HorizonEvent[] {
  const nameById = new Map(people.filter((p) => p.id !== SELF_ID).map((p) => [p.id, p.name]));
  const out: HorizonEvent[] = [];
  for (const f of facts) {
    if (f.kind !== "date" || f.status !== "open" || !f.due_at) continue;
    const name = nameById.get(f.person_id);
    if (!name) continue; // skip self and orphaned facts
    const d = dayDiff(today, f.due_at);
    if (d > DATED_WINDOW) {
      out.push({ personId: f.person_id, personName: name, event: f.content, due_at: f.due_at, daysUntil: d });
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil).slice(0, limit);
}

// ── Ledger of Owes ────────────────────────────────────────────────────────────
// Every open commitment, both directions, as one scannable balance. Unlike the
// Scout's ranked top-N, this returns ALL open owes (the ledger is a full view,
// not a teaser), split into what the owner owes and what the owner is owed, each
// sorted by urgency: most overdue first, then soonest due, then undated last.
export type OweItem = {
  factId: string;
  personId: string;
  personName: string;
  content: string;
  dueLabel: string | null; // "overdue" | "today" | "tomorrow" | "in N days" | null (reuses meetingLabel)
  daysUntil: number | null; // null = undated or unparseable
  overdue: boolean;
};

export type Ledger = { youOwe: OweItem[]; theyOwe: OweItem[] };

// Undated items sort to the very bottom of a group; a dated item sorts by how
// soon it is due, so a negative (overdue) value leads and the most overdue leads it.
function oweRank(i: OweItem): number {
  return i.daysUntil === null ? Number.MAX_SAFE_INTEGER : i.daysUntil;
}

export function buildLedger(people: PersonRow[], facts: FactRow[], today: string): Ledger {
  const nameById = new Map(people.filter((p) => p.id !== SELF_ID).map((p) => [p.id, p.name]));
  const youOwe: OweItem[] = [];
  const theyOwe: OweItem[] = [];

  for (const f of facts) {
    if (f.kind !== "commitment" || f.status !== "open") continue;
    const name = nameById.get(f.person_id);
    if (!name) continue; // skip the diary self row and orphaned facts

    const d = f.due_at ? dayDiff(today, f.due_at) : NaN;
    const daysUntil = Number.isNaN(d) ? null : d;
    // meetingLabel returns "unknown" for an unparseable date; show no chip rather
    // than a literal "unknown" (only reachable via a hallucinated stored date, as
    // the PATCH route rejects bad due_at values).
    const rawLabel = f.due_at ? meetingLabel(today, f.due_at) : null;
    const dueLabel = rawLabel === "unknown" ? null : rawLabel;
    const item: OweItem = {
      factId: f.id,
      personId: f.person_id,
      personName: name,
      content: f.content,
      dueLabel,
      daysUntil,
      overdue: dueLabel === "overdue",
    };
    (f.owed_by === "them" ? theyOwe : youOwe).push(item);
  }

  const byUrgency = (a: OweItem, b: OweItem) => oweRank(a) - oweRank(b);
  youOwe.sort(byUrgency);
  theyOwe.sort(byUrgency);
  return { youOwe, theyOwe };
}
