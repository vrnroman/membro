import { NextResponse } from "next/server";
import { updateAssist } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Approve / skip / edit an assist. Mirrors /api/cards/[id]; nothing is ever sent
// on the owner's behalf, this only changes local status/body.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json().catch(() => ({}));
  updateAssist(id, { status: patch.status, body: patch.body });
  return NextResponse.json({ ok: true });
}
