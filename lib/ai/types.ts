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
  | { type: "cold"; person: PersonLite; daysSince: number; facts: string[] }
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
  brief(person: PersonLite, facts: string[], today: string): Promise<string>;
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
