// Next.js runs this on server startup. Importing the Langfuse module registers
// the OpenTelemetry tracer so AI calls in the route handlers get traced. Only in
// the Node.js runtime (the OTel SDK is not for the edge runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/observability/langfuse");
  }
}
