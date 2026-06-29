import { NextResponse } from "next/server";
import { updateCard } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json().catch(() => ({}));
  updateCard(id, { status: patch.status, body: patch.body });
  return NextResponse.json({ ok: true });
}
