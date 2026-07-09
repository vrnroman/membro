import { NextResponse } from "next/server";
import { fileNote } from "@/lib/capture";
import type { CaptureImage } from "@/lib/ai/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Accept a list of photos (one note can be several pages of a long email), and
// still take a legacy single { imageBase64, imageMediaType } from any older client.
// Anything without valid base64 data is dropped so a stray entry can't 500.
function readImages(body: {
  images?: unknown;
  imageBase64?: unknown;
  imageMediaType?: unknown;
}): CaptureImage[] {
  const raw = Array.isArray(body.images)
    ? body.images
    : typeof body.imageBase64 === "string"
      ? [{ base64: body.imageBase64, mediaType: body.imageMediaType }]
      : [];
  return raw
    .filter((i): i is { base64: string; mediaType?: unknown } => !!i && typeof i.base64 === "string" && i.base64.length > 0)
    .map((i) => ({ base64: i.base64, mediaType: typeof i.mediaType === "string" ? i.mediaType : undefined }));
}

// Typed / photo capture. Voice goes through /api/voice, which transcribes first
// and then files through this same fileNote() core.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { text = "", sourceType = "text" } = body;
  const images = readImages(body);
  if (!text && images.length === 0) return NextResponse.json({ error: "nothing to capture" }, { status: 400 });

  try {
    const result = await fileNote({ text, sourceType, images });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: `extraction failed: ${(e as Error).message}` }, { status: 502 });
  }
}
