"use client";

import { useCallback, useEffect, useState } from "react";
import { CaptureBox } from "./capture-box";
import { ActionItems } from "./action-items";
import { PersonRow, FactRow } from "@/lib/membro/types";

export function Today() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      setPeople((data.people ?? []) as PersonRow[]);
      setFacts((data.facts ?? []) as FactRow[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-8">
      <p className="-mt-2 text-sm text-muted-foreground">
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      </p>
      <CaptureBox onCaptured={load} />

      <section>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Action items</h2>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          What you need to do soon — the things you promised, meetings, and birthdays.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ActionItems people={people} facts={facts} onChange={load} />
        )}
      </section>
    </div>
  );
}
