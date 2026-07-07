import { NextResponse } from "next/server";
import { getConflict, resolveConflict, deleteFact } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve a "possible contradiction" (Ledger Catch). Three picks, none of which
// sends anything anywhere, each a single atomic write:
//   keep_new  -> the old fact is no longer true: delete it (its ON DELETE CASCADE
//                drops this conflict row too), the new one stands.
//   keep_old  -> the new fact was the mistake: delete it, nothing else changes.
//   keep_both -> not really a contradiction: keep both facts, just mark the row
//                resolved so it never re-raises.
// For keep_new / keep_old we delete ONLY (the cascade removes the row), so there is
// no separate resolve+delete pair to leave half-applied.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const resolution = body.resolution;
  if (resolution !== "keep_new" && resolution !== "keep_old" && resolution !== "keep_both") {
    return NextResponse.json({ error: "resolution must be keep_new|keep_old|keep_both" }, { status: 400 });
  }

  const conflict = getConflict(id);
  if (!conflict) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conflict.status === "resolved") return NextResponse.json({ ok: true }); // idempotent

  if (resolution === "keep_new") deleteFact(conflict.old_fact_id);
  else if (resolution === "keep_old") deleteFact(conflict.new_fact_id);
  else resolveConflict(id, "keep_both"); // both facts stay; dismiss the flag

  return NextResponse.json({ ok: true });
}
