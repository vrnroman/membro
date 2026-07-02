"use client";

import { useState } from "react";
import Link from "next/link";
import { scout, isActionSignal, PersonRow, FactRow } from "@/lib/nightshift/scout";
import { Cake, CalendarClock, Circle, Loader2 } from "lucide-react";

// The certain to-do list: what the owner needs to do soon, drawn straight from
// the data (no AI) so every item is grounded — a promise they made, a meeting
// they set, a birthday coming up. Speculative ideas live on the Suggestions
// screen; nothing uncertain shows up here.

// Colour a due label by urgency without over-decorating the list.
function dueTone(label: string | null): string {
  if (!label) return "text-muted-foreground";
  if (label === "overdue") return "text-red-600 dark:text-red-400";
  if (label === "today" || label === "tomorrow") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export function ActionItems({
  people,
  facts,
  onChange,
}: {
  people: PersonRow[];
  facts: FactRow[];
  onChange: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  // Generous limit, then keep only the certain signals — this is the whole
  // to-do list, not a top-N teaser.
  const items = scout(people, facts, today, 100).filter(isActionSignal);
  const [saving, setSaving] = useState<string | null>(null);

  async function markDone(factId: string) {
    setSaving(factId);
    try {
      await fetch(`/api/facts/${factId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      onChange();
    } finally {
      setSaving(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing on your plate right now. Capture what happened and I&apos;ll surface what needs doing.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y rounded-2xl border bg-card">
      {items.map((s, i) => {
        if (s.type === "commitment") {
          const busy = saving === s.factId;
          return (
            <li key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
              <button
                type="button"
                onClick={() => s.factId && markDone(s.factId)}
                disabled={busy || !s.factId}
                aria-label="Mark done"
                title="Mark done"
                className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Circle className="h-5 w-5" />}
              </button>
              <Link href={`/protected/people/${s.person.id}`} className="flex-1 leading-snug hover:underline">
                <span className="font-medium">{s.person.name}</span>: {s.commitment}
              </Link>
              {s.dueLabel && (
                <span className={`shrink-0 text-xs tabular-nums ${dueTone(s.dueLabel)}`}>{s.dueLabel}</span>
              )}
            </li>
          );
        }
        if (s.type === "meeting") {
          return (
            <li key={i}>
              <Link
                href={`/protected/people/${s.person.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
              >
                <CalendarClock className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="flex-1 leading-snug">
                  Meeting <span className="font-medium">{s.person.name}</span>
                </span>
                <span className={`shrink-0 text-xs tabular-nums ${dueTone(s.whenLabel)}`}>{s.whenLabel}</span>
              </Link>
            </li>
          );
        }
        // birthday
        const label = s.daysUntil === 0 ? "today" : s.daysUntil === 1 ? "tomorrow" : `in ${s.daysUntil} days`;
        return (
          <li key={i}>
            <Link
              href={`/protected/people/${s.person.id}`}
              className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
            >
              <Cake className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="flex-1 leading-snug">
                <span className="font-medium">{s.person.name}</span>&apos;s birthday
              </span>
              <span className={`shrink-0 text-xs tabular-nums ${dueTone(label)}`}>{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
