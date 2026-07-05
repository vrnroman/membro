// The contract between Membro and whatever is doing the thinking (Claude or the
// keyless mock). Keeping it behind these types means the whole pipeline —
// capture, scatter, the Night Shift crew — can be exercised with no API key.

export type FactKind = "fact" | "date" | "commitment" | "preference";

export type ExtractedFact = {
  kind: FactKind;
  content: string;
  due_at?: string | null; // ISO datetime, for commitments and dated facts
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
  | { type: "commitment"; person: PersonLite; commitment: string; dueLabel: string | null; facts: string[]; factId?: string }
  | { type: "meeting"; person: PersonLite; whenLabel: string; facts: string[] }
  | { type: "dated"; person: PersonLite; event: string; whenLabel: string; daysUntil: number; facts: string[]; factId?: string }
  | { type: "cold"; person: PersonLite; daysSince: number; cadenceDays: number | null; facts: string[] }
  | { type: "connector"; personA: PersonLite; personB: PersonLite; shared: string; facts: string[] };

export type BuiltCard = {
  kind: "connector" | "nudge" | "brief";
  title: string;
  body: string;
  why: string;
};

export interface AiAdapter {
  readonly label: string; // "claude" | "mock", surfaced in the UI
  extract(input: { text: string; today: string; existingNames: string[]; imageBase64?: string; imageMediaType?: string }): Promise<ExtractionResult>;
  buildCard(signal: Signal, today: string): Promise<BuiltCard>;
  brief(input: BriefInput): Promise<BriefContent>;
  // Per-note assistant: classify a freshly captured note and start the work.
  assist(input: { note: string; today: string; people: AssistContextPerson[] }): Promise<AssistOutput>;
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
