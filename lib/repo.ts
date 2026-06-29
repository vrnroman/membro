import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { PersonRow, FactRow } from "@/lib/nightshift/scout";
import type { Card } from "@/lib/membro/types";

// Thin typed repository over SQLite. Each function mirrors a query the app used
// to run against Supabase, so the routes and components read the same shapes.

const PERSON_COLS =
  "id, name, company, role, blurb, birthday, next_meeting_at, last_contact_at";

const now = () => new Date().toISOString();

// ── People ──────────────────────────────────────────────────────────────────
export function listPeople(): PersonRow[] {
  return db()
    .prepare(`select ${PERSON_COLS} from people order by last_contact_at desc`)
    .all() as PersonRow[];
}

export function listPeopleIdName(): { id: string; name: string }[] {
  return db().prepare("select id, name from people").all() as { id: string; name: string }[];
}

export function getPerson(id: string): PersonRow | null {
  return (db().prepare(`select ${PERSON_COLS} from people where id = ?`).get(id) as PersonRow) ?? null;
}

export function insertPerson(p: {
  name: string;
  company?: string | null;
  role?: string | null;
  blurb?: string | null;
  birthday?: string | null;
}): { id: string; name: string } {
  const id = randomUUID();
  const ts = now();
  db()
    .prepare(
      `insert into people (id, name, company, role, blurb, birthday, last_contact_at, created_at, updated_at)
       values (@id, @name, @company, @role, @blurb, @birthday, @ts, @ts, @ts)`,
    )
    .run({
      id,
      name: p.name,
      company: p.company ?? null,
      role: p.role ?? null,
      blurb: p.blurb ?? null,
      birthday: p.birthday ?? null,
      ts,
    });
  return { id, name: p.name };
}

const PERSON_PATCH_COLS = new Set([
  "company",
  "role",
  "blurb",
  "birthday",
  "next_meeting_at",
  "last_contact_at",
  "updated_at",
]);

export function updatePerson(id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch).filter((k) => PERSON_PATCH_COLS.has(k));
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db()
    .prepare(`update people set ${set}, updated_at = @__ts where id = @__id`)
    .run({ ...patch, __ts: now(), __id: id });
}

export function touchPerson(id: string): void {
  const ts = now();
  db().prepare("update people set last_contact_at = ?, updated_at = ? where id = ?").run(ts, ts, id);
}

export function deletePerson(id: string): void {
  db().prepare("delete from people where id = ?").run(id);
}

// ── Facts ───────────────────────────────────────────────────────────────────
export function listFacts(): FactRow[] {
  return db()
    .prepare("select id, person_id, kind, content, due_at, status from facts order by created_at desc")
    .all() as FactRow[];
}

export type FactDetail = {
  id: string;
  kind: FactRow["kind"];
  content: string;
  due_at: string | null;
  status: FactRow["status"];
  created_at: string;
};

export function listFactsForPerson(personId: string): FactDetail[] {
  return db()
    .prepare(
      "select id, kind, content, due_at, status, created_at from facts where person_id = ? order by created_at desc",
    )
    .all(personId) as FactDetail[];
}

export function listFactContents(personId: string): string[] {
  return (
    db()
      .prepare("select content from facts where person_id = ? order by created_at desc")
      .all(personId) as { content: string }[]
  ).map((r) => r.content);
}

export function insertFact(f: {
  person_id: string;
  kind?: FactRow["kind"];
  content: string;
  due_at?: string | null;
  confidence?: number;
}): void {
  db()
    .prepare(
      `insert into facts (id, person_id, kind, content, due_at, confidence, created_at)
       values (@id, @person_id, @kind, @content, @due_at, @confidence, @created_at)`,
    )
    .run({
      id: randomUUID(),
      person_id: f.person_id,
      kind: f.kind ?? "fact",
      content: f.content,
      due_at: f.due_at ?? null,
      confidence: f.confidence ?? 1,
      created_at: now(),
    });
}

export function updateFactStatus(id: string, status: "open" | "done"): void {
  db().prepare("update facts set status = ? where id = ?").run(status, id);
}

// Delete a fact and any action (card) that was stored solely because of it.
// Cards record their originating fact in meta.source_fact_id (single-source
// cards only — a nudge built from one commitment), so the matching card is
// removed regardless of its status (pending/approved/skipped): once the fact is
// gone the action no longer has a reason to exist. Multi-fact connectors/briefs
// are NOT caused by a single fact, so they are intentionally left alone; any
// stale pending ones self-heal on the next nightshift regenerate.
export function deleteFact(id: string): void {
  const d = db();
  const tx = d.transaction((factId: string) => {
    d.prepare("delete from cards where json_extract(meta, '$.source_fact_id') = ?").run(factId);
    d.prepare("delete from facts where id = ?").run(factId);
  });
  tx(id);
}

// ── Captures ────────────────────────────────────────────────────────────────
export function insertCapture(body: string, sourceType: string): void {
  db()
    .prepare("insert into captures (id, body, source_type, created_at) values (?, ?, ?, ?)")
    .run(randomUUID(), body, sourceType, now());
}

// ── Cards (The Stack) ─────────────────────────────────────────────────────────
type CardRowDB = Omit<Card, "meta"> & { meta: string };

function hydrateCard(r: CardRowDB): Card {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.meta);
  } catch {
    /* keep {} */
  }
  return { ...r, meta };
}

export function listCards(): Card[] {
  return (db().prepare("select * from cards order by created_at desc").all() as CardRowDB[]).map(
    hydrateCard,
  );
}

export function deletePendingCards(): void {
  db().prepare("delete from cards where status = 'pending'").run();
}

export function insertCards(
  rows: {
    person_id: string | null;
    kind: Card["kind"];
    title: string;
    body: string;
    why: string | null;
    meta: Record<string, unknown>;
  }[],
): void {
  const stmt = db().prepare(
    `insert into cards (id, person_id, kind, title, body, why, meta, created_at)
     values (@id, @person_id, @kind, @title, @body, @why, @meta, @created_at)`,
  );
  const insertMany = db().transaction((items: typeof rows) => {
    for (const c of items) {
      stmt.run({
        id: randomUUID(),
        person_id: c.person_id,
        kind: c.kind,
        title: c.title,
        body: c.body,
        why: c.why,
        meta: JSON.stringify(c.meta ?? {}),
        created_at: now(),
      });
    }
  });
  insertMany(rows);
}

export function updateCard(id: string, patch: { status?: Card["status"]; body?: string }): void {
  if (patch.status !== undefined) db().prepare("update cards set status = ? where id = ?").run(patch.status, id);
  if (patch.body !== undefined) db().prepare("update cards set body = ? where id = ?").run(patch.body, id);
}
