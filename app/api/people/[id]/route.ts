import { NextResponse } from "next/server";
import {
  getPerson,
  listFactsForPerson,
  listPendingConflictsForPerson,
  getBrief,
  updatePerson,
  deletePerson,
} from "@/lib/repo";
import { parseBrief } from "@/lib/briefs/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = getPerson(id);
  if (!person) return NextResponse.json({ error: "not found" }, { status: 404 });
  // The cached Pre-Read rides along so the profile renders it with zero extra
  // round-trip. Null when none is cached yet; the profile then asks for one.
  const row = getBrief(id);
  const brief = row ? parseBrief(row.body) : null;
  const briefMeta = row ? { generatedAt: row.generated_at, stale: !!row.stale } : null;
  // Pending contradictions ride along too, so the profile can show the quiet
  // "possible contradiction" review without a second round-trip. Empty most of the
  // time; the profile renders nothing then.
  const conflicts = listPendingConflictsForPerson(id);
  return NextResponse.json({ person, facts: listFactsForPerson(id), brief, briefMeta, conflicts });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = await req.json().catch(() => ({}));
  updatePerson(id, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deletePerson(id);
  return NextResponse.json({ ok: true });
}
