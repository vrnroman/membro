# Membro

**Your memory for the people you work with.** Capture a note, by typing, talking, or
photographing an email, and Membro files what matters under the right person, reminds you
before it's relevant, and drafts the prep so you walk into the next conversation already ready.

The name is *memory + brother*: a second brain for the names, facts, birthdays, and small
promises that are easy to forget.

## Why it's different

Most CRMs make you do the data entry, for a sales pipeline you didn't ask for. Membro does the
entry for you, and it never sells you anything.

- **It files itself.** You capture a raw note. The Scatter splits it across everyone mentioned
  and files the facts, dates, and promises. You do no data entry.
- **It works while you sleep.** The Night Shift drafts your nudges, intros, and prep briefs into
  the Stack. Nothing is ever sent for you. You approve, edit, and copy.
- **It runs on your machine, on your own Claude subscription.** No cloud database. No per-call
  API bill. Your relationships never leave your box.

## What it does

- **Capture.** Type a note, dictate one (your phone records the audio and the server transcribes
  it), or snap a photo of a screen or email. One note can mention several people.
- **The Scatter.** The AI splits a note across everyone in it and files facts, dates, birthdays,
  and the promises you made. A confidence gate files what it is sure of and quarantines what is
  ambiguous, instead of guessing.
- **People.** A searchable index (cold contacts dimmed) with a profile per person: facts, promises
  you owe, a next-meeting date, and a one-tap prep brief. Every fact has a delete control, and
  removing a fact also removes the Stack card it produced, so a bad voice transcription is easy to
  take back.
- **The Night Shift.** A small crew runs on demand. *Scout* finds what is ripe, *Builder* writes
  it, *Gate* ranks it. Finished cards land in **The Stack**: a "you owe someone the deck" nudge, a
  ready birthday note, a send-ready intro between two people who should meet. You approve, edit,
  copy, or skip. You never compose from scratch, and nothing is ever sent automatically. "Why this"
  shows the reasoning behind every card.

## How it works

**Stack:** Next.js (App Router) over a local SQLite file via better-sqlite3, with Tailwind and
shadcn/ui. It installs as a PWA, so it lives on your phone's home screen.

**Local-first data.** Everything is one SQLite file that only this server process touches. There
is no network database to expose. The file lives wherever `MEMBRO_DATA_DIR` points, and it runs in
WAL mode so reads never block on a write. Membro is single-user: there is no account system inside
the app, because you gate the whole thing to one identity with your own auth (see Self-hosting).

**The AI is behind a swappable adapter** (`lib/ai/index.ts`), so the same pipeline runs three ways:

| Engine | When it runs | Set with |
| --- | --- | --- |
| `claude -p` on your subscription | the default, when the Claude CLI is installed and logged in | `MEMBRO_AI=cli` |
| Anthropic API | when `ANTHROPIC_API_KEY` is set | `MEMBRO_AI=api` |
| Offline mock (deterministic) | no key and no CLI, for tests and CI | `MEMBRO_AI=mock` |

**Voice is the one exception, and it is narrow.** Recorded audio goes to Google Gemini for
transcription only (`lib/ai/transcribe.ts`). Claude still does all of the extraction, the cards,
and the briefs. Gemini is primed with the names already on file plus your house terms, so it spells
the people you work with correctly.

**What leaves your machine.** Note text goes to Claude (your subscription, or the Anthropic API if
you choose it). Voice audio goes to Gemini for transcription. Everything else, the whole database,
stays local.

**Observability (optional).** Every AI call is traced to [Langfuse](https://langfuse.com) with its
input, output, the engine used, and any error. It is wired once in `lib/ai/observe.ts` and turns on
only when the `LANGFUSE_*` vars are present.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000, uses claude -p automatically
```

The `claude -p` engine needs the Claude CLI installed and logged in. No key and no database are
needed to exercise the core logic:

```bash
npm test             # keyless end-to-end pipeline: capture, scatter, scout, build
npm run build        # production build check
```

## Self-hosting

Membro is single-user by design, so the security model is simple: run it on an always-on host and
put your own gate in front of it.

1. Run `npm run build`, then `npm start` (it serves on loopback).
2. Point a reverse proxy at it and require auth. Anything works: an OAuth proxy tied to your own
   identity, a VPN, or basic auth on your LAN. The app itself has no login, so this gate is what
   keeps your data yours.
3. Set `MEMBRO_DATA_DIR` to a persistent disk so the SQLite file survives restarts. Back it up like
   any other file.
4. Keep secrets (the Gemini key, any Langfuse keys) in the host environment, never in the repo.

## Environment

| Variable | Purpose |
| --- | --- |
| `MEMBRO_DATA_DIR` | directory for the SQLite file (defaults to `./data`) |
| `MEMBRO_AI` | `cli`, `api`, or `mock`: pick the engine (defaults to `cli`) |
| `MEMBRO_CLAUDE_BIN` / `MEMBRO_CLAUDE_MODEL` | path to the `claude` binary, and the model, for the `claude -p` engine |
| `ANTHROPIC_API_KEY` | optional: switches the engine to the Anthropic API |
| `MEMBRO_MODEL` | Anthropic model id for the API engine (defaults to `claude-opus-4-8`) |
| `GEMINI_API_KEY` | required for voice notes (transcription only) |
| `MEMBRO_GEMINI_MODEL` | Gemini model for transcription (defaults to `gemini-2.5-flash`) |
| `MEMBRO_HOUSE_TERMS` | comma-separated product or client words to spell correctly in transcription, kept out of the codebase |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | optional tracing |
| `MEMBRO_FORCE_MOCK=1` | force the offline engine |

Put these in the host environment or a local `.env` that is never committed. See `.env.example`.

## Key files

```
lib/db.ts               the SQLite connection and schema (people, facts, captures, cards)
lib/repo.ts             typed queries, including delete-a-fact-with-cascade
lib/ai/
  types.ts              schemas for extract / buildCard / brief
  index.ts              the engine switch (cli / api / mock)
  claude-cli.ts         your subscription via claude -p
  claude.ts             the Anthropic API engine
  mock.ts               the deterministic offline engine
  transcribe.ts         Gemini voice-to-text (transcription only)
  observe.ts            Langfuse tracing wrapper (engine-agnostic)
lib/nightshift/scout.ts the deterministic "what is ripe" logic (pure, unit-tested)
app/api/                capture, nightshift, brief, transcribe, and the people/facts/cards routes
components/membro/      the UI (capture box, people index, profile, stack, today, agenda)
```

## Principles

- **No auto-send, ever.** Cards are drafts you send yourself by copy. Hard rule.
- **A confidence gate, not a guess.** Ambiguous facts are quarantined, not filed wrong.
- **You can take it back.** Delete a fact and the action it caused goes with it.
- **Local and private.** The database never leaves your machine, and the AI runs on your own Claude
  subscription.
