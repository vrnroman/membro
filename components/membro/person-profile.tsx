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
  owed_by: "me" | "them";
  created_at: string;
};

type ConflictFact = { id: string; content: string; created_at: string };
type Conflict = { id: string; reason: string | null; newFact: ConflictFact; oldFact: ConflictFact };

export function PersonProfile({ personId }: { personId: string }) {
  const router = useRouter();
  const [person, setPerson] = useState<PersonRow | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState<BriefContent | null>(null);
  const [briefMeta, setBriefMeta] = useState<{ generatedAt: string | null; stale: boolean } | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  // Out of quota is its own state, not an error. It gets a calm line and a "back
  // at" instead of the red bug text, because it is neither a bug nor permanent.
  const [quota, setQuota] = useState<{ pausedUntil: string | null } | null>(null);
  // Engine broken (read-only disk, dead login): also calm, but with a named cause
  // and no "back at" (there is no reset — a human has to fix it).
  const [engine, setEngine] = useState<{ cause: string; action: string } | null>(null);
  // True when the read on screen is the deterministic half only (no model).
  const [partial, setPartial] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [copied, setCopied] = useState(false);
  // First-open guard: auto-build a Pre-Read once when none is cached, without
  // re-firing on every reload (a note edit reloads but only flags it stale).
  const autoTried = useRef(false);

  async function load() {
    // Clear the per-brief states before adopting another person's data. They are
    // about the brief on screen, not about the app, so leaving them set would carry
    // the last person's "notes only" stamp and quota line onto the next one and
    // suppress their real age stamp.
    setQuota(null);
    setEngine(null);
    setPartial(false);
    setBriefError(null);
    const res = await fetch(`/api/people/${personId}`, { cache: "no-store" });
    if (!res.ok) {
      setPerson(null);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setPerson((data.person ?? null) as PersonRow | null);
    setFacts((data.facts ?? []) as Fact[]);
    setConflicts((data.conflicts ?? []) as Conflict[]);
    setBrief((data.brief ?? null) as BriefContent | null);
    setBriefMeta((data.briefMeta ?? null) as { generatedAt: string | null; stale: boolean } | null);
    // Show the AI-down state on open, not only after a manual refresh. The cached
    // brief (if any) stays on screen; this just adds the calm "out of quota / engine
    // down" line so the profile is honest the instant it opens during an outage.
    if (data.quota) setQuota({ pausedUntil: data.quota.pausedUntil ?? null });
    if (data.engine) setEngine({ cause: data.engine.cause, action: data.engine.action });
    setLoading(false);
    // Never-empty on first open: if nothing is cached yet, build one now. This still
    // fires during an outage on purpose — the breaker makes the call an instant,
    // spawn-free throw and the POST answers 200 with the same calm state, so there is
    // no cost and no error. Gating it on data.quota/data.engine was wrong: a stale
    // engine flag (recorded but already recovered) would then permanently suppress
    // the first-open build.
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

      // The engine is parked (out of credit) or broken (disk/login). Either way say
      // so plainly and keep whatever is already on screen: a real cached read beats
      // the deterministic half, and replacing it would lose information for no reason.
      if (data.quota || data.engine) {
        // Set BOTH, so a state that is no longer present is cleared. Otherwise a
        // stale quota banner from an earlier refresh would linger and mask a newly
        // broken engine (the engine line is gated on !quota), telling the owner to
        // wait for an automatic recovery that will never come.
        setQuota(data.quota ? { pausedUntil: data.quota.pausedUntil ?? null } : null);
        setEngine(data.engine ? { cause: data.engine.cause, action: data.engine.action } : null);
        if (!brief && data.brief) {
          setBrief(data.brief as BriefContent);
          setPartial(true);
          setBriefMeta({ generatedAt: null, stale: false });
        }
        return;
      }

      setQuota(null);
      setEngine(null);
      setPartial(false);
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
  // Resolve a possible contradiction. Optimistically drop the card so it dissolves
  // at once, then reload so a kept/removed fact is reflected everywhere.
  async function pickConflict(conflictId: string, resolution: "keep_new" | "keep_old" | "keep_both") {
    setResolving(conflictId);
    try {
      await fetch(`/api/conflicts/${conflictId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      setConflicts((cs) => cs.filter((c) => c.id !== conflictId));
      load();
    } finally {
      setResolving(null);
    }
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
            {/* Only stamp an age on a real generated read. A deterministic partial
                has no generation time, and borrowing one would be the same quiet
                lie as the old "refreshed 2 brief(s)". */}
            {briefMeta?.generatedAt && !partial && !briefing && (
              <span className="text-xs text-muted-foreground">{agoLabel(briefMeta.generatedAt)}</span>
            )}
            {partial && !briefing && <span className="text-xs text-muted-foreground">notes only</span>}
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

        {/* Waiting is not breaking. A quota pause gets a quiet line and a time,
            never the red bug text: the app is fine, it is just out of credit. */}
        {quota && !briefing && (
          <p className="mb-3 text-xs text-muted-foreground">
            {partial
              ? "The counted lines below are all Membro can write without AI. "
              : "Kept the last read, this could not refresh. "}
            AI is out of quota{quota.pausedUntil ? `, back ${resetLabel(quota.pausedUntil)}` : ", it will retry on its own"}.
          </p>
        )}

        {/* A broken engine is also not a bug in THIS brief: a named cause, where to
            look, no "back at" (a human has to fix it), and no alarming red. */}
        {engine && !quota && !briefing && (
          <p className="mb-3 text-xs text-muted-foreground">
            {partial
              ? "The counted lines below are all Membro can write without AI. "
              : "Kept the last read, this could not refresh. "}
            AI is down, looks like {engine.cause}. To fix: {engine.action}.
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

      {conflicts.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            This may have changed
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Two notes about {person.name.split(" ")[0]} look like they might not both still be true. Keep whichever
            one is right, or keep both.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {conflicts.map((c) => (
              <ConflictCard key={c.id} conflict={c} busy={resolving === c.id} onPick={(r) => pickConflict(c.id, r)} />
            ))}
          </div>
        </div>
      )}

      {commitments.length > 0 && (
        <Section title="Promises">
          {commitments.map((f) => (
            <div key={f.id} className="flex items-start gap-2 py-1 text-sm">
              <input type="checkbox" checked={f.status === "done"} onChange={() => toggleDone(f)} className="mt-1" />
              <span className={f.status === "done" ? "text-muted-foreground line-through" : ""}>
                {f.content}
                <span className="ml-2 text-xs text-muted-foreground">{f.owed_by === "them" ? "they owe you" : "you owe"}</span>
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

// One "possible contradiction": the two facts side by side (newer / older), with
// a one-tap Keep newer / Keep older / Keep both. Quiet on purpose — no red, no
// alarm; a contradiction is a shrug, not a fault.
function ConflictCard({
  conflict,
  busy,
  onPick,
}: {
  conflict: Conflict;
  busy: boolean;
  onPick: (r: "keep_new" | "keep_old" | "keep_both") => void;
}) {
  return (
    <div className="rounded-xl border bg-background p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <FactSide label="Newer" fact={conflict.newFact} />
        <FactSide label="Older" fact={conflict.oldFact} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="rounded-full" disabled={busy} onClick={() => onPick("keep_new")}>
          Keep newer
        </Button>
        <Button size="sm" variant="outline" className="rounded-full" disabled={busy} onClick={() => onPick("keep_old")}>
          Keep older
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full text-muted-foreground"
          disabled={busy}
          onClick={() => onPick("keep_both")}
        >
          Keep both
        </Button>
      </div>
    </div>
  );
}

function FactSide({ label, fact }: { label: string; fact: ConflictFact }) {
  return (
    <div className="rounded-lg bg-muted/50 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} · {fact.created_at.slice(0, 10)}
      </div>
      <p className="mt-0.5 text-sm">{fact.content}</p>
    </div>
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

// When the AI comes back, in the owner's own timezone. The CLI states the reset in
// UTC, which is not the clock he is looking at, so translate rather than parrot it.
function resetLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "soon";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `at ${time}` : `${at.toLocaleDateString(undefined, { weekday: "short" })} at ${time}`;
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
