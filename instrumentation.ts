// Next.js runs this on server startup. Importing the Langfuse module registers
// the OpenTelemetry tracer so AI calls in the route handlers get traced. Only in
// the Node.js runtime (the OTel SDK is not for the edge runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/observability/langfuse");
    // Drain voice notes that got parked when Gemini was rate-limited.
    const { startVoiceWorker } = await import("@/lib/voice/worker");
    startVoiceWorker();
    // Drain the assistant queue: draft / advise / diary each captured note.
    const { startAssistWorker } = await import("@/lib/assist/worker");
    startAssistWorker();
  }
}
