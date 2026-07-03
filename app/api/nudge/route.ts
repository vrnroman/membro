import { NextResponse } from "next/server";
import { listPeople, listFacts, getKv, setKv } from "@/lib/repo";
import { dueNudges, formatNudge } from "@/lib/nightshift/nudge";
import { sendTelegramMessage } from "@/lib/nightshift/telegram";

// The morning nudge. A systemd timer on the VM POSTs here once a day; the route
// computes what is due today or tomorrow and, only if something is, sends one
// Telegram line. Nothing due -> nothing sent. Reuses the deterministic Scout, so
// no AI and no cost. Query flags:
//   ?dryRun=1  compute and return the message, send nothing (safe to poke)
//   ?force=1   send even if one already went out today (bypass the daily guard)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LAST_SENT_KEY = "last_nudge_date";

// The local calendar date the timer fires on (YYYY-MM-DD), in the VM's own
// timezone. The Scout compares by calendar date, so "due today/tomorrow" is
// judged against the same day the owner is living, not UTC.
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1" || params.get("dry") === "1";
  const force = params.get("force") === "1";

  const today = localToday();
  const items = dueNudges(listPeople(), listFacts(), today);
  const message = formatNudge(items);

  // Silence is the default: nothing due today or tomorrow means no message at all.
  if (!message) {
    return NextResponse.json({ sent: false, reason: "nothing-due", today, count: 0 });
  }

  if (dryRun) {
    return NextResponse.json({ sent: false, reason: "dry-run", today, count: items.length, message });
  }

  // Same-day idempotency: a double fire on the same local date is a no-op, so the
  // timer (and any stray retrigger) can never double-send.
  if (!force && getKv(LAST_SENT_KEY) === today) {
    return NextResponse.json({ sent: false, reason: "already-sent-today", today, count: items.length });
  }

  try {
    const res = await sendTelegramMessage(message);
    // Record the day ONLY after a confirmed send. A transient Telegram error must
    // not burn the day and suppress the real nudge on a later retry.
    setKv(LAST_SENT_KEY, today);
    return NextResponse.json({ sent: true, today, count: items.length, messageId: res.messageId, message });
  } catch (e) {
    return NextResponse.json(
      { sent: false, reason: "send-failed", today, count: items.length, error: (e as Error).message },
      { status: 502 },
    );
  }
}
