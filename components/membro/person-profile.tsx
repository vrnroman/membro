"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonRow } from "@/lib/membro/types";
import type { BriefContent } from "@/lib/ai/types";
import { Loader2, Copy, Trash2, RefreshCw, X } from "lucide-react";

type Fact = {
  id: string;
  kind: "fact" | "date" | "commitment" | "preference";
  content: string;
  due_at: string | null;
  status: "open" | "done";
  created_at: string;
};

export function PersonProfile({ personId }: { personId: string }) {
  const router = useRouter();
  const [person, setPerson] = useState<PersonRow | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState<BriefContent | null>(null);
  const [briefMeta, setBriefMeta] = useState<{ generatedAt: string | null; stale: boolean } | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [newNote, setNewNote] = useState("");
  const [copied, setCopied] = useState(false);
  // First-open guard: auto-build a Pre-Read once when none is cached, without
  // re-firing on every reload (a note edit reloads but only flags it stale).
  const autoTried = useRef(false);

  async function load() {
    const res = await fetch(`/api/people/${personId}`, { cache: "no-store" });
    if (!res.ok) {
      setPerson(null);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setPerson((data.person ?? null) as PersonRow | null);
    setFacts((data.facts ?? []) as Fact[]);
    setBrief((data.brief ?? null) as BriefContent | null);
    setBriefMeta((data.briefMeta ?? null) as { generatedAt: string | null; stale: boolean } | null);
    setLoading(false);
    // Never-empty on first open: if nothing is cached yet, build one now.
    if (!data.brief && !autoTried.current) {
      autoTried.current = true;
      void generateBrief();
    }
  }

  useEffect(() => {
    autoTried.current = false;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  async function generateBrief() {
    setBriefing(true);
    setBriefError(null);
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "brief failed");
      setBrief(data.brief as BriefContent);
      setBriefMeta({ generatedAt: data.generatedAt ?? null, stale: false });
    } catch (e) {
      setBriefError((e as Error).message);
    } finally {
      setBriefing(false);
    }
  }

  function briefToText(b: BriefContent): string {
    return [b.read, "", "Insights:", ...b.insights.map((i) => `- ${i}`), "", "Recommendations:", ...b.recommendations.map((r) => `- ${r}`)].join("\n");
  }

  async function setMeeting(value: string) {
    const iso = value ? new Date(`${value}T09:00:00`).toISOString() : null;
    await fetch(`/api/people/${personId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next_meeting_at: iso }),
    });
    load();
  }
  async function toggleDone(f: Fact) {
    await fetch(`/api/facts/${f.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: f.status === "open" ? "done" : "open" }),
    });
    load();
  }
  async function addNote() {
    if (!newNote.trim()) return;
    await fetch("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId, kind: "fact", content: newNote.trim() }),
    });
    setNewNote("");
    load();
  }
  async function deleteFact(id: string) {
    await fetch(`/api/facts/${id}`, { method: "DELETE" });
    load();
  }
  async function deletePerson() {
    await fetch(`/api/people/${personId}`, { method: "DELETE" });
    router.push("/protected/people");
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!person) return <p className="text-sm text-muted-foreground">Not found.</p>;

  const commitments = facts.filter((f) => f.kind === "commitment");
  const dates = facts.filter((f) => f.kind === "date");
  const notes = facts.filter((f) => f.kind === "fact" || f.kind === "preference");
  const meetingValue = person.next_meeting_at ? person.next_meeting_at.slice(0, 10) : "";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} className="text-3xl">
          {person.name}
        </h1>
        {(person.role || person.company) && (
          <p className="text-muted-foreground">{[person.role, person.company].filter(Boolean).join(" · ")}</p>
        )}
        {person.blurb && <p className="mt-1 text-sm">{person.blurb}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Next meeting
          <input
            type="date"
            value={meetingValue}
            onChange={(e) => setMeeting(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <Button variant="ghost" size="sm" className="ml-auto rounded-full text-muted-foreground" onClick={deletePerson}>
          <Trash2 className="mr-1 h-4 w-4" /> Delete
        </Button>
      </div>

      <div className="rounded-2xl border bg-muted/50 p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">Pre-Read</span>
            {briefMeta?.generatedAt && !briefing && (
              <span className="text-xs text-muted-foreground">{agoLabel(briefMeta.generatedAt)}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {brief && (
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                onClick={() => {
                  navigator.clipboard.writeText(briefToText(brief));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy className="mr-1 h-4 w-4" /> {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="rounded-full" onClick={generateBrief} disabled={briefing}>
              <RefreshCw className={`mr-1 h-4 w-4 ${briefing ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>

        {briefMeta?.stale && brief && !briefing && (
          <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
            Facts changed since this was written. Refresh for the current read.
          </p>
        )}

        {/* A refresh that fails while a brief is already on screen must still be
            visible, or the owner reads a stale brief believing it just refreshed. */}
        {briefError && brief && !briefing && (
          <p className="mb-3 text-xs text-red-600 dark:text-red-400">Could not refresh: {briefError}</p>
        )}

        {brief ? (
          <div className="flex flex-col gap-3">
            <p className="whitespace-pre-line text-sm leading-relaxed">{brief.read}</p>
            {brief.insights.length > 0 && <BriefBlock title="Insights" items={brief.insights} />}
            {brief.recommendations.length > 0 && <BriefBlock title="Recommendations" items={brief.recommendations} />}
          </div>
        ) : briefing ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparing your read…
          </p>
        ) : briefError ? (
          <p className="text-sm text-muted-foreground">Could not build a read: {briefError}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No read yet.</p>
        )}
      </div>

      {commitments.length > 0 && (
        <Section title="Promises">
          {commitments.map((f) => (
            <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <input type="checkbox" checked={f.status === "done"} onChange={() => toggleDone(f)} className="mt-1" />
              <span className={f.status === "done" ? "text-muted-foreground line-through" : ""}>
                {f.content}
                {f.due_at && <span className="ml-2 text-xs text-muted-foreground">due {f.due_at.slice(0, 10)}</span>}
              </span>
              <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove promise" />
            </div>
          ))}
        </Section>
      )}

      {(person.birthday || dates.length > 0) && (
        <Section title="Dates">
          {person.birthday && <p className="py-1 text-sm">Birthday: {person.birthday.slice(5)}</p>}
          {dates.map((f) => (
            <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <span>
                {f.content}
                {f.due_at && <span className="ml-2 text-xs text-muted-foreground">{f.due_at.slice(0, 10)}</span>}
              </span>
              <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove date" />
            </div>
          ))}
        </Section>
      )}

      <Section title="Notes">
        {notes.length === 0 && <p className="py-1 text-sm text-muted-foreground">Nothing yet.</p>}
        {notes.map((f) => (
          <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
            <span>{f.content}</span>
            <DeleteControl onDelete={() => deleteFact(f.id)} label="Remove note" />
          </div>
        ))}
        <div className="mt-2 flex gap-2">
          <Input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Add a note…"
            onKeyDown={(e) => e.key === "Enter" && addNote()}
          />
          <Button onClick={addNote} variant="outline" className="rounded-full">
            Add
          </Button>
        </div>
      </Section>
    </div>
  );
}

// Touch-friendly, always-visible delete with an inline two-step confirm:
// first tap arms ("Confirm"), second tap deletes. Tapping anywhere else
// (blur) disarms it — calm and safe, no modal, hard to trigger by accident.
function DeleteControl({ onDelete, label = "Remove" }: { onDelete: () => void; label?: string }) {
  const [armed, setArmed] = useState(false);
  // Belt-and-suspenders auto-revert: iOS Safari often won't hold focus on a
  // <button>, so onBlur can't be relied on alone — also disarm on a timer.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <button
        type="button"
        autoFocus
        onClick={() => {
          setArmed(false);
          onDelete();
        }}
        onBlur={() => setArmed(false)}
        className="ml-auto shrink-0 rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-300"
      >
        Confirm remove
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      aria-label={label}
      title={label}
      className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-red-500"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}

// One labelled block of the Pre-Read (Insights or Recommendations), as a short
// scannable bulleted list.
function BriefBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

// "updated Xd ago" stamp from an ISO timestamp; empty for a missing/bad value.
function agoLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "updated today";
  if (days === 1) return "updated yesterday";
  return `updated ${days} days ago`;
}
