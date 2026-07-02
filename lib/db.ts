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
  _db = d;
  return d;
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
  confidence real not null default 1,
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
`;
