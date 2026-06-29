import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Langfuse observability. When the three LANGFUSE_* env vars are present, every
// AI call (extract / buildCard / brief, in any adapter) is exported as a traced
// generation to Langfuse. When they are absent this is a no-op, so the app runs
// fine without it.
//
// Built on OpenTelemetry: we register one LangfuseSpanProcessor on a NodeSDK,
// once per process. The globalThis guard keeps Next's multiple module loads from
// starting the SDK more than once.

export const langfuseEnabled = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

type Holder = { processor: LangfuseSpanProcessor };
const g = globalThis as unknown as { __membroLangfuse?: Holder };

if (langfuseEnabled && !g.__membroLangfuse) {
  const processor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    // Export each span as it ends — simplest for short-lived / serverless runs.
    exportMode: "immediate",
  });
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  g.__membroLangfuse = { processor };
}

export function getProcessor(): LangfuseSpanProcessor | null {
  return g.__membroLangfuse?.processor ?? null;
}

// Force any buffered traces out. Call before a short-lived process exits.
export async function flushLangfuse(): Promise<void> {
  await getProcessor()?.forceFlush();
}
