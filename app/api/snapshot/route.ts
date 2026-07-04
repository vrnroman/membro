import { NextResponse } from "next/server";
import { listPeople, listFacts, listCards, listPendingAssists } from "@/lib/repo";
import { localToday } from "@/lib/today";

// One round-trip for the dashboard: everything Today and People need to render.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    // Owner-local date, computed server-side, so every surface (the Today list,
    // its header, and the Telegram nudge) agrees on which day "today" is.
    today: localToday(),
    people: listPeople(),
    facts: listFacts(),
    cards: listCards(),
    assists: listPendingAssists(),
  });
}
