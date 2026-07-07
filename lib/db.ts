import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Local-first data layer. Membro stores everything in a single SQLite file that
// only this server process touches — there is no network database to expose.
// The path comes from MEMBRO_DATA_DIR (set by the systemd unit on the VM); it
// falls back to ./data for local dev. The connection is a lazy singleton so the
// file is never opened at build time, only on first request.

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const dir = process.env.MEMBRO_DATA_DIR || join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const d = new Database(join(dir, "membro.db"));
  d.pragma("journal_mode = WAL"); // concurrent reads while a write is in flight
  d.pragma("foreign_keys = ON"); // honour ON DELETE CASCADE
  d.exec(SCHEMA);
  migrate(d);
  _db = d;
  return d;
}

// Additive column migrations for tables that predate a column. SQLite cannot add
// a column by re-running CREATE, so bring existing databases up to the current
// schema here. Idempotent: only adds a column that is missing.
function migrate(d: Database.Database): void {
  const factCols = (d.prepare("pragma table_info(facts)").all() as { name: string }[]).map((c) => c.name);
  // capture_id ties a diary entry to its source note so a worker re-run replaces
  // it (rerun-safety) while genuinely repeated notes on different days are kept.
  if (!factCols.includes("capture_id")) d.exec("alter table facts add column capture_id text");
  // owed_by is the direction of a commitment: 'me' = I promised them, 'them' =
  // they owe me (the Ledger of Owes). Added without the CHECK (SQLite ALTER can't
  // add a constraint; the app enforces the enum) and defaulted to 'me', which
  // backfills every existing commitment to the old implicit assumption.
  if (!factCols.includes("owed_by")) d.exec("alter table facts add column owed_by text not null default 'me'");
  // crew_facts carries the ids of the facts a note just filed, so the per-note
  // crew's Ledger member can compare them against what was already on file. Added
  // to assist_jobs (which predates the crew) as a nullable JSON column.
  const jobCols = (d.prepare("pragma table_info(assist_jobs)").all() as { name: string }[]).map((c) => c.name);
  if (!jobCols.includes("crew_facts")) d.exec("alter table assist_jobs add column crew_facts text");
}

// Single-user app: no user_id, no row-level security (the whole app is gated to
// one Google identity at the proxy). Types map Postgres → SQLite: uuid/date/
// timestamptz → TEXT (ISO strings), jsonb → TEXT (JSON), real → REAL.
const SCHEMA = `
create table if not exists people (
  id              text primary key,
  name            text not null,
  company         text,
  role            text,
  blurb           text,
  birthday        text,
  next_meeting_at text,
  last_contact_at text not null,
  color           text not null default 'slate',
  created_at      text not null,
  updated_at      text not null
);
create index if not exists people_contact_idx on people (last_contact_at desc);

create table if not exists facts (
  id         text primary key,
  person_id  text not null references people (id) on delete cascade,
  kind       text not null default 'fact' check (kind in ('fact','date','commitment','preference')),
  content    text not null,
  due_at     text,
  status     text not null default 'open' check (status in ('open','done')),
  -- Direction of a commitment: 'me' = I owe them, 'them' = they owe me. Only
  -- meaningful for kind='commitment'; other kinds keep the harmless 'me' default.
  owed_by    text not null default 'me' check (owed_by in ('me','them')),
  confidence real not null default 1,
  capture_id text,
  created_at text not null
);
create index if not exists facts_person_idx on facts (person_id, created_at desc);

create table if not exists captures (
  id          text primary key,
  body        text not null,
  source_type text not null default 'text' check (source_type in ('text','voice','photo')),
  created_at  text not null
);

create table if not exists cards (
  id         text primary key,
  person_id  text references people (id) on delete cascade,
  kind       text not null check (kind in ('connector','nudge','brief')),
  title      text not null,
  body       text not null,
  why        text,
  status     text not null default 'pending' check (status in ('pending','approved','skipped')),
  meta       text not null default '{}',
  created_at text not null
);
create index if not exists cards_status_idx on cards (status, created_at desc);

-- Voice notes that couldn't be transcribed+filed inline because Gemini was rate-
-- limited / overloaded. The background worker drains this: it re-transcribes
-- (once 'transcript' is filled it never hits Gemini again) then files the note,
-- backing off between tries. A note is never lost to a passing 429 — it either
-- lands (row deleted) or ends 'failed' with the audio still here to retry.
create table if not exists voice_jobs (
  id              text primary key,
  audio_base64    text not null,
  mime_type       text not null,
  prefix_text     text not null default '',   -- anything typed in the box alongside the recording
  names           text not null default '[]', -- JSON snapshot of roster names, for spelling hints
  transcript      text,                        -- filled once Gemini succeeds; then only filing is retried
  status          text not null default 'queued' check (status in ('queued','done','failed')),
  attempts        integer not null default 0,
  next_attempt_at text not null,               -- worker picks the row up once now >= this
  last_error      text,
  created_at      text not null,
  updated_at      text not null
);
create index if not exists voice_jobs_due_idx on voice_jobs (status, next_attempt_at);

-- The assistant's output for a captured note: a ready-to-send draft or a
-- situation read + reply. Separate from cards (which are per-person signals from
-- the nightly sweep) because assists are per-note, carry a source-capture
-- lineage, and are produced the moment a note lands. The owner reviews them on
-- Suggestions with the same approve / copy / edit / skip affordances as cards.
create table if not exists assists (
  id          text primary key,
  capture_id  text,                       -- source note; lets a re-run replace, not duplicate
  -- ON DELETE SET NULL (not cascade): an assist belongs to its note, not the
  -- person. Deleting a loosely-matched person must never wipe a pending draft.
  person_id   text references people (id) on delete set null,  -- who it's about, when known
  kind        text not null check (kind in ('draft','advisory')),
  title       text not null,
  body        text not null,
  why         text,
  status      text not null default 'pending' check (status in ('pending','approved','skipped')),
  meta        text not null default '{}',
  created_at  text not null
);
create index if not exists assists_status_idx on assists (status, created_at desc);

-- Durable queue for the async assistant pass, mirroring voice_jobs: a note is
-- saved first (never lost), then a background worker classifies it and starts
-- the work, retrying with backoff if the AI call fails.
create table if not exists assist_jobs (
  id              text primary key,
  capture_id      text,
  note            text not null,
  crew_facts      text,                        -- JSON [{personId, factIds:[...]}]: what this note filed, for the Ledger member
  status          text not null default 'queued' check (status in ('queued','done','failed')),
  attempts        integer not null default 0,
  next_attempt_at text not null,
  last_error      text,
  created_at      text not null,
  updated_at      text not null
);
create index if not exists assist_jobs_due_idx on assist_jobs (status, next_attempt_at);

-- Pre-Read cache: one precomputed brief per person so opening a profile shows the
-- read, the insights, and the recommendations instantly, with no spinner. body is
-- the BriefContent as JSON. A background pass keeps it fresh; a fact change flips
-- 'stale' so that person is regenerated on the next pass (or a manual refresh).
-- source_fact_count records how many facts it was built from; generated_at is the
-- "updated Xd ago" stamp and the cutoff for the coarse "new since last prep" diff.
create table if not exists briefs (
  person_id         text primary key references people (id) on delete cascade,
  body              text not null,               -- BriefContent JSON
  source_fact_count integer not null default 0,
  stale             integer not null default 0,  -- 1 = a fact changed since; due for refresh
  generated_at      text not null,
  updated_at        text not null
);

-- Ledger Catch: a pending "possible contradiction" the per-note crew's Ledger
-- member found between a newly filed fact and one already on file for the same
-- person. The profile shows the two side by side with keep-new / keep-old /
-- keep-both. Both fact FKs cascade on delete: resolving as keep-new / keep-old
-- deletes the losing fact, which drops this row, so a resolved pair never
-- re-surfaces; keep-both instead marks the row resolved (a recorded dismissal).
create table if not exists fact_conflicts (
  id          text primary key,
  person_id   text not null references people (id) on delete cascade,
  new_fact_id text not null references facts (id) on delete cascade,
  old_fact_id text not null references facts (id) on delete cascade,
  reason      text,
  status      text not null default 'pending' check (status in ('pending','resolved')),
  resolution  text check (resolution in ('keep_new','keep_old','keep_both')),
  created_at  text not null,
  resolved_at text
);
create index if not exists fact_conflicts_person_idx on fact_conflicts (person_id, status);

-- Tiny key/value store for small bits of durable app state that don't warrant a
-- table. Today it holds 'last_nudge_date' so the morning Telegram nudge is
-- idempotent: a second fire on the same local date is a no-op.
create table if not exists kv (
  key        text primary key,
  value      text not null,
  updated_at text not null
);
`;
