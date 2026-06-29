import type {
  AiAdapter,
  BuiltCard,
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
  PersonLite,
  Signal,
} from "./types";

// A deterministic, keyless stand-in for Claude. It is good enough to drive the
// whole product end to end without an API key — which is what lets the build be
// verified before the owner pastes a real key. It is not as smart as the model,
// but it is honest: it never makes up facts that are not in the text.

const STOP = new Set([
  "I", "We", "My", "He", "She", "They", "The", "A", "An", "And", "But", "So",
  "Just", "Then", "Also", "Today", "Tomorrow", "Yesterday", "Her", "His", "Their",
  "It", "This", "That", "Before", "After", "When", "While", "Q1", "Q2", "Q3", "Q4",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  // Common sentence-initial verbs — never first names, often start a meeting note.
  "Met", "Saw", "Spoke", "Talked", "Caught", "Had", "Went", "Grabbed", "Called",
  "Texted", "Emailed", "Bumped", "Chatted", "Discussed", "Got", "Finished",
  "Started", "Wrapped", "Ran", "Heard", "Learned", "Found", "Asked", "Told",
]);

const PROMISE = /\b(i'?ll|i will|i promised|promised|i owe|owe|i need to|i'?ve got to|send (him|her|them)|get (him|her|them)|circle back|follow up)\b/i;
const MOVING = /\b(moving to|relocat\w+ to|joining|transferring to|starting at)\b/i;
const PREF = /\b(prefers|likes|hates|always|never)\b/i;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Words that, when they precede a capitalized token, mark it as a place or thing
// rather than a person ("the Berlin office", "our Berlin team", "to London").
const NOT_NAME_BEFORE = new Set([
  "the", "our", "a", "an", "to", "in", "at", "of", "from", "into", "this", "that", "your", "their",
]);

// Candidate names: capitalized first-name-shaped tokens that read like a person
// (not preceded by an article/preposition), plus anyone already on file. We keep
// the first appearance casing so "Maya" stays "Maya".
function findNames(text: string, existingNames: string[]): string[] {
  const found = new Map<string, string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]{1,})\b/g)) {
    const tok = m[1];
    if (STOP.has(tok)) continue;
    const before = text.slice(0, m.index).trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, "") || "";
    if (NOT_NAME_BEFORE.has(before)) continue; // place / thing, not a person
    found.set(tok.toLowerCase(), tok);
  }
  for (const n of existingNames) {
    const first = n.split(" ")[0];
    if (text.toLowerCase().includes(first.toLowerCase())) {
      found.set(first.toLowerCase(), n);
    }
  }
  return [...found.values()];
}

function classify(sentence: string): ExtractedFact["kind"] {
  if (PROMISE.test(sentence)) return "commitment";
  if (PREF.test(sentence)) return "preference";
  if (MOVING.test(sentence)) return "fact";
  return "fact";
}

function addDays(today: string, days: number): string {
  const d = new Date(`${today}T09:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export class MockAdapter implements AiAdapter {
  readonly label = "mock";

  async extract(input: {
    text: string;
    today: string;
    existingNames: string[];
  }): Promise<ExtractionResult> {
    const text = input.text || "";
    const sentences = splitSentences(text);
    const names = findNames(text, input.existingNames);
    const byKey = new Map<string, ExtractedEntity>();
    // A name has "strong" evidence of being a real person when it does something
    // ("Maya got…", "Tom mentioned…", "Priya is moving…"). A bare copula +
    // descriptor ("Berlin is cold") is weak and gets quarantined by the gate.
    const strongByKey = new Set<string>();
    const COPULA = new Set(["is", "are", "was", "were"]);

    for (const sentence of sentences) {
      for (const name of names) {
        const first = name.split(" ")[0];
        const esc = escapeRegex(first); // names come from user data — never trust them in a RegExp
        if (!new RegExp(`\\b${esc}\\b`, "i").test(sentence)) continue;

        const key = first.toLowerCase();
        if (!byKey.has(key)) {
          byKey.set(key, { name, confidence: 0.9, facts: [] });
        }
        const entity = byKey.get(key)!;

        const m = sentence.match(new RegExp(`\\b${esc}\\b\\s+(\\w+)(?:\\s+(\\w+))?`, "i"));
        const w1 = (m?.[1] || "").toLowerCase();
        const w2 = (m?.[2] || "").toLowerCase();
        // Strong unless it's "Name is <adjective>" (a description, not an action).
        const strong = !COPULA.has(w1) || w2.endsWith("ing") || w2.endsWith("ed");
        if (strong) strongByKey.add(key);
        const kind = classify(sentence);

        // Strip the leading subject so the fact reads cleanly.
        let content = sentence.replace(new RegExp(`^.*?\\b${esc}\\b\\s*`, "i"), "").trim();
        if (!content) content = sentence;
        content = content.replace(/[.!?]+$/, "");

        const fact: ExtractedFact = { kind, content: capitalize(content) };
        if (/\bnext week\b/i.test(sentence)) fact.due_at = addDays(input.today, 7);
        else if (/\btomorrow\b/i.test(sentence)) fact.due_at = addDays(input.today, 1);
        else if (/\bthursday\b/i.test(sentence)) fact.due_at = addDays(input.today, 3);

        if (/\bbirthday\b/i.test(sentence)) {
          const due = fact.due_at ? new Date(fact.due_at) : new Date(addDays(input.today, 7));
          entity.birthday = `${String(due.getUTCMonth() + 1).padStart(2, "0")}-${String(due.getUTCDate()).padStart(2, "0")}`;
        }
        entity.facts.push(fact);
      }
    }

    // Lightly enrich blurb/company, and set confidence from the evidence so the
    // capture route's gate can quarantine weakly-evidenced "people" (likely places).
    for (const [key, entity] of byKey) {
      entity.confidence = strongByKey.has(key) ? 0.9 : 0.5;
      const moving = entity.facts.find((f) => MOVING.test(f.content));
      if (moving && !entity.blurb) entity.blurb = capitalize(moving.content);
    }

    return { entities: [...byKey.values()] };
  }

  async buildCard(signal: Signal, today: string): Promise<BuiltCard> {
    switch (signal.type) {
      case "birthday":
        return {
          kind: "nudge",
          title: `${signal.person.name}'s birthday is ${signal.daysUntil === 0 ? "today" : `in ${signal.daysUntil} days`}`,
          body: `Hi ${signal.person.name.split(" ")[0]}, happy birthday! Hope you get to celebrate properly. Let's grab time soon.`,
          why: `${signal.person.name}'s birthday is ${signal.daysUntil} day(s) away.`,
        };
      case "commitment":
        return {
          kind: "brief",
          title: `You owe ${signal.person.name}: ${truncate(signal.commitment, 40)}`,
          body: `Reminder to deliver on "${signal.commitment}"${signal.dueLabel ? ` before ${signal.dueLabel}` : ""}. If you need a beat: "Hi ${signal.person.name.split(" ")[0]}, sending this over shortly, want to make sure it's right."`,
          why: `You promised ${signal.person.name} this and it is still open.`,
        };
      case "meeting":
        return {
          kind: "brief",
          title: `Prep for ${signal.person.name} (${signal.whenLabel})`,
          body: `Ice-breaker: ${signal.facts[0] || "ask how things are going"}.\nRemember:\n- ${signal.facts.slice(0, 3).join("\n- ") || "nothing on file yet"}`,
          why: `You have a meeting with ${signal.person.name} ${signal.whenLabel}.`,
        };
      case "cold":
        return {
          kind: "nudge",
          title: `Reconnect with ${signal.person.name} (${signal.daysSince}d quiet)`,
          body: `Hi ${signal.person.name.split(" ")[0]}, it's been a while. You crossed my mind today and I'd love to catch up. Free for a coffee or quick call this week?`,
          why: `No contact with ${signal.person.name} in ${signal.daysSince} days.`,
        };
      case "connector":
        return {
          kind: "connector",
          title: `Introduce ${signal.personA.name.split(" ")[0]} ↔ ${signal.personB.name.split(" ")[0]} (${signal.shared})`,
          body: `Hi both, quick intro. ${signal.personA.name} — meet ${signal.personB.name}. You're both connected to ${signal.shared}, so I thought you should know each other. I'll let you two take it from here.`,
          why: `${signal.personA.name} and ${signal.personB.name} are both linked to ${signal.shared}.`,
        };
    }
  }

  async brief(person: PersonLite, facts: string[]): Promise<string> {
    const first = person.name.split(" ")[0];
    return [
      `Ice-breaker: ${facts[0] ? `ask about ${facts[0].toLowerCase()}` : `ask ${first} what they're working on`}.`,
      "",
      "Remember:",
      ...(facts.length ? facts.slice(0, 4).map((f) => `- ${f}`) : ["- nothing on file yet"]),
    ].join("\n");
  }
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
