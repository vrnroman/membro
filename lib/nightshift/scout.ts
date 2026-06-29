import type { PersonLite, Signal } from "@/lib/ai/types";

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

export type FactRow = {
  id: string;
  person_id: string;
  kind: "fact" | "date" | "commitment" | "preference";
  content: string;
  due_at: string | null;
  status: "open" | "done";
};

export const COLD_DAYS = 45;
export const BIRTHDAY_WINDOW = 30;
export const MEETING_WINDOW = 7;

function lite(p: PersonRow): PersonLite {
  return { id: p.id, name: p.name, company: p.company, role: p.role, blurb: p.blurb };
}

function dayDiff(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toISO.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
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
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

export function scout(people: PersonRow[], facts: FactRow[], today: string, limit = 8): Signal[] {
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

    // Open commitments.
    for (const f of pf) {
      if (f.kind === "commitment" && f.status === "open") {
        const dueLabel = f.due_at ? meetingLabel(today, f.due_at) : null;
        signals.push({
          signal: { type: "commitment", person: lite(p), commitment: f.content, dueLabel, facts: recentFacts(p.id), factId: f.id },
          rank: 10 + (f.due_at ? Math.max(0, dayDiff(today, f.due_at)) : 5),
        });
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

  // Cold relationships (skip anyone with an upcoming meeting).
  for (const p of people) {
    if (peopleWithMeeting.has(p.id)) continue;
    const daysSince = dayDiff(p.last_contact_at, today);
    if (daysSince >= COLD_DAYS) {
      signals.push({ signal: { type: "cold", person: lite(p), daysSince, facts: recentFacts(p.id) }, rank: 60 + Math.max(0, 200 - daysSince) });
    }
  }

  return signals
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((s) => s.signal);
}
