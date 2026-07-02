export type { PersonRow, FactRow } from "@/lib/nightshift/scout";

export type Card = {
  id: string;
  person_id: string | null;
  kind: "connector" | "nudge" | "brief";
  title: string;
  body: string;
  why: string | null;
  status: "pending" | "approved" | "skipped";
  meta: Record<string, unknown>;
  created_at: string;
};

// The assistant's per-note output (a draft to send, or a situation read + reply).
// Shares the Card review affordances (approve / copy / edit / skip) in the UI.
export type Assist = {
  id: string;
  capture_id: string | null;
  person_id: string | null;
  kind: "draft" | "advisory";
  title: string;
  body: string;
  why: string | null;
  status: "pending" | "approved" | "skipped";
  meta: Record<string, unknown>;
  created_at: string;
};
