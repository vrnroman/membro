"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CaptureBox } from "./capture-box";
import { ActionItems } from "./action-items";
import { PersonRow, FactRow, Assist } from "@/lib/membro/types";
import { horizon, SELF_ID } from "@/lib/nightshift/scout";
import { Sparkles, NotebookPen, CalendarRange } from "lucide-react";

export function Today() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [assists, setAssists] = useState<Assist[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      setPeople((data.people ?? []) as PersonRow[]);
      setFacts((data.facts ?? []) as FactRow[]);
      setAssists((data.assists ?? []) as Assist[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const today = new Date().toISOString().slice(0, 10);
  const pendingAssists = assists.filter((a) => a.status === "pending").length;
  // facts come newest-first from the snapshot, so the first self fact is the latest.
  const latestDiary = facts.find((f) => f.person_id === SELF_ID)?.content ?? null;
  const upcoming = horizon(people, facts, today);

  return (
    <div className="flex flex-col gap-8">
      <p className="-mt-2 text-sm text-muted-foreground">
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      </p>
      <CaptureBox onCaptured={load} />

      {(pendingAssists > 0 || latestDiary) && (
        <div className="-mt-4 flex flex-col gap-1">
          {pendingAssists > 0 && (
            <Link
              href="/protected/suggestions"
              className="inline-flex items-center gap-2 text-sm text-sky-700 hover:underline dark:text-sky-400"
            >
              <Sparkles className="h-4 w-4" />
              {pendingAssists} {pendingAssists === 1 ? "draft" : "drafts"} ready to review
            </Link>
          )}
          {latestDiary && (
            <Link
              href="/protected/diary"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <NotebookPen className="h-4 w-4 shrink-0" />
              <span className="line-clamp-1">Diary: {latestDiary}</span>
            </Link>
          )}
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold">Action items</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          What you need to do soon — the things you promised, meetings, dates, and birthdays.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ActionItems people={people} facts={facts} onChange={load} />
        )}
      </section>

      {upcoming.length > 0 && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">On the horizon</h2>
          <p className="mb-3 text-sm text-muted-foreground">Further out, so nothing you noted slips by.</p>
          <ul className="flex flex-col divide-y rounded-2xl border bg-card">
            {upcoming.map((e, i) => (
              <li key={i}>
                <Link
                  href={`/protected/people/${e.personId}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"
                >
                  <CalendarRange className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 leading-snug">
                    {e.event} <span className="text-muted-foreground">({e.personName})</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">in {e.daysUntil} days</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
