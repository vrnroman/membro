import { db } from "@/lib/db";
import { getAdapter } from "@/lib/ai";
import type { AiAdapter, AssistOutput, ResearchBrief, ConnectorCandidate } from "@/lib/ai/types";
import {
  listPeople,
  listPeopleIdName,
  listFactContents,
  listFactsForPerson,
  listResearchedSubjects,
  getPerson,
  insertAssist,
  insertConflict,
  insertCards,
  connectorCoversPair,
  deleteCaptureConnectorsForCapture,
  deleteAssistsForCapture,
  insertDiaryEntry,
  deleteDiaryForCapture,
} from "@/lib/repo";
import { SELF_ID } from "@/lib/nightshift/scout";
import { topicsOf, sharedTopics, pairKey } from "@/lib/nightshift/topics";
import {
  type AssistJob,
  type CrewFacts,
  rescheduleAssistJob,
  parkAssistJob,
  markAssistJobDone,
  markAssistJobFailed,
} from "./queue";
import { backoffMs } from "./policy";
import { QuotaExhaustedError, AdapterError, ENGINE_RETRY_MS, PARK_MAX_AGE_MS, retriedTooLong } from "@/lib/ai/quota";

// Process one queued note as the per-note CREW: several members wake around the
// note and each does its own thing.
//   Drafter / Advisor / Diarist  (adapter.assist) — a draft, a read+reply, a diary
//     entry, or nothing. Durable: a failure retries the whole job.
//   Researcher                    (adapter.research) — a short web-grounded brief on
//     any company / topic the note names that is not on file. Best-effort.
//   Ledger                        (adapter.detectConflicts) — flags a freshly filed
//     fact that actively contradicts one already on file. Best-effort.
// The whole note is already saved before this runs, so this only ever produces the
// *extra*, and it is safe to re-run: it clears its own prior output for the note
// first, conflicts dedupe by fact pair, and diary entries dedupe by content.

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// Hold a job until the engine has credit again, without spending an attempt. The
// reset time comes from the CLI itself, so we wait exactly as long as it says (a
// probe a minute later is floored to QUOTA_MIN_MS by the parser).
function parkForQuota(job: AssistJob, e: QuotaExhaustedError): void {
  if (parkedTooLong(job, `out of AI quota: ${e.raw}`)) return;
  parkAssistJob(job.id, e.resetAt.toISOString(), `paused, out of AI quota: ${e.raw}`);
  console.error(`<3>[crew] job ${job.id} parked until ${e.resetAt.toISOString()}, out of AI quota`);
}

/**
 * The backstop on parking. Parking spends no attempts, so a job held by a fault we
 * WRONGLY judged global would sit here forever: never done, never failed, never
 * surfaced. Past PARK_MAX_AGE_MS (10 days, comfortably beyond the 7-day weekly
 * limit that parking exists for) it takes the ordinary give-up path instead, so
 * every fault class terminates and says so.
 */
function parkedTooLong(job: AssistJob, reason: string): boolean {
  const age = Date.now() - Date.parse(job.created_at);
  if (!Number.isFinite(age) || age <= PARK_MAX_AGE_MS) return false;
  markAssistJobFailed(job.id, `gave up after ${Math.round(age / 86400_000)}d parked: ${reason}`);
  console.error(`<3>[crew] job ${job.id} parked ${Math.round(age / 86400_000)}d without recovering, giving up: ${reason}`);
  return true;
}

/**
 * The same rule, for the engine being broken rather than merely out of credit: a
 * read-only disk or an expired token means the model was never reached, so this
 * note did nothing wrong and must not spend an attempt on it.
 *
 * Without this, the two proven global faults (10x EROFS, 2x 401 in the real
 * corpus) burn all eight tries in about 35 minutes and mark the note permanently
 * `failed` — and both are persistent by nature, so they ALWAYS outlast 35 minutes.
 * Fixing the disk would not bring the note back. lib/briefs/policy.ts already
 * states this rule for the sweep; the jobs need it more, because their give-up is
 * terminal while a brief's is not.
 */
function parkForEngineDown(job: AssistJob, e: AdapterError): void {
  if (parkedTooLong(job, `AI engine unavailable: ${e.raw}`)) return;
  const at = new Date(Date.now() + ENGINE_RETRY_MS).toISOString();
  parkAssistJob(job.id, at, `paused, AI engine unavailable: ${e.raw}`);
  console.error(`<3>[crew] job ${job.id} parked until ${at}, AI engine unavailable: ${e.raw}`);
}

function backOffOrGiveUp(job: AssistJob, error: string): void {
  const attemptsDone = job.attempts + 1;
  // Retry a transient hiccup for up to RETRY_MAX_AGE_MS (~10h), the bound shared with
  // the voice worker, then give up. The note and its facts are already saved and the
  // capture is already in the Notes inbox (fileNote runs before this job), so a
  // give-up loses only the draft, which the owner can reprocess by hand.
  if (retriedTooLong(job.created_at, attemptsDone)) {
    markAssistJobFailed(job.id, `gave up after ~10h of retries: ${error}`);
    console.error(`<3>[crew] job ${job.id} failed permanently after ~10h: ${error}`);
    return;
  }
  rescheduleAssistJob(job.id, isoIn(backoffMs(attemptsDone)), error);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Which people already on file does this note name? Best-effort grounding for
// the drafter. Case-SENSITIVE on the stored (capitalized) name so a person named
// "Bill" does not match the common word "bill" in "pay the electric bill" and
// get a wrong-context draft attributed to them.
function mentionedIn(note: string, name: string): boolean {
  const first = name.trim().split(/\s+/)[0];
  if (!first) return false;
  return new RegExp(`\\b${escapeRegex(first)}\\b`).test(note);
}

// Company / person names already on file OR already briefed, so the Researcher
// skips anything the owner has logged before AND never re-briefs the same company
// on a later note (even one that never became a saved contact).
function knownSubjects(): string[] {
  const set = new Set<string>();
  for (const p of listPeople()) {
    if (p.name) set.add(p.name);
    if (p.company) set.add(p.company);
  }
  for (const s of listResearchedSubjects()) set.add(s);
  return [...set];
}

// Very common sentence-openers that are capitalized only because they start a
// sentence, never a subject worth researching.
const SENTENCE_OPENERS = new Set([
  "the", "i", "we", "my", "he", "she", "they", "a", "an", "this", "that", "it", "his", "her", "their",
  "had", "met", "saw", "got", "just", "today", "tomorrow", "yesterday", "also", "then", "after", "before",
  "when", "while", "grabbed", "called", "texted", "spoke", "talked", "caught", "went", "quick", "great", "good",
]);

// Cheap gate before spending a web-search call: does the note plausibly name a
// subject the Researcher could brief? Returns false for pure-lowercase diary lines
// and notes whose only capitalized words are sentence-openers or people/companies
// already known. Lenient: any unfamiliar capitalized token lets the note through
// and the model makes the real call (it stays silent on household names anyway).
function mayNameNewSubject(note: string, known: string[]): boolean {
  const knownFirst = new Set(known.map((k) => k.toLowerCase().split(/\s+/)[0]));
  for (const m of note.matchAll(/\b([A-Z][A-Za-z0-9&.\-]{1,})\b/g)) {
    const low = m[1].toLowerCase();
    if (knownFirst.has(low) || SENTENCE_OPENERS.has(low)) continue;
    return true;
  }
  return false;
}

type FoundConflict = { personId: string; newFactId: string; oldFactId: string; reason: string };

// The Ledger member: for every person the note filed facts about, compare those new
// facts against everything else on file for them. Best-effort per person — one
// person's AI hiccup must not lose the others. Never throws.
/** The engine itself is down (out of credit, or never reached the model at all). */
function isGlobalFault(e: unknown): e is QuotaExhaustedError | AdapterError {
  return e instanceof QuotaExhaustedError || (e instanceof AdapterError && e.global);
}

async function detectAllConflicts(
  job: AssistJob,
  today: string,
  adapter: AiAdapter,
  onQuota?: (e: QuotaExhaustedError | AdapterError) => void,
): Promise<FoundConflict[]> {
  const out: FoundConflict[] = [];
  if (!job.crew_facts) return out;
  let crew: unknown;
  try {
    crew = JSON.parse(job.crew_facts);
  } catch {
    return out;
  }
  if (!Array.isArray(crew)) return out; // valid JSON that is not an array must not throw the for-of
  for (const cf of crew as CrewFacts[]) {
    if (!cf || !cf.personId || !Array.isArray(cf.factIds) || cf.factIds.length === 0) continue;
    if (cf.personId === SELF_ID) continue; // the diary thread is not a relationship
    try {
      const person = getPerson(cf.personId);
      if (!person) continue;
      const all = listFactsForPerson(cf.personId);
      const newIds = new Set(cf.factIds);
      // Cap what we send: the assist path already slices to a handful, and an
      // unbounded history would inflate cost and can overflow the model context
      // (which the catch below would swallow, silently stopping detection here).
      const newFacts = all.filter((f) => newIds.has(f.id)).slice(0, 20).map((f) => ({ id: f.id, content: f.content }));
      const existingFacts = all.filter((f) => !newIds.has(f.id)).slice(0, 40).map((f) => ({ id: f.id, content: f.content }));
      if (!newFacts.length || !existingFacts.length) continue;
      const found = await adapter.detectConflicts({ personName: person.name, newFacts, existingFacts, today });
      for (const c of found) {
        out.push({ personId: cf.personId, newFactId: c.newFactId, oldFactId: c.oldFactId, reason: c.reason });
      }
    } catch (e) {
      // Quota is not a per-person hiccup to swallow: report it up so the caller can
      // park the whole note instead of completing it with the Ledger silently
      // skipped (for a photo-only note the Ledger is the entire crew).
      if (isGlobalFault(e)) onQuota?.(e);
      console.error(`[crew] ledger failed for person ${cf.personId} on job ${job.id}:`, (e as Error).message);
    }
  }
  return out;
}

export async function processAssistJob(job: AssistJob): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const adapter = getAdapter();
  const hasNote = job.note.trim().length > 0;

  // Drafter / Advisor / Diarist. Durable — a failure here retries the whole job.
  // Skipped for a photo-only note (no text to classify); the Ledger still runs.
  let out: AssistOutput = { kind: "none", title: "", body: "", why: "" };
  let mentioned: { id: string; name: string }[] = [];
  if (hasNote) {
    const roster = listPeopleIdName().filter((p) => p.id !== SELF_ID);
    mentioned = roster.filter((p) => mentionedIn(job.note, p.name));
    const people = mentioned.map((p) => ({ name: p.name, facts: listFactContents(p.id).slice(0, 8) }));
    try {
      out = await adapter.assist({ note: job.note, today, people });
    } catch (e) {
      // Out of quota is the engine being down, not this note being bad. Park it
      // until the engine is back WITHOUT spending an attempt: charging a global
      // outage to each note marks every one of them permanently failed ~35 minutes
      // in, and returning quota never brings them back.
      if (e instanceof QuotaExhaustedError) {
        parkForQuota(job, e);
        return;
      }
      // The engine never ran the model (read-only disk, dead token). Global, and
      // not this note's fault, so park rather than spend an attempt.
      if (e instanceof AdapterError && e.global) {
        parkForEngineDown(job, e);
        return;
      }
      backOffOrGiveUp(job, (e as Error).message);
      return;
    }
  }

  // Researcher. Best-effort — a failure must not block the assist output, the
  // Ledger, or the job completing. A cheap proper-noun gate skips the web-search
  // call entirely for diary lines and notes that name nothing new.
  let briefs: ResearchBrief[] = [];
  // Either kind of global fault starves a best-effort member the same way, and both
  // must park the note rather than let it complete with the crew silently skipped.
  let starved: QuotaExhaustedError | AdapterError | null = null;
  if (hasNote) {
    const known = knownSubjects();
    if (mayNameNewSubject(job.note, known)) {
      try {
        briefs = await adapter.research({ note: job.note, today, knownSubjects: known });
      } catch (e) {
        if (isGlobalFault(e)) starved = e;
        console.error(`[crew] researcher failed on job ${job.id}:`, (e as Error).message);
      }
    }
  }

  // Ledger. Best-effort, computed before the write so its rows commit atomically
  // with the rest.
  const conflicts = await detectAllConflicts(job, today, adapter, (e) => (starved = e));

  // Connector. Best-effort: when a newly filed fact reveals that its person should
  // meet someone else already on file, draft the intro right now, while the context
  // is fresh, instead of waiting for the nightly sweep. Silent unless there is a
  // specific two-sided reason (the model's job); a shared word alone never fires.
  const connector = starved ? null : await runConnector(job, today, adapter, (e) => (starved = e));

  // "Best-effort" means a member may fail without failing the note. It must NOT mean
  // a member is silently SKIPPED because the engine had no credit, and the job then
  // marked done forever: for a photo-only note the Ledger is the only member there
  // is, so that would drop the whole crew pass with nothing but a log line. If any
  // member was starved of quota, park the note and run the crew properly when the
  // engine is back. The write below is replace-not-append (it clears this note's
  // prior output first), so re-running is safe.
  if (starved) {
    if (starved instanceof QuotaExhaustedError) parkForQuota(job, starved);
    else parkForEngineDown(job, starved);
    return;
  }

  // One transaction: replace this note's prior crew output, write the new output,
  // record any contradictions, mark the job done. If any write throws, nothing
  // commits and we take the bounded-retry path instead of re-running forever.
  try {
    const apply = db().transaction(() => {
      // Clear any prior output for THIS note so a retry replaces, never duplicates.
      if (job.capture_id) {
        deleteAssistsForCapture(job.capture_id);
        deleteDiaryForCapture(job.capture_id);
      }
      if (out.kind === "draft" || out.kind === "advisory") {
        // An empty draft is a rare model hiccup. Skip it (the note is already saved)
        // rather than throwing, which would roll back the best-effort Ledger + Research
        // writes in this same transaction and fail the whole job.
        if (out.body.trim()) {
          insertAssist({
            capture_id: job.capture_id,
            person_id: mentioned[0]?.id ?? null,
            kind: out.kind,
            title: out.title.trim() || (out.kind === "draft" ? "Draft" : "A read on this"),
            body: out.body,
            why: out.why?.trim() || null,
            meta: { crew: out.kind === "draft" ? "drafter" : "advisor" },
          });
        } else {
          console.warn(`[crew] job ${job.id}: ${out.kind} came back empty, skipping it`);
        }
      } else if (out.kind === "diary") {
        insertDiaryEntry(job.note.trim(), job.capture_id);
      }
      // Researcher briefs live on the same "Ready to review" surface as the drafts.
      // Zero-migration home: an 'advisory'-kind row stamped with the crew member, so
      // the review UI labels it "Background" off meta.crew rather than the kind.
      for (const b of briefs) {
        insertAssist({
          capture_id: job.capture_id,
          person_id: null,
          kind: "advisory",
          title: b.subject,
          body: b.body,
          why: b.why || null,
          meta: { crew: "researcher", subject: b.subject },
        });
      }
      // insertConflict dedupes by fact pair, so a retry never stacks duplicates.
      for (const c of conflicts) {
        insertConflict({ personId: c.personId, newFactId: c.newFactId, oldFactId: c.oldFactId, reason: c.reason });
      }
      // Connector card. Clear this capture's PRIOR connector unconditionally (like
      // the assists above), so a reprocess that no longer yields a match removes the
      // now-wrong old card instead of leaving it stranded on the Stack.
      //
      // Note the order: runConnector already ran above and, via pair-memory, will
      // NOT re-propose a pair whose card still exists — so on a true re-run of the
      // SAME fact `connector` is null and this delete would just remove the card.
      // That is unreachable in practice (the queue never re-selects a done job;
      // reprocess deletes the facts first, so runConnector sees a fresh fact and
      // re-proposes; a failed transaction rolls back and re-fires clean), which is
      // why the unconditional delete is safe rather than self-erasing.
      if (job.capture_id) deleteCaptureConnectorsForCapture(job.capture_id);
      if (connector) {
        insertCards([
          {
            person_id: connector.personAId,
            kind: "connector",
            title: `Introduce ${connector.personAName} and ${connector.personBName}?`,
            body: connector.intro,
            why: connector.why,
            meta: {
              source: "capture",
              crew: "connector",
              capture_id: job.capture_id,
              // source_fact_id ties the card to a triggering fact, so deleting that
              // fact (or the note) cleans the card up via the existing card cascade,
              // now that the nightly wipe spares it.
              source_fact_id: connector.sourceFactId,
              personIds: [connector.personAId, connector.personBId],
              pairKey: pairKey(connector.personAId, connector.personBId),
              // ALL the topics that drove this pairing, so pair-memory remembers the
              // whole reason-cluster, not just the first one.
              topics: connector.topics,
              topic: connector.topics[0], // primary, for display
            },
          },
        ]);
      }
      markAssistJobDone(job.id);
    });
    apply();
  } catch (e) {
    backOffOrGiveUp(job, (e as Error).message);
    return;
  }
  console.log(
    `[crew] job ${job.id} -> ${out.kind}` +
      `${briefs.length ? ` +${briefs.length} brief(s)` : ""}` +
      `${conflicts.length ? ` +${conflicts.length} conflict(s)` : ""}` +
      `${connector ? " +1 connector" : ""}`,
  );
}

// The Connector member. Returns the ONE intro worth making for this note, or null.
// Pure of writes — the caller commits the card inside the crew transaction.
//
// Shape: for each person the note just filed a fact about, take the topics that NEW
// fact brings up, find others already on file who share one, and hand the shortlist
// to the model. The model is the fire bar: it names an intro only for a real
// two-sided reason, else stays silent. A cheap topic pre-filter means the model is
// only called when there is at least a word in common, and pair-memory means a pair
// the owner already saw for the same reason is not offered again.
async function runConnector(
  job: AssistJob,
  today: string,
  adapter: AiAdapter,
  onStarved: (e: QuotaExhaustedError | AdapterError) => void,
): Promise<{
  personAId: string;
  personAName: string;
  personBId: string;
  personBName: string;
  topics: string[];
  sourceFactId: string;
  why: string;
  intro: string;
} | null> {
  if (!job.crew_facts) return null;
  let crew: unknown;
  try {
    crew = JSON.parse(job.crew_facts);
  } catch {
    return null;
  }
  if (!Array.isArray(crew)) return null;

  // Which of this note's people actually brought up a topic worth pairing on. Do
  // this cheap check FIRST: if nothing has topics, we never touch the roster.
  type Person = NonNullable<ReturnType<typeof getPerson>>;
  const subjects: { cf: CrewFacts; subject: Person; newTopics: Set<string> }[] = [];
  for (const cf of crew as CrewFacts[]) {
    if (!cf || !cf.personId || !Array.isArray(cf.factIds) || cf.factIds.length === 0) continue;
    if (cf.personId === SELF_ID) continue;
    const subject = getPerson(cf.personId);
    if (!subject) continue;
    const newIds = new Set(cf.factIds);
    const newFacts = listFactsForPerson(cf.personId).filter((f) => newIds.has(f.id));
    if (!newFacts.length) continue;
    // The trigger: the topics THIS new fact brings up, not the person's whole history.
    const newTopics = topicsOf(subject, newFacts);
    if (newTopics.size) subjects.push({ cf, subject, newTopics });
  }
  if (!subjects.length) return null;

  // Only NOW build everyone else's topic set (and their facts, once), since at least
  // one new fact has a topic to match. n is tiny (a personal CRM).
  const roster = listPeopleIdName().filter((p) => p.id !== SELF_ID);
  const topicsByPerson = new Map<string, Set<string>>();
  const factsByPerson = new Map<string, string[]>();
  for (const p of roster) {
    const person = getPerson(p.id);
    if (!person) continue;
    const facts = listFactsForPerson(p.id);
    factsByPerson.set(p.id, facts.map((f) => f.content));
    topicsByPerson.set(p.id, topicsOf(person, facts));
  }

  for (const { cf, subject, newTopics } of subjects) {
    // Candidates: other people who share a new-fact topic, minus any (pair, topic) we
    // have already surfaced (pair-memory is per topic, across all statuses AND both
    // passes, so the owner never sees the same reason twice but a genuinely new topic
    // for the same pair can still fire).
    const candidates: ConnectorCandidate[] = [];
    for (const p of roster) {
      if (p.id === cf.personId) continue;
      const shared = sharedTopics(newTopics, topicsByPerson.get(p.id) || new Set());
      const freshTopics = shared.filter((t) => !connectorCoversPair(cf.personId, p.id, { topic: t }));
      if (!freshTopics.length) continue;
      candidates.push({ id: p.id, name: p.name, sharedTopics: freshTopics, facts: (factsByPerson.get(p.id) || []).slice(0, 6) });
    }
    if (!candidates.length) continue;
    // Strongest first: more shared topics is a stronger signal. Deterministic.
    candidates.sort((a, b) => b.sharedTopics.length - a.sharedTopics.length);

    let suggestion;
    try {
      suggestion = await adapter.connectNote({ note: job.note, subjectName: subject.name, candidates: candidates.slice(0, 5), today });
    } catch (e) {
      // A global fault here is the engine being down, not this note's fault: report
      // it up so the caller parks the whole note (same as the other members).
      if (isGlobalFault(e)) onStarved(e as QuotaExhaustedError | AdapterError);
      console.error(`[crew] connector failed on job ${job.id}:`, (e as Error).message);
      return null;
    }
    if (!suggestion) continue; // model stayed silent for this subject; try the next

    const other = candidates.find((c) => c.id === suggestion.otherId);
    if (!other) continue; // sanitizeConnector already guards this, belt-and-braces
    // The candidate filter above already dropped every topic that a card covers, so
    // by here `other.sharedTopics` are all genuinely new; no separate live-dedup
    // (the old topic-agnostic pending check dropped valid new-topic intros).
    return {
      personAId: cf.personId,
      personAName: subject.name,
      personBId: other.id,
      personBName: other.name,
      topics: other.sharedTopics,
      sourceFactId: cf.factIds[0],
      why: suggestion.why,
      intro: suggestion.intro,
    };
  }
  return null; // no subject produced an intro worth making
}
