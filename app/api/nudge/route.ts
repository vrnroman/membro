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

// The owner's local calendar date (YYYY-MM-DD). The VM runs UTC but the owner is
// in another timezone, so "due today/tomorrow" must be judged against the owner's
// day, not UTC. This matters because the timer fires at 22:00 UTC (06:00 the
// owner's morning), which is already "tomorrow" for the owner but still today in
// UTC. MEMBRO_NUDGE_TZ overrides the default (an IANA zone name).
function localToday(): string {
  const tz = process.env.MEMBRO_NUDGE_TZ || "Asia/Singapore";
  // en-CA renders as YYYY-MM-DD, the format the Scout compares by.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1" || params.get("dry") === "1";
  const force = params.get("force") === "1";

  const today = localToday();
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
