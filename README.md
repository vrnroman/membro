# Membro

**Your memory for the people you work with.** Capture a note — by typing, dictating, or
photographing an email or screen — and Membro parses it, files what matters under the right
person, reminds you before it's relevant, and drafts the prep so you walk into the next
conversation already ready.

The name is *memory + brother*: a second brain for names, facts, birthdays, and the small
promises that are easy to forget.

> **Status:** v1 is built and verified. It can run on Supabase, or fully **local-first**
> (SQLite) with no cloud slot. The AI runs on your Claude subscription via `claude -p`, so
> there are no per-call API charges.

---

## What it does

- **Capture** — type, dictate (desktop mic or your phone keyboard's mic), or snap a photo of
  a screen or email. One note can mention several people.
- **The Scatter** — the AI splits a note across everyone in it and files facts, dates,
  birthdays, and the promises you made. A confidence gate files what it's sure of and
  quarantines what's ambiguous instead of guessing.
- **People** — a searchable index (cold contacts dimmed) with a profile per person: facts,
  promises you owe, a next-meeting date, and a one-tap **prep brief**.
- **The Night Shift** — a small crew runs on demand: *Scout* finds what's ripe, *Builder*
  writes it, *Gate* ranks it. Finished cards land in **The Stack**: a "you owe Tom the deck"
  nudge, a ready-to-send birthday note, a send-ready intro between two people who should meet.
  You approve, edit, copy, or skip — you never compose from scratch, and **nothing is ever
  sent automatically**. "Why this" shows the reasoning.

---

## How it works

**Stack:** Next.js (App Router, Cache Components) · Supabase (Postgres + auth + RLS) ·
Vercel (hosting) · Tailwind + shadcn/ui · installable PWA.

**The AI is behind a swappable adapter** (`lib/ai/index.ts`) so the same pipeline runs three ways:

| Engine | When it's used | Set explicitly with |
| --- | --- | --- |
| `claude -p` (your subscription) | running locally — the default | `MEMBRO_AI=cli` |
| Anthropic API | when `ANTHROPIC_API_KEY` is set | `MEMBRO_AI=api` |
| Offline mock (deterministic) | on a stock Vercel deploy with no key | `MEMBRO_AI=mock` |

The `claude -p` path only works where the Claude CLI is installed and logged in (your own
machine), not a stock Vercel serverless function.

**Observability:** every AI call (`extract` / `buildCard` / `brief`, in any engine) is traced
to [Langfuse](https://langfuse.com) as a generation with its input, output, the engine used,
and any error. It's wired once in `lib/ai/observe.ts` and turns on automatically when the
`LANGFUSE_*` env vars are present — a no-op when they're absent.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:3000 — uses `claude -p` automatically
```

To run the full UI on Supabase you need a Supabase project and its env vars in `.env.local`;
alternatively run it local-first against SQLite (no cloud project required).

No key or database is needed to exercise the core logic:

```bash
npm test               # keyless end-to-end pipeline test (capture → scatter → scout → build)
npm run build          # production build check
npm run test:langfuse  # send a few traces and confirm they land (needs LANGFUSE_* vars)
```

---

## Environment

Put these in `.env.local` (gitignored). Keep a backup of the secret values somewhere safe
outside the repo — a password manager, or a local file that is never committed.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/publishable key |
| `ANTHROPIC_API_KEY` | optional — forces the Anthropic API engine |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse tracing (region `https://jp.cloud.langfuse.com`) |
| `MEMBRO_AI` | `cli` \| `api` \| `mock` — override the engine choice |
| `MEMBRO_FORCE_MOCK=1` | force the offline engine |
| `MEMBRO_MODEL` | Anthropic model id (default `claude-opus-4-8`) |
| `MEMBRO_CLAUDE_BIN` / `MEMBRO_CLAUDE_MODEL` | path to the `claude` binary / model for the `claude -p` engine |

The three `LANGFUSE_*` vars are also set on the Vercel `membro` project (encrypted, all
environments); they take effect on the next deploy.

---

## Key files

```
lib/ai/                 the AI contract
  types.ts              schemas for extract / buildCard / brief
  index.ts              the engine switch (cli / api / mock)
  claude-cli.ts         your subscription via `claude -p`
  claude.ts             the Anthropic API engine
  mock.ts               deterministic offline engine
  observe.ts            Langfuse tracing wrapper (engine-agnostic)
lib/nightshift/scout.ts the deterministic "what is ripe" logic (pure, unit-tested)
lib/observability/      Langfuse OpenTelemetry setup
lib/membro/types.ts     shared UI row/card types
app/api/                capture · nightshift · brief — the server routes
components/membro/       the UI (capture box, people index, profile, stack, today, agenda)
supabase/migrations/    schema + row-level security
```

---

## Principles

- **No auto-send, ever.** Cards are drafts you send yourself by copy. Hard rule.
- **A confidence gate, not a guess.** Ambiguous facts are quarantined, not filed wrong.
- **Free to run.** Everything is on free tiers; the AI runs on your existing Claude subscription.
