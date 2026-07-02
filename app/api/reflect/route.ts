import { NextResponse } from "next/server";
import { listFactContents, getOrCreateSelf } from "@/lib/repo";
import { getAdapter } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// On-demand diary reflection over the owner's own recent entries. Read-only.
export async function POST() {
  const self = getOrCreateSelf();
  const entries = listFactContents(self.id);
  if (entries.length === 0) {
    return NextResponse.json({ reflection: "", empty: true });
  }
  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();
  try {
    const reflection = await adapter.reflect(entries.slice(0, 30), today);
    return NextResponse.json({ reflection, adapter: adapter.label });
  } catch (e) {
    return NextResponse.json({ error: `reflect failed: ${(e as Error).message}` }, { status: 502 });
  }
}
