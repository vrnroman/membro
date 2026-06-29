"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { PersonRow, FactRow } from "@/lib/membro/types";
import { COLD_DAYS } from "@/lib/nightshift/scout";

function relativeDays(iso: string): string {
  const d = Math.round((Date.now() - Date.parse(iso)) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export function PeopleIndex() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const data = await res.json();
      setPeople((data.people ?? []) as PersonRow[]);
      setFacts((data.facts ?? []) as FactRow[]);
      setLoading(false);
    })();
  }, []);

  const factsByPerson = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of facts) {
      const arr = m.get(f.person_id) || [];
      arr.push(f.content);
      m.set(f.person_id, arr);
    }
    return m;
  }, [facts]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return people;
    return people.filter((p) => {
      const hay = [p.name, p.company, p.role, p.blurb, ...(factsByPerson.get(p.id) || [])].join(" ").toLowerCase();
      return hay.includes(term);
    });
  }, [q, people, factsByPerson]);

  return (
    <div className="flex flex-col gap-5">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search people, companies, facts…"
        className="rounded-full"
        aria-label="Search"
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {people.length === 0 ? "No one yet. Capture a note on the Today tab to start." : "No matches."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((p) => {
            const cold = (Date.now() - Date.parse(p.last_contact_at)) / 86400000 >= COLD_DAYS;
            const preview = factsByPerson.get(p.id)?.[0] || p.blurb || "";
            return (
              <Link
                key={p.id}
                href={`/protected/people/${p.id}`}
                className={`rounded-2xl border bg-card p-4 shadow-sm transition hover:shadow-md ${cold ? "opacity-60" : ""}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} className="text-lg">
                    {p.name}
                  </h3>
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeDays(p.last_contact_at)}</span>
                </div>
                {(p.role || p.company) && (
                  <p className="text-sm text-muted-foreground">{[p.role, p.company].filter(Boolean).join(" · ")}</p>
                )}
                {preview && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{preview}</p>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
