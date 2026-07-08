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
    .prepare("select id, person_id, kind, content, due_at, status, owed_by, created_at from facts order by created_at desc")
    .all() as FactRow[];
}

export type FactDetail = {
  id: string;
  kind: FactRow["kind"];
  content: string;
  due_at: string | null;
  status: FactRow["status"];
  owed_by: FactRow["owed_by"];
  created_at: string;
};

export function listFactsForPerson(personId: string): FactDetail[] {
  return db()
    .prepare(
      "select id, kind, content, due_at, status, owed_by, created_at from facts where person_id = ? order by created_at desc",
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

// Returns the new fact's id so the caller (capture) can hand it to the per-note
// crew's Ledger member to check against what was already on file.
export function insertFact(f: {
  person_id: string;
  kind?: FactRow["kind"];
  content: string;
  due_at?: string | null;
  owed_by?: FactRow["owed_by"];
  confidence?: number;
  // The note this fact came from. Set by capture so an edit-and-reprocess of that
  // note can cleanly delete exactly the facts it filed and re-file them, instead of
  // stacking a second copy. Null for facts added by hand (no source note).
  capture_id?: string | null;
}): string {
  const id = randomUUID();
  db()
    .prepare(
      `insert into facts (id, person_id, kind, content, due_at, owed_by, confidence, capture_id, created_at)
       values (@id, @person_id, @kind, @content, @due_at, @owed_by, @confidence, @capture_id, @created_at)`,
    )
    .run({
      id,
      person_id: f.person_id,
      kind: f.kind ?? "fact",
      content: f.content,
      due_at: f.due_at ?? null,
      owed_by: f.owed_by ?? "me",
      confidence: f.confidence ?? 1,
      capture_id: f.capture_id ?? null,
      created_at: now(),
    });
  markBriefStale(f.person_id); // a new fact makes this person's Pre-Read out of date
  return id;
}

export function getFact(id: string): FactRow | null {
  return (
    db()
      .prepare("select id, person_id, kind, content, due_at, status, owed_by, created_at from facts where id = ?")
      .get(id) as FactRow
  ) ?? null;
}

// Patch a fact's status (done), due_at (snooze), and/or direction (flip me<->them).
// Any subset; a no-op if nothing valid is given. Marks the person's Pre-Read stale
// like the other fact mutators, since a closed/snoozed/flipped owe changes the read.
export function updateFact(
  id: string,
  patch: { status?: "open" | "done"; due_at?: string | null; owed_by?: FactRow["owed_by"] },
): void {
  const sets: string[] = [];
  const args: Record<string, unknown> = { __id: id };
  if (patch.status !== undefined) {
    sets.push("status = @status");
    args.status = patch.status;
  }
  if (patch.due_at !== undefined) {
    sets.push("due_at = @due_at");
    args.due_at = patch.due_at;
  }
  if (patch.owed_by !== undefined) {
    sets.push("owed_by = @owed_by");
    args.owed_by = patch.owed_by;
  }
  if (sets.length === 0) return;
  db().prepare(`update facts set ${sets.join(", ")} where id = @__id`).run(args);
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

// ── Fact conflicts (Ledger Catch) ─────────────────────────────────────────────
export type ConflictFact = { id: string; content: string; created_at: string };
export type PendingConflict = {
  id: string;
  reason: string | null;
  newFact: ConflictFact;
  oldFact: ConflictFact;
};

// Record a pending contradiction. Two things keep it clean when BOTH facts' capture
// jobs independently notice the same collision (each treats its own fact as "new"):
//   1. Orient by recency — the more recently filed fact is always new_fact_id, so the
//      profile's Newer/Older labels are right whichever job raised it.
//   2. Dedup on the UNORDERED pair (either orientation), so the pair is recorded once.
// Idempotent, so a crew-job retry never stacks duplicates. Returns the new row id, or
// null when it was a duplicate (or a fact had already vanished).
export function insertConflict(c: {
  personId: string;
  newFactId: string;
  oldFactId: string;
  reason: string | null;
}): string | null {
  const d = db();
  const nf = d.prepare("select created_at from facts where id = ?").get(c.newFactId) as { created_at: string } | undefined;
  const of = d.prepare("select created_at from facts where id = ?").get(c.oldFactId) as { created_at: string } | undefined;
  if (!nf || !of) return null; // a fact was deleted out from under us; nothing to record
  let newId = c.newFactId;
  let oldId = c.oldFactId;
  // Newer fact is new_fact_id. Tie-break on id when created_at is identical (same-
  // millisecond captures) so orientation is deterministic and the unordered dedup
  // below stays stable instead of depending on which crew job arrived first.
  if (nf.created_at < of.created_at || (nf.created_at === of.created_at && c.newFactId < c.oldFactId)) {
    newId = c.oldFactId;
    oldId = c.newFactId;
  }
  const dup = d
    .prepare(
      "select 1 from fact_conflicts where (new_fact_id = @a and old_fact_id = @b) or (new_fact_id = @b and old_fact_id = @a)",
    )
    .get({ a: newId, b: oldId });
  if (dup) return null;
  const id = randomUUID();
  d.prepare(
    `insert into fact_conflicts (id, person_id, new_fact_id, old_fact_id, reason, status, created_at)
     values (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, c.personId, newId, oldId, c.reason ?? null, now());
  return id;
}

// Pending contradictions for a person, hydrated with both facts' current text and
// dates for the side-by-side. The INNER JOINs mean a conflict whose facts were
// deleted elsewhere simply drops out (belt-and-suspenders with the FK cascade).
export function listPendingConflictsForPerson(personId: string): PendingConflict[] {
  const rows = db()
    .prepare(
      `select c.id as id, c.reason as reason,
              newf.id as new_id, newf.content as new_content, newf.created_at as new_created,
              oldf.id as old_id, oldf.content as old_content, oldf.created_at as old_created
       from fact_conflicts c
       join facts newf on newf.id = c.new_fact_id
       join facts oldf on oldf.id = c.old_fact_id
       where c.person_id = ? and c.status = 'pending'
       order by c.created_at desc`,
    )
    .all(personId) as {
    id: string;
    reason: string | null;
    new_id: string;
    new_content: string;
    new_created: string;
    old_id: string;
    old_content: string;
    old_created: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    newFact: { id: r.new_id, content: r.new_content, created_at: r.new_created },
    oldFact: { id: r.old_id, content: r.old_content, created_at: r.old_created },
  }));
}

export type ConflictRow = {
  id: string;
  person_id: string;
  new_fact_id: string;
  old_fact_id: string;
  status: "pending" | "resolved";
  resolution: string | null;
};

export function getConflict(id: string): ConflictRow | null {
  return (
    (db()
      .prepare("select id, person_id, new_fact_id, old_fact_id, status, resolution from fact_conflicts where id = ?")
      .get(id) as ConflictRow) ?? null
  );
}

// Mark a conflict resolved without touching any fact (keep-both, and defensively
// before a keep-new / keep-old delete). A resolved row never re-raises the pair.
export function resolveConflict(id: string, resolution: "keep_new" | "keep_old" | "keep_both"): void {
  db()
    .prepare("update fact_conflicts set status = 'resolved', resolution = ?, resolved_at = ? where id = ?")
    .run(resolution, now(), id);
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

export type CaptureRow = { id: string; body: string; source_type: string; created_at: string };

// One captured note plus a summary of what it put on file (which people, which
// facts) — the raw material for the editable Notes inbox. `filed` is empty for
// notes captured before facts carried their source note, and for a note that
// extracted nothing; the note's text is still shown and editable either way.
export type CaptureWithFiled = CaptureRow & {
  filed: { personId: string; personName: string; kind: FactRow["kind"]; content: string }[];
};

export function getCapture(id: string): CaptureRow | null {
  return (
    (db()
      .prepare("select id, body, source_type, created_at from captures where id = ?")
      .get(id) as CaptureRow) ?? null
  );
}

export function listCapturesWithFiled(limit = 200): CaptureWithFiled[] {
  const caps = db()
    .prepare("select id, body, source_type, created_at from captures order by created_at desc limit ?")
    .all(limit) as CaptureRow[];
  const filedStmt = db().prepare(
    `select f.person_id as person_id, f.kind as kind, f.content as content, p.name as person_name
     from facts f join people p on p.id = f.person_id
     where f.capture_id = ? order by f.created_at asc`,
  );
  return caps.map((c) => ({
    ...c,
    filed: (filedStmt.all(c.id) as { person_id: string; kind: FactRow["kind"]; content: string; person_name: string }[]).map(
      (r) => ({ personId: r.person_id, personName: r.person_name, kind: r.kind, content: r.content }),
    ),
  }));
}

// Point a capture at freshly edited text. source_type is kept as-is for provenance
// (a voice note stays labelled "voice" even after its transcript is corrected).
export function updateCaptureBody(id: string, body: string): void {
  db().prepare("update captures set body = ? where id = ?").run(body, id);
}

export function deleteCapture(id: string): void {
  db().prepare("delete from captures where id = ?").run(id);
}

// Delete every fact a given note filed, plus any single-source card built from one
// of them (mirrors deleteFact's card cleanup). fact_conflicts referencing a deleted
// fact fall away via the ON DELETE CASCADE. Returns the distinct people who lost a
// fact, so the caller can prune any left with nothing (a note re-filed onto a
// corrected name orphans the wrong one). Marks each person's brief stale.
export function deleteFactsForCapture(captureId: string): string[] {
  const d = db();
  const facts = d.prepare("select id, person_id from facts where capture_id = ?").all(captureId) as {
    id: string;
    person_id: string;
  }[];
  if (facts.length === 0) return [];
  const personIds = [...new Set(facts.map((f) => f.person_id))];
  const delCard = d.prepare("delete from cards where json_extract(meta, '$.source_fact_id') = ?");
  const delFact = d.prepare("delete from facts where id = ?");
  const tx = d.transaction(() => {
    for (const f of facts) {
      delCard.run(f.id);
      delFact.run(f.id);
    }
  });
  tx();
  for (const pid of personIds) markBriefStale(pid);
  return personIds;
}

// Prune any of the given people who now have zero facts — a contact that existed
// only because of a note that has since been re-filed onto a corrected name (the
// mis-heard "John" after "Joanne" lands). Never touches the diary self row, and
// leaves alone anyone still holding a fact from another note. deletePerson cascades
// their cards / briefs and nulls any assist. Returns the ids actually removed.
export function pruneEmptyPeople(personIds: string[]): string[] {
  const d = db();
  const countStmt = d.prepare("select count(*) as n from facts where person_id = ?");
  const removed: string[] = [];
  for (const pid of personIds) {
    if (pid === SELF_ID) continue;
    const { n } = countStmt.get(pid) as { n: number };
    if (n === 0) {
      deletePerson(pid);
      removed.push(pid);
    }
  }
  return removed;
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
  // Clear the night shift's own pending drafts before it regenerates them, but
  // SPARE user-initiated chase drafts: those are not regenerable (the night shift
  // never rebuilds them) and the owner is mid-review of them here and on Suggestions.
  db()
    .prepare("delete from cards where status = 'pending' and coalesce(json_extract(meta, '$.signal'), '') != 'chase'")
    .run();
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

// Write (or replace) the "chase" reminder card for a they-owe-me fact. Rerun-safe:
// tapping "Draft a reminder" twice replaces the prior draft for that fact rather
// than stacking duplicates, keyed on meta.source_fact_id + the chase tag. The card
// is a plain pending 'nudge' (no new card kind, no CHECK migration) reviewed like
// any other; meta.source_fact_id also lets deleteFact clean it up when the owe goes.
export function replaceChaseCard(row: {
  person_id: string | null;
  factId: string;
  title: string;
  body: string;
  why: string | null;
}): string {
  const id = randomUUID();
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(
      "delete from cards where json_extract(meta, '$.source_fact_id') = ? and json_extract(meta, '$.signal') = 'chase'",
    ).run(row.factId);
    d.prepare(
      `insert into cards (id, person_id, kind, title, body, why, meta, created_at)
       values (@id, @pid, 'nudge', @title, @body, @why, @meta, @ts)`,
    ).run({
      id,
      pid: row.person_id,
      title: row.title,
      body: row.body,
      why: row.why,
      meta: JSON.stringify({ signal: "chase", source_fact_id: row.factId }),
      ts: now(),
    });
  });
  tx();
  return id;
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

// Subjects the Researcher crew member has already briefed (stored on the assist
// meta), so it never re-briefs the same company on a later note even when that
// company never became a saved contact.
export function listResearchedSubjects(): string[] {
  const rows = db()
    .prepare("select distinct json_extract(meta, '$.subject') as subject from assists where json_extract(meta, '$.crew') = 'researcher'")
    .all() as { subject: string | null }[];
  return rows.map((r) => r.subject).filter((s): s is string => !!s);
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
