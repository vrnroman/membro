import { NextResponse } from "next/server";
import { getPerson, listFactContents } from "@/lib/repo";
import { getAdapter } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const { personId } = await req.json().catch(() => ({}));
  if (!personId) return NextResponse.json({ error: "personId required" }, { status: 400 });

  const person = getPerson(personId);
  if (!person) return NextResponse.json({ error: "person not found" }, { status: 404 });

  const facts = listFactContents(personId);

  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();
  try {
    const brief = await adapter.brief(person, facts, today);
    return NextResponse.json({ brief, adapter: adapter.label });
  } catch (e) {
    return NextResponse.json({ error: `brief failed: ${(e as Error).message}` }, { status: 502 });
  }
}
