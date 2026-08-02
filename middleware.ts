import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// SECOND LOCK ON THE FRONT DOOR.
//
// Membro is single-user: one SQLite file, no user_id, no row-level security (see
// lib/db.ts). Every note, person and diary entry in it belongs to the owner, and
// the ONLY thing separating them from the public internet used to be oauth2-proxy
// on the VM. On 2026-08-02 that gate turned out to have been wide open for weeks:
// its config said `email_domains = ["*"]` next to an authenticated-emails file, and
// in oauth2-proxy's validator a "*" domain sets allowAll, whose `valid = true` is
// the LAST word — it silently overrode the emails file. Any Google account on earth
// could sign in and read everything, and one non-owner account did.
//
// The proxy config is fixed and pinned by deploy/harden-oauth2-proxy.sh. This
// middleware exists so that a single line of misread config in a file that is not
// fully in git can never again be the only thing standing between a stranger and
// the owner's private notes. It re-checks, inside the app, that the request really
// belongs to the owner.
//
// The identity comes from `X-Auth-Request-Email`, set by oauth2-proxy
// (`set_xauthrequest = true`). It cannot be spoofed by a client: oauth2-proxy
// strips the incoming value of every header it manages before injecting its own,
// and the app binds loopback only, so nothing reaches it except through the proxy.
const OWNER_EMAIL = process.env.MEMBRO_OWNER_EMAIL?.trim().toLowerCase() ?? "";

// Static assets with no user data in them. Kept open so the PWA shell, icons and
// service worker still load (and so a locked-out browser renders a plain 403 page
// instead of a pile of failed asset requests). Never add a page or /api route
// here, and never add the `_rsc` payloads — those DO carry notes.
const PUBLIC_PATHS = new Set([
  "/favicon.ico",
  "/favicon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-icon.png",
  "/sw.js",
  "/manifest.webmanifest",
]);

export function middleware(req: NextRequest) {
  if (PUBLIC_PATHS.has(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  // Local dev runs with no proxy in front, so there is no header to check and
  // nothing is exposed (next dev binds localhost). Production is the deployed VM:
  // there the owner MUST be configured, and if it is not we fail CLOSED rather
  // than repeat the mistake this file exists to prevent. deploy/deploy.sh asserts
  // both halves of this on every deploy, so a missing value is caught loudly at
  // deploy time instead of quietly at 3am.
  if (!OWNER_EMAIL) {
    if (process.env.NODE_ENV !== "production") {
      return NextResponse.next();
    }
    return deny("Membro is misconfigured: MEMBRO_OWNER_EMAIL is not set.");
  }

  const email = req.headers.get("x-auth-request-email")?.trim().toLowerCase();
  if (email === OWNER_EMAIL) {
    return NextResponse.next();
  }

  return deny("This is a private, single-user app. Your account is not the owner.");
}

function deny(message: string) {
  return new NextResponse(`403 Forbidden — ${message}\n`, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Never let an intermediary or the PWA cache a denial (or an allow).
      "cache-control": "no-store",
    },
  });
}

export const config = {
  // Everything except Next's build output. Pages, /api routes and the `_rsc`
  // payloads all carry user data and are all covered.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
