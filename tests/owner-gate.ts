// Test of the app's own owner check (middleware.ts) — the second lock on the front
// door, added after the auth proxy was found wide open on 2026-08-02 (any Google
// account could sign in and read every note; see deploy/harden-oauth2-proxy.sh).
//
// This app has no per-user separation in the database, so "who is asking" is the
// only thing standing between a stranger and everything. These cases pin that down:
// the owner gets through, nobody else does, an unconfigured production deploy fails
// CLOSED rather than open, and static assets stay reachable so a denied browser
// still renders.
//
// The middleware reads MEMBRO_OWNER_EMAIL at module load, so each case re-imports it
// with a fresh cache-busting query string under the env it wants to test.
// Run: npm run test:owner-gate (also part of npm test).
import { NextRequest } from "next/server";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let seq = 0;
async function loadMiddleware(env: { owner?: string; nodeEnv: string }) {
  if (env.owner === undefined) {
    delete process.env.MEMBRO_OWNER_EMAIL;
  } else {
    process.env.MEMBRO_OWNER_EMAIL = env.owner;
  }
  // NODE_ENV is readonly in the Next type defs; this is a test harness.
  (process.env as Record<string, string>).NODE_ENV = env.nodeEnv;
  const mod = await import(`../middleware.ts?case=${seq++}`);
  return mod.middleware as (req: NextRequest) => Response;
}

function request(path: string, email?: string) {
  const headers = new Headers();
  if (email !== undefined) headers.set("x-auth-request-email", email);
  return new NextRequest(new URL(`http://127.0.0.1:3000${path}`), { headers });
}

// `NextResponse.next()` is an allow — it carries the internal continue marker
// rather than a real body, and is a 200. A denial is our explicit 403.
const allowed = (res: Response) => res.status !== 403;

async function main() {
  const OWNER = "vrnroman@gmail.com";

  // 1. Production, configured: the owner is let through, everyone else is not.
  {
    const mw = await loadMiddleware({ owner: OWNER, nodeEnv: "production" });

    check("owner reaches the app", allowed(mw(request("/protected", OWNER))));
    check(
      "owner is matched case-insensitively",
      allowed(mw(request("/protected", "VrnRoman@Gmail.com"))),
    );
    check(
      "owner is matched with stray whitespace",
      allowed(mw(request("/protected", `  ${OWNER} `))),
    );

    // The actual breach: a real Google account that is not the owner.
    check(
      "a different Google account is refused",
      !allowed(mw(request("/protected", "lingling.g@sgx.com"))),
      "this is the account that got in through the open proxy",
    );
    check(
      "a request with no identity header at all is refused",
      !allowed(mw(request("/protected"))),
    );
    check("an empty identity header is refused", !allowed(mw(request("/protected", ""))));

    // Near-miss addresses must not squeak past a sloppy comparison.
    for (const impostor of [
      "vrnroman@gmail.com.evil.com",
      "evil+vrnroman@gmail.com",
      "vrnroman@gmail.co",
      "xvrnroman@gmail.com",
    ]) {
      check(`lookalike "${impostor}" is refused`, !allowed(mw(request("/protected", impostor))));
    }

    // Every route that can carry notes must be covered, not just pages.
    for (const path of [
      "/",
      "/protected",
      "/protected/notes",
      "/protected/diary",
      "/protected/people/93a7c266-5309-415e-b065-869e16211cf3",
      "/api/snapshot",
      "/api/captures",
      "/api/facts",
    ]) {
      check(`stranger is refused at ${path}`, !allowed(mw(request(path, "stranger@example.com"))));
    }

    // ...including the RSC payloads, which is how the pages actually stream data.
    check(
      "stranger is refused at an _rsc payload",
      !allowed(mw(request("/protected/notes?_rsc=DKU-O8vAh3m1EG6f", "stranger@example.com"))),
    );

    // Static assets stay open so a denied browser renders a plain 403 page.
    for (const path of ["/sw.js", "/favicon-32.png", "/icon-192.png", "/manifest.webmanifest"]) {
      check(`static asset ${path} stays reachable`, allowed(mw(request(path, "stranger@example.com"))));
    }

    const denial = mw(request("/protected", "stranger@example.com"));
    check("denial is a 403", denial.status === 403, `got ${denial.status}`);
    check(
      "denial is not cacheable",
      denial.headers.get("cache-control") === "no-store",
      `got ${denial.headers.get("cache-control")}`,
    );
  }

  // 2. Production, misconfigured: fail CLOSED. Forgetting the env var must not
  //    silently reproduce the bug this whole file exists to prevent.
  {
    const mw = await loadMiddleware({ owner: undefined, nodeEnv: "production" });
    check(
      "unset MEMBRO_OWNER_EMAIL in production refuses the owner",
      !allowed(mw(request("/protected", OWNER))),
    );
    check(
      "unset MEMBRO_OWNER_EMAIL in production refuses everyone",
      !allowed(mw(request("/protected", "stranger@example.com"))),
    );
    check(
      "unset MEMBRO_OWNER_EMAIL in production refuses header-less requests",
      !allowed(mw(request("/api/snapshot"))),
    );
  }

  // 3. Local dev: no proxy in front, so no header exists to check. `next dev` binds
  //    localhost, so nothing is exposed and the check stays out of the way.
  {
    const mw = await loadMiddleware({ owner: undefined, nodeEnv: "development" });
    check("local dev is not blocked", allowed(mw(request("/protected"))));
  }

  // 4. Dev with an owner configured still enforces it — so you can reproduce a
  //    lockout locally instead of discovering it on the VM.
  {
    const mw = await loadMiddleware({ owner: OWNER, nodeEnv: "development" });
    check("configured owner is enforced in dev too", !allowed(mw(request("/protected", "stranger@example.com"))));
    check("configured owner still gets through in dev", allowed(mw(request("/protected", OWNER))));
  }

  // 5. The matcher decides which paths the middleware is even CALLED for, so a
  //    careless edit there (say, adding the common `api|` exclusion copied from
  //    Next examples) would silently unprotect the data routes without failing any
  //    of the checks above. Pin it: the pattern is already a regex, so run it.
  {
    process.env.MEMBRO_OWNER_EMAIL = OWNER;
    const mod = await import(`../middleware.ts?case=${seq++}`);
    const patterns: string[] = mod.config.matcher;
    check("matcher is a single pattern", patterns.length === 1, `got ${patterns.length}`);
    const re = new RegExp(`^${patterns[0]}$`);

    for (const path of [
      "/",
      "/protected",
      "/protected/notes",
      "/protected/people/93a7c266-5309-415e-b065-869e16211cf3",
      "/api/snapshot",
      "/api/captures",
      "/api/facts/abc",
      "/api/voice",
    ]) {
      check(`matcher covers ${path}`, re.test(path));
    }
    for (const path of ["/_next/static/chunks/main.js", "/_next/image"]) {
      check(`matcher skips build output ${path}`, !re.test(path));
    }
  }

  console.log(failures === 0 ? "\nowner-gate: all checks passed" : `\nowner-gate: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
