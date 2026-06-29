import { NextResponse } from "next/server";
import { updateFactStatus, deleteFact } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status } = await req.json().catch(() => ({}));
  if (status !== "open" && status !== "done") {
    return NextResponse.json({ error: "status must be open|done" }, { status: 400 });
  }
  updateFactStatus(id, status);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteFact(id);
  return NextResponse.json({ ok: true });
}
