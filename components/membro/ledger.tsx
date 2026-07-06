"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Stack, type StackItem } from "./stack";
import { buildLedger, type OweItem, type OwedBy, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { dueTone } from "@/lib/utils";
import { Circle, Loader2, Clock, ArrowLeftRight, MessageSquarePlus, X } from "lucide-react";

// The Ledger of Owes: what you owe and what you are owed, one calm balance. Both
// sides read like the Today list (same rows, same date chips) so it feels born
// from the same screen. Only the date chip is ever tinted; a whole row is never
// red, that is the line between a ledger and a scoreboard. Nothing sends itself:
// the chase drafts a friendly reminder for review, never fires it.

// Snooze is asymmetric on purpose: a day's grace on what you owe, a week on what
// you are owed (chasing someone again the next day feels naggy, not gracious).
const SNOOZE_ME_DAYS = 1;
const SNOOZE_THEM_DAYS = 7;

// The inline chase draft reuses the exact review card the Suggestions screen uses.
const CHASE_LABELS = { nudge: "Reminder" };
const CHASE_CLASSES = { nudge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" };

export function Ledger() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [personFilter, setPersonFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null); // factId mid-snooze/flip
  const [clearing, setClearing] = useState<Set<string>>(new Set()); // factIds animating out on done
  const [chasing, setChasing] = useState<string | null>(null); // factId building a chase draft
  const [chaseDrafts, setChaseDrafts] = useState<Record<string, StackItem>>({}); // factId -> drafted card
  const [chaseError, setChaseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      setPeople((data.people ?? []) as PersonRow[]);
      setFacts((data.facts ?? []) as FactRow[]);
      setToday((data.today ?? "") as string);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { youOwe, theyOwe } = useMemo(
    () => (today ? buildLedger(people, facts, today) : { youOwe: [], theyOwe: [] }),
    [people, facts, today],
  );

  // Filter chips: everyone who appears anywhere in the ledger, alphabetical.
  const peopleInLedger = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of [...youOwe, ...theyOwe]) m.set(i.personId, i.personName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [youOwe, theyOwe]);

  // If the filtered person clears out of the ledger entirely, fall back to
  // Everyone so the view is never stuck on an empty selection.
  useEffect(() => {
    if (personFilter !== "all" && !peopleInLedger.some(([id]) => id === personFilter)) {
      setPersonFilter("all");
    }
  }, [peopleInLedger, personFilter]);

  const byFilter = (items: OweItem[]) => (personFilter === "all" ? items : items.filter((i) => i.personId === personFilter));
  const you = byFilter(youOwe);
  const they = byFilter(theyOwe);

  async function patchFact(factId: string, patch: Record<string, unknown>) {
    await fetch(`/api/facts/${factId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  function markDone(item: OweItem) {
    // Animate the row out (strike + collapse), then persist and reconcile. The
    // finally always reloads and un-clears, so a FAILED patch brings the row back
    // instead of silently vanishing a still-open promise.
    setClearing((prev) => new Set(prev).add(item.factId));
    setTimeout(async () => {
      try {
        await patchFact(item.factId, { status: "done" });
      } finally {
        closeChase(item.factId);
        await load();
        setClearing((prev) => {
          const n = new Set(prev);
          n.delete(item.factId);
          return n;
        });
      }
    }, 320);
  }

  async function snooze(item: OweItem, owedBy: OwedBy) {
    setBusy(item.factId);
    try {
      const days = owedBy === "them" ? SNOOZE_THEM_DAYS : SNOOZE_ME_DAYS;
      await patchFact(item.factId, { due_at: new Date(Date.now() + days * 86400000).toISOString() });
      closeChase(item.factId);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function flip(item: OweItem, owedBy: OwedBy) {
    setBusy(item.factId);
    try {
      await patchFact(item.factId, { owed_by: owedBy === "me" ? "them" : "me" });
      // A draft for the old direction makes no sense once the debt flips.
      closeChase(item.factId);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function draftChase(item: OweItem) {
    setChasing(item.factId);
    setChaseError(null);
    try {
      const res = await fetch("/api/chase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factId: item.factId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not draft");
      setChaseDrafts((prev) => ({ ...prev, [item.factId]: data.card as StackItem }));
    } catch (e) {
      setChaseError((e as Error).message);
    } finally {
      setChasing(null);
    }
  }

  function closeChase(factId: string) {
    setChaseDrafts((prev) => {
      const n = { ...prev };
      delete n[factId];
      return n;
    });
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const bothEmpty = youOwe.length === 0 && theyOwe.length === 0;
  if (bothEmpty) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing owed, either way. Capture a promise and it will show up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-2">
        {/* A plain balance, no percentages, no overdue count staring back. Counts
            follow the active filter so the line always matches the rows below. */}
        <p className="text-sm text-muted-foreground">{`${you.length} you owe   ·   ${they.length} you're owed`}</p>
        {peopleInLedger.length > 1 && (
          <select
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
            aria-label="Filter by person"
          >
            <option value="all">Everyone</option>
            {peopleInLedger.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {chaseError && <p className="-mt-4 text-xs text-muted-foreground">Could not draft a reminder just now. Try again in a moment.</p>}

      <LedgerGroup
        title="You owe"
        items={you}
        owedBy="me"
        emptyLine={personFilter === "all" ? "You're all clear on your side." : "Nothing you owe here."}
        clearing={clearing}
        busy={busy}
        chasing={chasing}
        chaseDrafts={chaseDrafts}
        onDone={markDone}
        onSnooze={snooze}
        onFlip={flip}
        onChase={draftChase}
        onCloseChase={closeChase}
        onReload={load}
      />

      <LedgerGroup
        title="They owe you"
        items={they}
        owedBy="them"
        emptyLine={personFilter === "all" ? "Nobody owes you right now." : "Nothing owed to you here."}
        clearing={clearing}
        busy={busy}
        chasing={chasing}
        chaseDrafts={chaseDrafts}
        onDone={markDone}
        onSnooze={snooze}
        onFlip={flip}
        onChase={draftChase}
        onCloseChase={closeChase}
        onReload={load}
      />
    </div>
  );
}

function LedgerGroup({
  title,
  items,
  owedBy,
  emptyLine,
  clearing,
  busy,
  chasing,
  chaseDrafts,
  onDone,
  onSnooze,
  onFlip,
  onChase,
  onCloseChase,
  onReload,
}: {
  title: string;
  items: OweItem[];
  owedBy: OwedBy;
  emptyLine: string;
  clearing: Set<string>;
  busy: string | null;
  chasing: string | null;
  chaseDrafts: Record<string, StackItem>;
  onDone: (i: OweItem) => void;
  onSnooze: (i: OweItem, o: OwedBy) => void;
  onFlip: (i: OweItem, o: OwedBy) => void;
  onChase: (i: OweItem) => void;
  onCloseChase: (factId: string) => void;
  onReload: () => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">{emptyLine}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-2xl border bg-card">
          {items.map((item) => (
            <OweRow
              key={item.factId}
              item={item}
              owedBy={owedBy}
              clearing={clearing.has(item.factId)}
              busy={busy === item.factId}
              chasing={chasing === item.factId}
              draft={chaseDrafts[item.factId]}
              onDone={onDone}
              onSnooze={onSnooze}
              onFlip={onFlip}
              onChase={onChase}
              onCloseChase={onCloseChase}
              onReload={onReload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function OweRow({
  item,
  owedBy,
  clearing,
  busy,
  chasing,
  draft,
  onDone,
  onSnooze,
  onFlip,
  onChase,
  onCloseChase,
  onReload,
}: {
  item: OweItem;
  owedBy: OwedBy;
  clearing: boolean;
  busy: boolean;
  chasing: boolean;
  draft: StackItem | undefined;
  onDone: (i: OweItem) => void;
  onSnooze: (i: OweItem, o: OwedBy) => void;
  onFlip: (i: OweItem, o: OwedBy) => void;
  onChase: (i: OweItem) => void;
  onCloseChase: (factId: string) => void;
  onReload: () => void;
}) {
  const flipTitle = owedBy === "me" ? "Actually, they owe me" : "Actually, I owe them";
  // Clearing a they-owe item earns one warm flicker of green (a small good
  // feeling); clearing your own debt is plain relief and stays gray. Transient
  // only, never a resting colour.
  const struck = owedBy === "them" ? "text-emerald-600 line-through dark:text-emerald-400" : "text-muted-foreground line-through";

  return (
    <li
      className={`overflow-hidden transition-all duration-300 ${
        clearing ? "max-h-0 border-transparent py-0 opacity-0" : "max-h-96"
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <button
          type="button"
          onClick={() => onDone(item)}
          disabled={clearing}
          aria-label="Mark done"
          title="Mark done"
          className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {clearing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Circle className="h-5 w-5" />}
        </button>

        <Link href={`/protected/people/${item.personId}`} className={`flex-1 leading-snug hover:underline ${clearing ? struck : ""}`}>
          <span className="font-medium">{item.personName}</span>: {item.content}
        </Link>

        {item.dueLabel && (
          <span className={`shrink-0 text-xs tabular-nums ${dueTone(item.dueLabel)}`}>{item.dueLabel}</span>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <RowButton onClick={() => onSnooze(item, owedBy)} disabled={busy || clearing} label="Snooze" busy={busy}>
            <Clock className="h-4 w-4" />
          </RowButton>
          <RowButton onClick={() => onFlip(item, owedBy)} disabled={busy || clearing} label={flipTitle} busy={false}>
            <ArrowLeftRight className="h-4 w-4" />
          </RowButton>
          {owedBy === "them" && !draft && (
            <RowButton onClick={() => onChase(item)} disabled={chasing || clearing} label="Draft a reminder" busy={chasing}>
              <MessageSquarePlus className="h-4 w-4" />
            </RowButton>
          )}
        </div>
      </div>

      {draft && (
        <div className="border-t bg-muted/30 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">A reminder you can send (nothing sends itself)</span>
            <button
              type="button"
              onClick={() => onCloseChase(item.factId)}
              aria-label="Close draft"
              className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Approve / skip / edit all resolve the draft, so dismiss the inline
              panel and refresh (the card also lives on Suggestions if wanted). */}
          <Stack
            items={[draft]}
            endpoint="/api/cards"
            labels={CHASE_LABELS}
            classes={CHASE_CLASSES}
            onChange={() => {
              onCloseChase(item.factId);
              onReload();
            }}
          />
        </div>
      )}
    </li>
  );
}

// A small, quiet row action: icon-only, appears as one of a cluster on the right.
function RowButton({
  onClick,
  disabled,
  label,
  busy,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : children}
    </button>
  );
}
