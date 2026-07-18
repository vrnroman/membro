import { startObservation } from "@langfuse/tracing";
import { langfuseEnabled } from "@/lib/observability/langfuse";
import {
  AiAdapter,
  AssistOutput,
  BriefContent,
  BriefInput,
  BuiltCard,
  ExtractionResult,
  FactConflict,
  FactRef,
  ResearchBrief,
  ConnectorSuggestion,
  Signal,
} from "./types";

// Wrap any AiAdapter so each call shows up in Langfuse as a generation with its
// input, output, the engine used (mock / claude / claude-cli), and errors. The
// wrapper is adapter-agnostic, so the API path, the `claude -p` path, and the
// offline mock are all traced the same way. No keys -> returns the adapter as-is.

export function observed(adapter: AiAdapter): AiAdapter {
  if (!langfuseEnabled) return adapter;
  const model = adapter.label;

  return {
    label: adapter.label,

    async extract(input): Promise<ExtractionResult> {
      const gen = startObservation(
        "membro.extract",
        { model, input: { text: input.text, images: input.images?.length ?? 0, today: input.today } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.extract(input);
        gen.update({ output: out, metadata: { adapter: adapter.label, people: out.entities.length } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async buildCard(signal: Signal, today: string): Promise<BuiltCard> {
      const gen = startObservation(
        "membro.buildCard",
        { model, input: { signal, today } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.buildCard(signal, today);
        gen.update({ output: out, metadata: { adapter: adapter.label, kind: out.kind, signal: signal.type } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async brief(input: BriefInput): Promise<BriefContent> {
      const gen = startObservation(
        "membro.brief",
        { model, input: { person: input.person.name, facts: input.facts, newFacts: input.newFacts, cadenceDays: input.cadenceDays } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.brief(input);
        gen.update({ output: out, metadata: { adapter: adapter.label } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async assist(input): Promise<AssistOutput> {
      const gen = startObservation(
        "membro.assist",
        { model, input: { note: input.note, today: input.today, people: input.people.map((p) => p.name) } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.assist(input);
        gen.update({ output: out, metadata: { adapter: adapter.label, kind: out.kind } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async detectConflicts(input: {
      personName: string;
      newFacts: FactRef[];
      existingFacts: FactRef[];
      today: string;
    }): Promise<FactConflict[]> {
      const gen = startObservation(
        "membro.detectConflicts",
        { model, input: { person: input.personName, newFacts: input.newFacts.map((f) => f.content), existing: input.existingFacts.length } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.detectConflicts(input);
        gen.update({ output: out, metadata: { adapter: adapter.label, conflicts: out.length } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async research(input: { note: string; today: string; knownSubjects: string[] }): Promise<ResearchBrief[]> {
      const gen = startObservation(
        "membro.research",
        { model, input: { note: input.note, knownSubjects: input.knownSubjects } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.research(input);
        gen.update({ output: out, metadata: { adapter: adapter.label, briefs: out.length } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async connectNote(input): Promise<ConnectorSuggestion | null> {
      const gen = startObservation(
        "membro.connectNote",
        { model, input: { note: input.note, subject: input.subjectName, candidates: input.candidates.map((c) => c.name) } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.connectNote(input);
        gen.update({ output: out, metadata: { adapter: adapter.label, matched: out ? out.otherId : null } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },

    async reflect(entries: string[], today: string): Promise<string> {
      const gen = startObservation(
        "membro.reflect",
        { model, input: { entries } },
        { asType: "generation" },
      );
      try {
        const out = await adapter.reflect(entries, today);
        gen.update({ output: out, metadata: { adapter: adapter.label } }).end();
        return out;
      } catch (e) {
        gen.update({ level: "ERROR", statusMessage: (e as Error).message }).end();
        throw e;
      }
    },
  };
}
