import { NextResponse } from "next/server";
import { listPeople, listFacts, getKv, setKv } from "@/lib/repo";
import { dueNudges, formatNudge } from "@/lib/nightshift/nudge";
import { sendTelegramMessage, TelegramSendError } from "@/lib/nightshift/telegram";
import { localToday } from "@/lib/today";

// The morning nudge. A systemd timer on the VM POSTs here once a day; the route
// computes what is due today or tomorrow and, only if something is, sends one
// Telegram message. Nothing due -> nothing sent (unless the all-clear is on).
// Reuses the deterministic Scout, so no AI and no cost. Query flags:
//   ?dryRun=1  compute and return the message, send nothing (safe to poke)
//   ?force=1   send even if one already went out today, and do NOT record the
//              day, so a manual test never suppresses the real scheduled nudge
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAST_SENT_KEY = "last_nudge_date";
const MAX_RETRIES = 2; // transient failures only; total attempts = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry only transient failures (network, Telegram 5xx). A 4xx (bad token, chat
// not found, message too long) is permanent, so it fails fast without burning
// the retry budget.
async function sendWithRetry(message: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendTelegramMessage(message);
    } catch (e) {
      const retryable = e instanceof TelegramSendError ? e.retryable : true;
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      await sleep(1000 * (attempt + 1)); // 1s, then 2s
    }
  }
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1" || params.get("dry") === "1";
  const force = params.get("force") === "1";

  const today = localToday(); // owner-local; never throws (a bad MEMBRO_TZ falls back)
  const items = dueNudges(listPeople(), listFacts(), today);
  // Quiet days still send an all-clear by default, so the once-a-day nudge
  // visibly stays alive; set MEMBRO_NUDGE_SILENT_WHEN_EMPTY=1 to go silent on
  // empty days once it has earned trust.
  const notifyWhenEmpty = process.env.MEMBRO_NUDGE_SILENT_WHEN_EMPTY !== "1";
  const message = formatNudge(items, { notifyWhenEmpty });

  // Only reached when silent-on-empty is on AND nothing is due: send nothing.
  if (!message) {
    return NextResponse.json({ sent: false, reason: "nothing-due", today, count: 0 });
  }

  if (dryRun) {
    return NextResponse.json({ sent: false, reason: "dry-run", today, count: items.length, message });
  }

  // Same-day idempotency: a normal double fire is a no-op. `force` bypasses it.
  if (!force && getKv(LAST_SENT_KEY) === today) {
    return NextResponse.json({ sent: false, reason: "already-sent-today", today, count: items.length });
  }

  let res;
  try {
    res = await sendWithRetry(message);
  } catch (e) {
    return NextResponse.json(
      { sent: false, reason: "send-failed", today, count: items.length, error: (e as Error).message },
      { status: 502 },
    );
  }

  // Record the day ONLY after a confirmed send, and NOT for a forced manual test
  // (so a test never suppresses the real scheduled nudge). A bookkeeping failure
  // here must not report the already-delivered message as failed (which would
  // prompt an operator retry double-send): log and still return success.
  if (!force) {
    try {
      setKv(LAST_SENT_KEY, today);
    } catch (e) {
      console.error(`[nudge] sent but could not record last_nudge_date: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ sent: true, today, count: items.length, messageId: res.messageId, message });
}
