import { NextResponse } from "next/server";
import { listCapturesWithFiled } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Notes inbox: every captured note (typed, voice, or photo) as text, newest
// first, with a summary of what it put on file. Editing one and saving reprocesses
// it through PATCH /api/captures/[id].
export async function GET() {
  return NextResponse.json({ captures: listCapturesWithFiled(200) });
}
