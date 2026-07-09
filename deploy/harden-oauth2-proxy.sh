#!/usr/bin/env bash
#
# Idempotently ensure oauth2-proxy (Membro's Google login gate) has the settings
# the login flow needs, then restart it only if something actually changed.
#
# WHY THIS EXISTS
# ---------------
# Login was failing with "Unable to find a valid CSRF token" (oauth2-proxy log:
# "[AuthFailure] ... CSRF token mismatch"). Cause: by default oauth2-proxy uses a
# SINGLE shared `_oauth2_proxy_csrf` cookie for the login round-trip. Because the
# app is a PWA, an unauthenticated page load fires several requests in parallel
# (the service-worker fetch of /sw.js, /favicon.ico, /protected?_rsc=... prefetches).
# With skip_provider_button on, each one 302s to /oauth2/start and REWRITES that one
# cookie — so by the time Google redirects back to /oauth2/callback the cookie no
# longer matches the request's `state`, and the login is rejected. A rebuild that
# invalidates the cached sw.js/RSC makes the storm worse, so it can look like an app
# deploy broke login when the auth config is the real cause.
#
# Fix: `cookie_csrf_per_request = true` makes each /oauth2/start set its OWN
# uniquely-named cookie (`_oauth2_proxy_<nonce>_csrf`, nonce also encoded in the
# state), so parallel starts can't clobber each other and the callback looks its
# cookie up by nonce.
#
# The oauth2-proxy config lives at /etc/oauth2-proxy/oauth2-proxy.cfg on the VM and
# is NOT otherwise in git (it holds secrets). This script is the version-controlled
# source of truth for the NON-secret settings the login needs; it edits the live
# file in place, leaving the secrets untouched. Safe to run repeatedly.
#
# Run on the VM (needs passwordless sudo, which the deploy user has):
#   bash deploy/harden-oauth2-proxy.sh
# It is also invoked automatically by deploy/deploy.sh.

set -euo pipefail

CFG="${OAUTH2_PROXY_CFG:-/etc/oauth2-proxy/oauth2-proxy.cfg}"
SERVICE="${OAUTH2_PROXY_SERVICE:-oauth2-proxy.service}"

# Config key -> the exact line that must be present. Add future non-secret settings
# here; each is enforced (added if missing, corrected if the value drifted).
declare -A REQUIRE=(
  [cookie_csrf_per_request]="cookie_csrf_per_request = true"
)

if ! sudo test -f "$CFG"; then
  echo "harden-oauth2-proxy: $CFG not found — not an oauth2-proxy host, skipping."
  exit 0
fi

# Work on a private copy (mode 600 from mktemp). The copy contains secrets, so wipe
# it on every exit path.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sudo cat "$CFG" > "$tmp"

changed=0
for key in "${!REQUIRE[@]}"; do
  want="${REQUIRE[$key]}"
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$tmp"; then
    if ! grep -qxF "$want" "$tmp"; then
      sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${want}|" "$tmp"
      changed=1
      echo "harden-oauth2-proxy: corrected '${key}'"
    fi
  else
    printf '\n# Added by deploy/harden-oauth2-proxy.sh (see that file for why).\n%s\n' "$want" >> "$tmp"
    changed=1
    echo "harden-oauth2-proxy: added '${key}'"
  fi
done

if [ "$changed" -eq 0 ]; then
  echo "harden-oauth2-proxy: already up to date — no change, not restarting."
  exit 0
fi

# Back up, then write the new content back preserving the file's owner/group/mode
# (it is root:oauth2proxy 0640 — do not leak it to the deploy user or change perms).
ts="$(date +%Y%m%d-%H%M%S)"
owner="$(sudo stat -c '%U:%G' "$CFG")"
mode="$(sudo stat -c '%a' "$CFG")"
sudo cp -a "$CFG" "$CFG.bak-$ts"
sudo cp "$tmp" "$CFG"
sudo chown "$owner" "$CFG"
sudo chmod "$mode" "$CFG"
echo "harden-oauth2-proxy: updated $CFG (backup at $CFG.bak-$ts)"

# Restart and verify; roll back if oauth2-proxy will not come up (a broken login
# gate takes the whole site down, so never leave it in a failed state).
sudo systemctl restart "$SERVICE"
sleep 2
if [ "$(systemctl is-active "$SERVICE")" != "active" ]; then
  echo "harden-oauth2-proxy: $SERVICE failed to start — ROLLING BACK to $CFG.bak-$ts" >&2
  sudo cp -a "$CFG.bak-$ts" "$CFG"
  sudo systemctl restart "$SERVICE"
  exit 1
fi
echo "harden-oauth2-proxy: applied; $SERVICE is active."
