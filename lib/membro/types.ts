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
