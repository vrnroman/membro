import { NextResponse } from "next/server";
import { insertFact, touchPerson } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add a note by hand from a person's profile. Adding a fact counts as contact,
// so we bump last_contact_at too (this is what the old client did in two calls).
export async function POST(req: Request) {
  const { person_id, kind = "fact", content, due_at } = await req.json().catch(() => ({}));
  if (!person_id || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "person_id and content required" }, { status: 400 });
  }
  insertFact({ person_id, kind, content: content.trim(), due_at: due_at ?? null });
  touchPerson(person_id);
  return NextResponse.json({ ok: true });
}
