import { NextResponse } from "next/server";
import { fileNote } from "@/lib/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Typed / photo capture. Voice goes through /api/voice, which transcribes first
// and then files through this same fileNote() core.
export async function POST(req: Request) {
  const { text = "", sourceType = "text", imageBase64, imageMediaType } = await req
    .json()
    .catch(() => ({}));
  if (!text && !imageBase64) return NextResponse.json({ error: "nothing to capture" }, { status: 400 });

  try {
    const result = await fileNote({ text, sourceType, imageBase64, imageMediaType });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `extraction failed: ${(e as Error).message}` }, { status: 502 });
  }
}
