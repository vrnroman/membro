import type { NextConfig } from "next";

// Cache Components is off: this is a single-user, always-dynamic app backed by a
// local SQLite file, so per-request rendering with `force-dynamic` API routes is
// exactly what we want (and it keeps the Node runtime needed by better-sqlite3).
const nextConfig: NextConfig = {};

export default nextConfig;
