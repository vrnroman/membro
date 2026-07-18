// The contract between Membro and whatever is doing the thinking (Claude or the
// keyless mock). Keeping it behind these types means the whole pipeline —
// capture, scatter, the Night Shift crew — can be exercised with no API key.

export type FactKind = "fact" | "date" | "commitment" | "preference";

export type ExtractedFact = {
  kind: FactKind;
  content: string;
  due_at?: string | null; // ISO datetime, for commitments and dated facts
  // Direction of a commitment: 'me' = the note-taker owes them, 'them' = they owe
  // the note-taker. Only meaningful for kind='commitment'; default 'me' when
  // unsure, so an ambiguous promise never invents a debt someone owes you.
  owed_by?: "me" | "them";
};

export type ExtractedEntity = {
  name: string;
  company?: string | null;
  role?: string | null;
  blurb?: string | null;
  birthday?: string | null; // "YYYY-MM-DD" or "MM-DD"
  confidence: number; // 0..1 — how sure we are this is one specific person
  facts: ExtractedFact[];
};

export type ExtractionResult = { entities: ExtractedEntity[] };

// One photo attached to a capture. A single note can carry several of these when
// the owner shot a long email / document across multiple photos; the adapter reads
// them together as one, working out the page order from their content.
export type CaptureImage = { base64: string; mediaType?: string };

// The per-note assistant pass. After a note is saved, this classifies it and,
// when it warrants, starts the work: a ready-to-send draft for a task, a read +
// drafted reply for a situation, or routing a first-person note to the diary.
//   draft    = the note is a task the owner needs to produce something for;
//              body is the ready-to-send email / message (slides = a markdown
//              outline for now).
//   advisory = the note is a situation or a "what do I say back"; body is a short
//              read plus a drafted reply.
//   diary    = a first-person note about the owner themselves; body is empty
//              (the note text becomes a diary entry).
//   none     = nothing to start (pure info already captured as facts).
export type AssistKind = "draft" | "advisory" | "diary" | "none";

export type AssistOutput = {
  kind: AssistKind;
  title: string; // short label for the card
  body: string; // the draft / advisory text ("" for diary / none)
  why: string; // one line: what made this worth starting
};

// A person the note is about, with what we already know, so the drafter can
// ground a reply in real facts instead of writing from a blank page.
export type AssistContextPerson = { name: string; facts: string[] };

// Ledger Catch. When a freshly filed fact ACTIVELY negates one already on file
// ("prefers tea" then "hates coffee now, switched to espresso"), the Ledger crew
// member flags the collision so the owner picks which is true now. A minimal fact
// reference (id + the exact captured text) is all the compare pass needs.
export type FactRef = { id: string; content: string };

// One flagged collision: a NEW fact that contradicts an OLD one, with a one-line,
// non-accusatory reason. Ids reference the rows so the resolver knows which to keep.
export type FactConflict = { newFactId: string; oldFactId: string; reason: string };

// Per-note crew, the Researcher member. When a note names a company / org / topic
// the owner has never logged, the Researcher leaves a one-paragraph, web-grounded
// brief: `subject` is what it is about, `body` is the paragraph (one current fact +
// a why-now tie-back to the note), `why` is the one-line reason it surfaced. Returns
// an empty list when nothing is worth briefing (a household name, a thin result, an
// ambiguous mention) — silence is a first-class result.
export type ResearchBrief = { subject: string; body: string; why: string };

// Per-note crew, the Connector member. When a newly filed fact reveals that the
// person it is about should meet someone ELSE already on file, the Connector names
// the intro. Its whole value is the fire bar: it returns null unless there is a
// SPECIFIC, two-sided reason (one person needs what the other offers), so a mere
// shared word never becomes a card. `otherId` is who to introduce the subject to,
// `why` grounds it in a real fact on each side with a direction, `intro` is a short
// double-opt-in note ready to send. Null = stay silent, a first-class result.
export type ConnectorSuggestion = { otherId: string; why: string; intro: string };

// A candidate the topic pre-filter turned up: another person who shares at least one
// topic with the new fact, passed to the model so it can judge whether the match is
// real. `sharedTopics` is why they surfaced; `facts` is their side of the story.
export type ConnectorCandidate = { id: string; name: string; sharedTopics: string[]; facts: string[] };

// Pre-Read. The prep "brief" is no longer a wall of prose you read on a click;
// it is a decision aid, computed in the background and shown the instant a person
// is opened. Three scannable blocks:
//   read            = two lines: who they are, and where you left it.
//   insights        = what changed since last time, the tension or opportunity now.
//   recommendations = concrete moves: open with X, you owe them Y, they owe you Z,
//                     what to avoid. Never a fabricated landmine — only real ones.
export type BriefContent = {
  read: string;
  insights: string[];
  recommendations: string[];
};

// What the generator hands the adapter. `facts` is everything known (newest
// first); `newFacts` are just the ones filed since the last brief (the coarse
// "what changed" diff); `cadenceDays` is the contact rhythm so the model can weave
// in "you usually talk every ~N days." The caller still prepends the DETERMINISTIC
// rhythm and new-since lines itself, so the numbers are never left to the model to
// invent. Deliberately NO absolute "N days ago": a precise recency baked into a
// cached brief goes wrong as it ages; the stable cadence is what we surface.
export type BriefInput = {
  person: PersonLite;
  facts: string[];
  newFacts: string[];
  cadenceDays: number | null;
  today: string;
};

// A "ripe" item the deterministic Scout found. The AI Builder turns one of these
// into a finished card. Person snapshots are plain objects so the Builder is
// pure with respect to the database.
export type PersonLite = {
  id: string;
  name: string;
  company?: string | null;
  role?: string | null;
  blurb?: string | null;
};

export type Signal =
  | { type: "birthday"; person: PersonLite; daysUntil: number; facts: string[] }
  | { type: "commitment"; person: PersonLite; commitment: string; dueLabel: string | null; owedBy: "me" | "them"; facts: string[]; factId?: string }
  | { type: "meeting"; person: PersonLite; whenLabel: string; facts: string[] }
  | { type: "dated"; person: PersonLite; event: string; whenLabel: string; daysUntil: number; facts: string[]; factId?: string }
  | { type: "cold"; person: PersonLite; daysSince: number; cadenceDays: number | null; facts: string[] }
  | { type: "connector"; personA: PersonLite; personB: PersonLite; shared: string; facts: string[] }
  // Not emitted by the Scout: built on demand when the owner taps "Draft a
  // reminder" on an overdue they-owe-me item. The Builder turns it into a light,
  // friendly nudge (a 'nudge' card), review-only like every other draft.
  | { type: "chase"; person: PersonLite; item: string; dueLabel: string | null; facts: string[]; factId?: string };

export type BuiltCard = {
  kind: "connector" | "nudge" | "brief";
  title: string;
  body: string;
  why: string;
};

export interface AiAdapter {
  readonly label: string; // "claude" | "mock", surfaced in the UI
  // A photo note can be SEVERAL images of one longer item (e.g. a two-page email
  // shot as two photos). They arrive as an ordered list, but the adapter should
  // reorder by content, not trust the upload order, and read them as one document.
  extract(input: { text: string; today: string; existingNames: string[]; images?: CaptureImage[] }): Promise<ExtractionResult>;
  buildCard(signal: Signal, today: string): Promise<BuiltCard>;
  brief(input: BriefInput): Promise<BriefContent>;
  // Per-note assistant: classify a freshly captured note and start the work.
  assist(input: { note: string; today: string; people: AssistContextPerson[] }): Promise<AssistOutput>;
  // Ledger Catch: flag any newly-filed fact that ACTIVELY contradicts one already
  // on file for the same person. Conservative by design — returns [] unless a real
  // negation is present (never a mere addition or an evolution over time).
  detectConflicts(input: { personName: string; newFacts: FactRef[]; existingFacts: FactRef[]; today: string }): Promise<FactConflict[]>;
  // Per-note crew, the Researcher: leave a short web-grounded brief for any company
  // or topic the note names that the owner has never logged. [] when nothing warrants it.
  research(input: { note: string; today: string; knownSubjects: string[] }): Promise<ResearchBrief[]>;
  // Per-note crew, the Connector: given the new note and a shortlist of people who
  // share a topic with its new fact, name at most ONE intro worth making right now.
  // null unless a specific two-sided reason exists — a shared word alone is not one.
  connectNote(input: {
    note: string;
    subjectName: string;
    candidates: ConnectorCandidate[];
    today: string;
  }): Promise<ConnectorSuggestion | null>;
  // Diary reflection: a short memo over the owner's own recent entries.
  reflect(entries: string[], today: string): Promise<string>;
}

// JSON Schemas handed to Claude's structured-output mode so the model is forced
// to return exactly the shape we parse.
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          company: { type: ["string", "null"] },
          role: { type: ["string", "null"] },
          blurb: { type: ["string", "null"] },
          birthday: { type: ["string", "null"] },
          confidence: { type: "number" },
          facts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["fact", "date", "commitment", "preference"] },
                content: { type: "string" },
                due_at: { type: ["string", "null"] },
                owed_by: { type: "string", enum: ["me", "them"] },
              },
              required: ["kind", "content"],
            },
          },
        },
        required: ["name", "confidence", "facts"],
      },
    },
  },
  required: ["entities"],
} as const;

export const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["connector", "nudge", "brief"] },
    title: { type: "string" },
    body: { type: "string" },
    why: { type: "string" },
  },
  required: ["kind", "title", "body", "why"],
} as const;

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    read: { type: "string" },
    insights: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
  },
  required: ["read", "insights", "recommendations"],
} as const;

export const ASSIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["draft", "advisory", "diary", "none"] },
    title: { type: "string" },
    body: { type: "string" },
    why: { type: "string" },
  },
  required: ["kind", "title", "body", "why"],
} as const;

export const CONFLICTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          newFactId: { type: "string" },
          oldFactId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["newFactId", "oldFactId", "reason"],
      },
    },
  },
  required: ["conflicts"],
} as const;

// The Researcher's web-search path can't combine a server tool with strict
// json_schema output, so it parses JSON from the model's prose instead of using a
// schema here (hence no RESEARCH_SCHEMA constant).

// Shared post-processing for the two new crew calls, used by every real adapter so
// a model's output is cleaned the same way regardless of engine.

// Keep only conflicts whose ids the model actually got from the input (never a
// hallucinated pair) and drop any self-pair or duplicate. The resolver acts on
// these ids, so a stray id must never reach the DB.
export function sanitizeConflicts(
  conflicts: FactConflict[] | undefined,
  newFacts: FactRef[],
  existingFacts: FactRef[],
): FactConflict[] {
  if (!Array.isArray(conflicts)) return [];
  const newIds = new Set(newFacts.map((f) => f.id));
  const oldIds = new Set(existingFacts.map((f) => f.id));
  const seen = new Set<string>();
  const out: FactConflict[] = [];
  for (const c of conflicts) {
    if (!c || typeof c.newFactId !== "string" || typeof c.oldFactId !== "string") continue;
    if (!newIds.has(c.newFactId) || !oldIds.has(c.oldFactId)) continue;
    if (c.newFactId === c.oldFactId) continue;
    const key = `${c.newFactId}:${c.oldFactId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ newFactId: c.newFactId, oldFactId: c.oldFactId, reason: (c.reason || "").trim() });
  }
  return out;
}

// Drop briefs with an empty subject/body or one that is actually on file (a
// belt-and-suspenders check on top of the prompt's "do not brief these"), and cap
// the count so one note never floods the review list.
export function sanitizeBriefs(briefs: ResearchBrief[] | undefined, knownSubjects: string[]): ResearchBrief[] {
  if (!Array.isArray(briefs)) return [];
  const known = new Set(knownSubjects.map((s) => s.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: ResearchBrief[] = [];
  for (const b of briefs) {
    if (!b || typeof b.subject !== "string" || typeof b.body !== "string") continue;
    const subject = b.subject.trim();
    const body = b.body.trim();
    if (!subject || !body) continue;
    const key = subject.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ subject, body, why: (b.why || "").trim() });
  }
  return out.slice(0, 3);
}

// The Connector's fire bar, enforced in code rather than trusted from the prompt:
// keep the suggestion ONLY when it names a real candidate and carries both a reason
// and a drafted intro. A missing field means the model could not actually justify
// the intro, which is exactly the case that must stay silent. Returns null for "no
// intro worth making," the same first-class silence the Researcher and Ledger use.
export function sanitizeConnector(
  s: ConnectorSuggestion | null | undefined,
  candidateIds: string[],
): ConnectorSuggestion | null {
  if (!s || typeof s.otherId !== "string") return null;
  const ids = new Set(candidateIds);
  if (!ids.has(s.otherId)) return null; // must be one of the people we actually offered
  const why = (s.why || "").trim();
  const intro = (s.intro || "").trim();
  if (!why || !intro) return null; // no grounded reason or no draft => not a real match
  return { otherId: s.otherId, why, intro };
}
