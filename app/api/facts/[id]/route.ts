import { NextResponse } from "next/server";
import { updateFact, deleteFact } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Patch a fact: mark done (Today + ledger), snooze (new due_at), or flip a
// commitment's direction (me<->them, the Ledger's one-tap correction). Any subset;
// each field is validated so a bad value never reaches the DB.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const patch: { status?: "open" | "done"; due_at?: string | null; owed_by?: "me" | "them" } = {};

  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "done") {
      return NextResponse.json({ error: "status must be open|done" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body.due_at !== undefined) {
    if (body.due_at !== null && (typeof body.due_at !== "string" || Number.isNaN(Date.parse(body.due_at)))) {
      return NextResponse.json({ error: "due_at must be an ISO datetime or null" }, { status: 400 });
    }
    patch.due_at = body.due_at;
  }
  if (body.owed_by !== undefined) {
    if (body.owed_by !== "me" && body.owed_by !== "them") {
      return NextResponse.json({ error: "owed_by must be me|them" }, { status: 400 });
    }
    patch.owed_by = body.owed_by;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  updateFact(id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteFact(id);
  return NextResponse.json({ ok: true });
}
