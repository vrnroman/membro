// Sends a few real traces to Langfuse through the observed() wrapper, then
// queries the Langfuse API to confirm they landed. No Supabase / app needed.
// Run: npm run test:langfuse   (requires LANGFUSE_* env vars)
import { observed } from "@/lib/ai/observe";
import { flushLangfuse, langfuseEnabled } from "@/lib/observability/langfuse";
import { MockAdapter } from "@/lib/ai/mock";
import { Signal } from "@/lib/ai/types";

const TODAY = "2026-06-27";

async function main() {
  if (!langfuseEnabled) {
    console.log("FAIL: LANGFUSE_* env vars not set");
    process.exit(1);
  }
  const runStart = new Date(Date.now() - 60_000); // a minute of slack for clock skew
  const ai = observed(new MockAdapter());

  // A few different AI calls -> a few generations in Langfuse.
  await ai.extract({
    text: "Caught up with Dana. She moved to the design team and her birthday is next week. I owe her the onboarding doc.",
    today: TODAY,
    existingNames: [],
  });
  await ai.extract({ text: "Met Raj from the Tokyo office, he just shipped the billing rewrite.", today: TODAY, existingNames: [] });

  const birthday: Signal = { type: "birthday", person: { id: "p1", name: "Dana", company: null, role: null, blurb: null }, daysUntil: 7, facts: ["moved to the design team"] };
  const connector: Signal = { type: "connector", personA: { id: "p1", name: "Dana", company: null, role: null, blurb: null }, personB: { id: "p2", name: "Raj", company: null, role: null, blurb: null }, shared: "Tokyo", facts: [] };
  await ai.buildCard(birthday, TODAY);
  await ai.buildCard(connector, TODAY);
  await ai.brief({
    person: { id: "p1", name: "Dana", company: null, role: null, blurb: null },
    facts: ["moved to the design team"],
    newFacts: [],
    cadenceDays: null,
    today: TODAY,
  });

  console.log("sent 5 generations, flushing…");
  await flushLangfuse();

  // Verify via the Langfuse Observations API v2 (the v1 traces list is removed
  // in Langfuse v4). Bounded to this run's window, so a pass can only come from
  // the generations sent above, never from an older run's rows.
  const base = process.env.LANGFUSE_BASE_URL!.replace(/\/$/, "");
  const auth = "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const wanted = ["membro.extract", "membro.buildCard", "membro.brief"];

  for (let attempt = 1; attempt <= 8; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const query = new URLSearchParams({
      type: "GENERATION",
      limit: "50",
      fields: "core,basic",
      fromStartTime: runStart.toISOString(),
      toStartTime: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await fetch(`${base}/api/public/v2/observations?${query}`, { headers: { Authorization: auth } });
    if (!res.ok) {
      console.log(`  api attempt ${attempt}: HTTP ${res.status}`);
      continue;
    }
    const data = (await res.json()) as { data: { name: string | null; startTime: string }[] };
    const names = new Set(data.data.map((o) => o.name));
    const found = wanted.filter((w) => names.has(w));
    console.log(`  api attempt ${attempt}: found ${found.length}/3 expected observation names (${found.join(", ") || "none yet"})`);
    if (found.length === 3) {
      console.log("Langfuse integration works: observations are landing in the project.");
      process.exit(0);
    }
  }
  console.log("FAIL: expected observation names did not appear in Langfuse within the retry window");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
