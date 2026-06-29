import { AiAdapter } from "./types";
import { ClaudeAdapter } from "./claude";
import { ClaudeCliAdapter } from "./claude-cli";
import { MockAdapter } from "./mock";
import { observed } from "./observe";

// Which brain Membro uses:
//   MEMBRO_AI=cli|api|mock   explicit override
//   else ANTHROPIC_API_KEY set      -> api  (Anthropic API)
//   else running locally (not Vercel) -> cli  (your Claude subscription via `claude -p`)
//   else (Vercel, no key)           -> mock (deterministic offline engine)
// The `claude -p` path only works where the Claude CLI is installed and logged
// in, which is your own machine — not a stock Vercel serverless deploy.
export function getAdapter(): AiAdapter {
  // Every adapter is wrapped so its calls are traced to Langfuse (a no-op when
  // the LANGFUSE_* env vars are absent).
  return observed(pickAdapter());
}

function pickAdapter(): AiAdapter {
  const choice = (process.env.MEMBRO_AI || "").toLowerCase();
  if (choice === "mock" || process.env.MEMBRO_FORCE_MOCK === "1") return new MockAdapter();
  if (choice === "api") return new ClaudeAdapter();
  if (choice === "cli") return new ClaudeCliAdapter();

  if (process.env.ANTHROPIC_API_KEY) return new ClaudeAdapter();
  if (process.env.VERCEL !== "1") return new ClaudeCliAdapter();
  return new MockAdapter();
}

export * from "./types";
