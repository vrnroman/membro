import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { PersonRow, FactRow } from "@/lib/nightshift/scout";
import { SELF_ID } from "@/lib/nightshift/scout";
import type { Card, Assist } from "@/lib/membro/types";

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
  // The brief renders who-they-are (company / role), so a change to those makes
  // the cached Pre-Read out of date the same way a fact change does.
  if (keys.includes("company") || keys.includes("role")) markBriefStale(id);
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
    .prepare("select id, person_id, kind, content, due_at, status, created_at from facts order by created_at desc")
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
  markBriefStale(f.person_id); // a new fact makes this person's Pre-Read out of date
}

export function updateFactStatus(id: string, status: "open" | "done"): void {
  db().prepare("update facts set status = ? where id = ?").run(status, id);
  const row = db().prepare("select person_id from facts where id = ?").get(id) as { person_id: string } | undefined;
  if (row) markBriefStale(row.person_id);
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
  const owner = d.prepare("select person_id from facts where id = ?").get(id) as { person_id: string } | undefined;
  const tx = d.transaction((factId: string) => {
    d.prepare("delete from cards where json_extract(meta, '$.source_fact_id') = ?").run(factId);
    d.prepare("delete from facts where id = ?").run(factId);
  });
  tx(id);
  if (owner) markBriefStale(owner.person_id); // removing a fact makes the Pre-Read out of date
}

// ── Captures ────────────────────────────────────────────────────────────────
// Returns the new capture id so the assistant pass can tie its output back to the
// exact note (and replace it, not duplicate it, on a re-run).
export function insertCapture(body: string, sourceType: string): string {
  const id = randomUUID();
  db()
    .prepare("insert into captures (id, body, source_type, created_at) values (?, ?, ?, ?)")
    .run(id, body, sourceType, now());
  return id;
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

// ── Assists (the assistant's per-note drafts / advisories) ────────────────────
type AssistRowDB = Omit<Assist, "meta"> & { meta: string };

function hydrateAssist(r: AssistRowDB): Assist {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.meta);
  } catch {
    /* keep {} */
  }
  return { ...r, meta };
}

// Only pending assists reach the dashboard (the UI shows nothing else), so scope
// the query rather than returning every assist ever written on each snapshot.
export function listPendingAssists(): Assist[] {
  return (
    db().prepare("select * from assists where status = 'pending' order by created_at desc").all() as AssistRowDB[]
  ).map(hydrateAssist);
}

export function insertAssist(a: {
  capture_id: string | null;
  person_id: string | null;
  kind: Assist["kind"];
  title: string;
  body: string;
  why: string | null;
  meta?: Record<string, unknown>;
}): void {
  db()
    .prepare(
      `insert into assists (id, capture_id, person_id, kind, title, body, why, meta, created_at)
       values (@id, @capture_id, @person_id, @kind, @title, @body, @why, @meta, @created_at)`,
    )
    .run({
      id: randomUUID(),
      capture_id: a.capture_id,
      person_id: a.person_id,
      kind: a.kind,
      title: a.title,
      body: a.body,
      why: a.why,
      meta: JSON.stringify(a.meta ?? {}),
      created_at: now(),
    });
}

export function updateAssist(id: string, patch: { status?: Assist["status"]; body?: string }): void {
  if (patch.status !== undefined) db().prepare("update assists set status = ? where id = ?").run(patch.status, id);
  if (patch.body !== undefined) db().prepare("update assists set body = ? where id = ?").run(patch.body, id);
}

// Idempotency for the async worker: a re-run of the same note clears its old
// output first, so a retry never leaves two drafts behind.
export function deleteAssistsForCapture(captureId: string): void {
  db().prepare("delete from assists where capture_id = ?").run(captureId);
}

export function countPendingAssists(): number {
  return (db().prepare("select count(*) as n from assists where status = 'pending'").get() as { n: number }).n;
}

// ── KV (small durable app state) ──────────────────────────────────────────────
export function getKv(key: string): string | null {
  const row = db().prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  db()
    .prepare(
      `insert into kv (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

// ── Briefs (Pre-Read cache) ───────────────────────────────────────────────────
export type BriefRow = {
  person_id: string;
  body: string; // BriefContent JSON
  source_fact_count: number;
  stale: number; // 0 | 1
  generated_at: string;
  updated_at: string;
};

export function getBrief(personId: string): BriefRow | null {
  return (db().prepare("select * from briefs where person_id = ?").get(personId) as BriefRow) ?? null;
}

// Store (or replace) a person's precomputed brief, clearing the stale flag. One
// row per person, so a regenerate overwrites rather than accumulating.
export function upsertBrief(b: { personId: string; body: string; sourceFactCount: number }): void {
  const ts = now();
  db()
    .prepare(
      `insert into briefs (person_id, body, source_fact_count, stale, generated_at, updated_at)
       values (@person_id, @body, @count, 0, @ts, @ts)
       on conflict(person_id) do update set
         body = excluded.body,
         source_fact_count = excluded.source_fact_count,
         stale = 0,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
    )
    .run({ person_id: b.personId, body: b.body, count: b.sourceFactCount, ts });
}

// Flag a person's brief as out of date (a fact of theirs changed). A no-op if
// they have no brief yet — the background pass will build one from scratch. Never
// throws into the caller: marking a brief stale must not fail a fact write.
export function markBriefStale(personId: string): void {
  try {
    db().prepare("update briefs set stale = 1, updated_at = ? where person_id = ?").run(now(), personId);
  } catch (e) {
    console.error(`[briefs] could not mark brief stale for ${personId}: ${(e as Error).message}`);
  }
}

// People whose brief is due for a (re)generation, most-deserving first: those
// with no brief at all, then the ones flagged stale, then the oldest. Skips the
// diary self row (it is never a relationship). Bounded by the caller because each
// brief is an AI call.
export function listPeopleNeedingBrief(staleBeforeISO: string, limit: number): string[] {
  const rows = db()
    .prepare(
      `select p.id as id
       from people p
       left join briefs b on b.person_id = p.id
       where p.id != @self
         and (b.person_id is null or b.stale = 1 or b.generated_at < @cutoff)
       order by (b.person_id is null) desc, b.stale desc, b.generated_at asc
       limit @limit`,
    )
    .all({ self: SELF_ID, cutoff: staleBeforeISO, limit }) as { id: string }[];
  return rows.map((r) => r.id);
}

// ── Diary (the owner's own thread on the reserved self row) ───────────────────
export function getOrCreateSelf(): { id: string; name: string } {
  const existing = db().prepare("select id, name from people where id = ?").get(SELF_ID) as
    | { id: string; name: string }
    | undefined;
  if (existing) return existing;
  const ts = now();
  db()
    .prepare(
      `insert into people (id, name, last_contact_at, created_at, updated_at) values (?, 'You', ?, ?, ?)`,
    )
    .run(SELF_ID, ts, ts, ts);
  return { id: SELF_ID, name: "You" };
}

// File a diary entry on the self thread, tagged with its source note. Rerun of
// the same note replaces (see deleteDiaryForCapture in the worker's transaction),
// so a genuinely repeated note on a different day is kept while a retry is safe.
export function insertDiaryEntry(content: string, captureId: string | null): void {
  getOrCreateSelf();
  db()
    .prepare(
      `insert into facts (id, person_id, kind, content, capture_id, confidence, created_at)
       values (?, ?, 'fact', ?, ?, 1, ?)`,
    )
    .run(randomUUID(), SELF_ID, content, captureId, now());
  touchPerson(SELF_ID);
}

// Clear any diary entry previously filed from this note, so the worker can
// re-file it exactly once on a retry.
export function deleteDiaryForCapture(captureId: string): void {
  db().prepare("delete from facts where person_id = ? and capture_id = ?").run(SELF_ID, captureId);
}
