import type {
  AiAdapter,
  AssistContextPerson,
  AssistOutput,
  BriefContent,
  BriefInput,
  BuiltCard,
  ExtractedEntity,
  ExtractedFact,
  ExtractionResult,
  FactConflict,
  FactRef,
  ResearchBrief,
  ConnectorSuggestion,
  ConnectorCandidate,
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
// The other direction: something the OTHER person owes the note-taker. Kept
// distinct from PROMISE so the Scatter can set owed_by='them' (a they-owe-me),
// which is the half the Ledger of Owes adds. Deliberately narrow ("...me",
// "waiting on") so an ambiguous line still falls through to 'me'.
const THEM_OWES = /\b(owes? me|owe me|will (send|get|share|bring|email|give) me|(gets?|getting) back to me|promised me|waiting (on|for)|still owes?|send me|owe(s|d)? (me|us))\b/i;
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
  if (PROMISE.test(sentence) || THEM_OWES.test(sentence)) return "commitment";
  if (PREF.test(sentence)) return "preference";
  if (MOVING.test(sentence)) return "fact";
  return "fact";
}

// Direction of a commitment sentence: 'them' when the other person owes the
// note-taker, else 'me'. Default 'me' keeps an ambiguous promise from inventing a
// debt owed to the owner.
function directionOf(sentence: string): "me" | "them" {
  return THEM_OWES.test(sentence) ? "them" : "me";
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
        if (kind === "commitment") fact.owed_by = directionOf(sentence);
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

  async buildCard(signal: Signal): Promise<BuiltCard> {
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
      case "dated":
        return {
          kind: "brief",
          title: `Coming up: ${truncate(signal.event, 40)} (${signal.whenLabel})`,
          body: `"${signal.event}" is ${signal.whenLabel}. Anything to prepare for ${signal.person.name}?`,
          why: `A dated event involving ${signal.person.name} is ${signal.whenLabel}.`,
        };
      case "cold": {
        const first = signal.person.name.split(" ")[0];
        const anchor = signal.facts[0];
        return {
          kind: "nudge",
          title: `Reconnect with ${signal.person.name} (${signal.daysSince}d quiet)`,
          // Anchor the opener to a real recent fact when we have one, so it never
          // reads as a generic "just checking in".
          body: anchor
            ? `Hi ${first}, you crossed my mind today. Still thinking about ${anchor}, how did that land? Would love to catch up properly soon.`
            : `Hi ${first}, you crossed my mind today and I'd love to catch up. Free for a coffee or quick call this week?`,
          why: signal.cadenceDays
            ? `You usually talk about every ${signal.cadenceDays} days, and it has been ${signal.daysSince}.`
            : `No contact with ${signal.person.name} in ${signal.daysSince} days.`,
        };
      }
      case "connector":
        return {
          kind: "connector",
          title: `Introduce ${signal.personA.name.split(" ")[0]} ↔ ${signal.personB.name.split(" ")[0]} (${signal.shared})`,
          body: `Hi both, quick intro. ${signal.personA.name}, meet ${signal.personB.name}. You're both connected to ${signal.shared}, so I thought you should know each other. I'll let you two take it from here.`,
          why: `${signal.personA.name} and ${signal.personB.name} are both linked to ${signal.shared}.`,
        };
      case "chase": {
        const first = signal.person.name.split(" ")[0];
        // Warm and no-pressure; never mentions lateness or timing (the item is
        // anchored, urgency stays internal to sorting).
        return {
          kind: "nudge",
          title: `Follow up with ${signal.person.name} on ${truncate(signal.item, 40)}`,
          body: `Hi ${first}, hope you're doing well. How's ${signal.item} coming along? No rush at all, just keeping it on my radar.`,
          why: `${signal.person.name} owes you ${signal.item}.`,
        };
      }
    }
  }

  // Deterministic structured Pre-Read, honest to the facts (invents nothing), so
  // the keyless path and the pipeline test exercise the same three-block shape the
  // model returns. The generator prepends the deterministic rhythm / new-since
  // lines, so this only produces the qualitative read, insights, and moves.
  async brief(input: BriefInput): Promise<BriefContent> {
    const { person, facts } = input;
    const first = person.name.split(" ")[0];
    const who = [person.role, person.company].filter(Boolean).join(" at ");
    const read = [
      who ? `${person.name}, ${who}.` : `${person.name}.`,
      facts[0] ? `Last on file: ${facts[0]}.` : "Nothing on file yet, so this is a fresh start.",
    ].join(" ");

    const openThread = facts.find((f) => /\b(owe|promised|send|deliver|follow up|waiting)\b/i.test(f));
    const insights: string[] = [];
    if (facts.length > 1) insights.push(`${facts.length} things on file about ${first} so far.`);
    if (openThread) insights.push(`Looks like an open thread: ${openThread}.`);

    const recommendations: string[] = [
      facts[0] ? `Open with what you last noted: ${facts[0]}.` : `Ask ${first} what they are working on.`,
    ];
    if (openThread) recommendations.push(`Close the loop on: ${openThread}.`);

    return { read, insights, recommendations };
  }

  // Deterministic classifier + starter, good enough to drive the assistant path
  // offline and in tests. It never invents facts: a draft just wraps the note.
  async assist(input: { note: string; today: string; people: AssistContextPerson[] }): Promise<AssistOutput> {
    const note = (input.note || "").trim();
    const who = input.people[0]?.name;
    const first = who ? who.split(" ")[0] : "there";

    if (ASSIST_TASK.test(note)) {
      return {
        kind: "draft",
        title: who ? `Draft for ${who}` : "Draft ready",
        body: `Hi ${first},\n\n${capitalize(note.replace(/[.!?]+$/, ""))}. Sending this over now; let me know if anything needs a change.\n\nBest`,
        why: "The note reads like something you need to send.",
      };
    }
    if (ASSIST_SITUATION.test(note)) {
      return {
        kind: "advisory",
        title: who ? `How to handle ${who}` : "A read on this",
        body: `Read: this looks like a moment to address directly and early, before it grows.\n\nDraft reply:\nHi ${first}, thanks for flagging this. Let me take a proper look and get back to you shortly.`,
        why: "The note reads like a situation you may want to respond to.",
      };
    }
    // A first-person reflection is a diary entry even if it names someone
    // ("I felt proud after my chat with Tom") — the feeling is about the owner.
    if (ASSIST_DIARY.test(note)) {
      return { kind: "diary", title: "Diary entry", body: "", why: "A personal reflection about you." };
    }
    return { kind: "none", title: "", body: "", why: "Nothing to start from this one." };
  }

  // Deterministic, honest contradiction check for the offline path and the test.
  // Conservative on purpose (the ideator's bar): it flags ONLY an active polarity
  // flip on a shared topic word ("Loves coffee" then "Hates coffee now"), never a
  // mere addition, an evolution, or two things that are both true ("prefers tea" +
  // "loves the espresso machine" share no topic token, so they never collide).
  async detectConflicts(input: {
    personName: string;
    newFacts: FactRef[];
    existingFacts: FactRef[];
    today: string;
  }): Promise<FactConflict[]> {
    const out: FactConflict[] = [];
    for (const nf of input.newFacts) {
      for (const ef of input.existingFacts) {
        if (nf.id === ef.id) continue;
        if (contradicts(nf.content, ef.content)) {
          out.push({
            newFactId: nf.id,
            oldFactId: ef.id,
            reason: `"${ef.content}" and "${nf.content}" look like they may have changed.`,
          });
          break; // one collision per new fact is enough to raise the flag
        }
      }
    }
    return out;
  }

  // Deterministic offline Researcher: name any company-shaped subject the note
  // mentions that is not already on file, and leave a short placeholder brief. The
  // real (CLI) adapter web-searches; the mock stays honest that it did not.
  async research(input: { note: string; today: string; knownSubjects: string[] }): Promise<ResearchBrief[]> {
    const known = new Set(input.knownSubjects.map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    const briefs: ResearchBrief[] = [];
    for (const m of input.note.matchAll(COMPANY)) {
      const subject = m[1].replace(/\.$/, "").trim();
      const key = subject.toLowerCase();
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      briefs.push({
        subject,
        body: `${subject} came up in your note and is not on file yet. Connect the Claude CLI for a live, web-researched one-paragraph brief here.`,
        why: `You mentioned ${subject} for the first time.`,
      });
    }
    return briefs.slice(0, 2); // never flood a single note with briefs
  }

  // Deterministic offline Connector. The real (CLI) adapter judges whether the
  // match is a genuine two-sided reason; the mock can't reason, so it uses a simple
  // stand-in for the fire bar: it "connects" the first candidate whose shared facts
  // read as complementary (one side says want/need/looking/raising, the other says
  // offer/back/invest/help). Otherwise it stays silent, mirroring the real bias.
  async connectNote(input: {
    note: string;
    subjectName: string;
    candidates: ConnectorCandidate[];
    today: string;
  }): Promise<ConnectorSuggestion | null> {
    const NEEDY = /\b(rais(e|ing)|looking|need|want|seeking|hiring|searching)\b/i;
    const OFFERY = /\b(back|backs|invest|angel|offer|help|mentor|advis|connect|hir(e|ing) for)\b/i;
    const noteWants = NEEDY.test(input.note);
    const noteOffers = OFFERY.test(input.note);
    for (const c of input.candidates) {
      const theirs = c.facts.join(" ");
      const complementary =
        (noteWants && OFFERY.test(theirs)) || (noteOffers && NEEDY.test(theirs));
      if (!complementary) continue;
      const topic = c.sharedTopics[0] || "a shared interest";
      return {
        otherId: c.id,
        why: `${input.subjectName} and ${c.name} are both around ${topic}, and one is looking while the other can help.`,
        intro: `You two should talk. ${input.subjectName} and ${c.name}, you are both close to ${topic} from different sides. Want me to connect you?`,
      };
    }
    return null; // no complementary match: stay silent, like the real adapter
  }

  async reflect(entries: string[]): Promise<string> {
    if (!entries.length) {
      return "Nothing in your diary yet. Capture a note about how you are doing and I'll reflect it back.";
    }
    return [
      "Looking back at your recent notes:",
      ...entries.slice(0, 5).map((e) => `- ${e}`),
      "",
      "One thing to carry forward: notice what gave you energy this week and make room for more of it.",
    ].join("\n");
  }
}

// Heuristics for the offline classifier. Order at the call site is task, then
// situation, then diary, then nothing.
const ASSIST_TASK = /\b(send|sending|draft|write|prepare|prep|email|reply|respond|follow up|get back to|deck|slides|proposal|deliver|circle back)\b/i;
const ASSIST_SITUATION = /\b(annoyed|upset|worried|frustrated|unhappy|awkward|tension|angry|concerned|pushed? back|how (do|should) i|what (do|should) i|what to (say|respond))\b/i;
const ASSIST_DIARY = /\b(i'?m|i am|i was|i feel|i felt|feeling|anxious|nervous|tired|exhausted|excited|proud|grateful|stressed|overwhelmed|burnt out|burned out)\b/i;

// Ledger Catch heuristics (mock/offline). A contradiction is an OPPOSITE-polarity
// pair on a shared topic word — positive sentiment about X on one side, negative on
// the other. Everything else (additions, evolutions, coexisting likes) stays silent.
const POS_SENTIMENT = /\b(love|loves|loved|like|likes|liked|prefer|prefers|preferred|enjoy|enjoys|enjoyed|favou?rite|into)\b/i;
const NEG_SENTIMENT = /\b(hate|hates|hated|dislike|dislikes|disliked|can'?t stand|no longer|not any ?more|stopped|quit|gave up|avoids?|allergic)\b/i;
// Words that are never the *topic* of a contradiction (sentiment verbs + filler),
// so the shared token we key on is a real subject noun, not "loves"/"really".
const TOPIC_STOP = new Set([
  "love", "loves", "loved", "like", "likes", "liked", "prefer", "prefers", "preferred",
  "enjoy", "enjoys", "enjoyed", "favourite", "favorite", "hate", "hates", "hated",
  "dislike", "dislikes", "stand", "longer", "anymore", "stopped", "quit", "avoid", "avoids",
  "really", "always", "never", "still", "much", "very", "some", "thing", "things", "stuff",
  "them", "they", "their", "your", "with", "that", "this", "have", "just", "want", "wants",
]);

function topicTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((t) => !TOPIC_STOP.has(t)));
}

function sharedTopic(a: string, b: string): boolean {
  const A = topicTokens(a);
  const B = topicTokens(b);
  for (const t of A) if (B.has(t)) return true;
  return false;
}

// True only when the two facts talk about the same topic with opposite sentiment.
function contradicts(a: string, b: string): boolean {
  if (!sharedTopic(a, b)) return false;
  const aPos = POS_SENTIMENT.test(a);
  const aNeg = NEG_SENTIMENT.test(a);
  const bPos = POS_SENTIMENT.test(b);
  const bNeg = NEG_SENTIMENT.test(b);
  return (aPos && bNeg) || (aNeg && bPos);
}

// Company-shaped subject: a capitalized name followed by an org suffix. Precise on
// purpose so the offline Researcher does not brief every capitalized word.
const COMPANY = /\b([A-Z][A-Za-z0-9&.\-]+(?:\s+(?:Inc|Corp|Corporation|Labs?|AI|Technologies|Tech|Systems|Solutions|Ltd|LLC|Group|Studios?|Ventures|Partners|Capital))\.?)\b/g;

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
