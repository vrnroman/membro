import { NextResponse } from "next/server";
import { listPeople, listFacts, listCards, listPendingAssists } from "@/lib/repo";

// One round-trip for the dashboard: everything Today and People need to render.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    people: listPeople(),
    facts: listFacts(),
    cards: listCards(),
    assists: listPendingAssists(),
  });
}
