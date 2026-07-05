import { NextResponse } from "next/server";
import { generateBriefFor } from "@/lib/briefs/generate";
import { getBrief } from "@/lib/repo";
import { getAdapter } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Regenerate and cache a person's Pre-Read, then return it. Used by the manual
// refresh button and by the profile's first-open path (when no brief is cached
// yet), so a person is never left without a read. The instant render on open
// reads the cache directly via /api/people/[id]; this route is the recompute.
export async function POST(req: Request) {
  const { personId } = await req.json().catch(() => ({}));
  if (!personId) return NextResponse.json({ error: "personId required" }, { status: 400 });

  try {
    const brief = await generateBriefFor(personId);
    if (!brief) return NextResponse.json({ error: "person not found" }, { status: 404 });
    const row = getBrief(personId);
    return NextResponse.json({
      brief,
      generatedAt: row?.generated_at ?? null,
      adapter: getAdapter().label,
    });
  } catch (e) {
    return NextResponse.json({ error: `brief failed: ${(e as Error).message}` }, { status: 502 });
  }
}
