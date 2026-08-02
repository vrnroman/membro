#!/usr/bin/env bash
#
# One-command deploy for Membro, run ON the production VM (claude-agent, the plain
# git checkout of main at ~/membro). Encodes what used to be manual steps, plus the
# oauth2-proxy login hardening so it is re-applied on every deploy and can never be
# silently lost again.
#
# Usage (from a fresh SSH session on the VM):
#   cd ~/membro && git pull --ff-only && bash deploy/deploy.sh
# The initial `git pull` just bootstraps THIS script; the script pulls again itself.
#
# It aborts (set -e) if the build fails, so a broken build never restarts the app.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, wherever this script was invoked from
echo "== deploy: $(pwd) =="

echo "== 1/4 pull main =="
git pull --ff-only

# Deps: node_modules persists on the VM and deploys have been build-only, so we do
# NOT run npm install here — it could dirty package-lock.json and break the next
# `git pull --ff-only`. If a deploy ever adds a dependency the build fails loudly;
# run `npm install` by hand that once.
echo "== 2/4 build (abort on failure — no restart) =="
npm run build

echo "== 3/4 ensure oauth2-proxy login settings =="
bash "$(dirname "$0")/harden-oauth2-proxy.sh"

echo "== 4/4 restart the app =="
sudo systemctl restart membro.service
sleep 2

echo "== health =="
app_active="$(systemctl is-active membro.service)"
auth_active="$(systemctl is-active oauth2-proxy.service)"

# Membro has two independent locks on the front door and this checks BOTH, because
# the whole point of the second one is that it still holds when the first quietly
# stops holding (which is exactly what happened on 2026-08-02 — see
# deploy/harden-oauth2-proxy.sh).
#
# Lock 1 is oauth2-proxy: it must be up, and its gate config is enforced in step 3.
# Lock 2 is middleware.ts inside the app: it only serves requests carrying the
# owner's X-Auth-Request-Email header. We curl the app directly on loopback, which
# bypasses the proxy, and assert:
#   - no identity header       -> 403 (the second lock is live and closed)
#   - owner's identity header  -> 307 (the app still redirects the owner to /protected)
# A 307 on the first probe would mean middleware.ts is missing or MEMBRO_OWNER_EMAIL
# is unset, i.e. the app is relying on the proxy alone again.
owner_email="$(grep -E '^MEMBRO_OWNER_EMAIL=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
if [ -z "$owner_email" ]; then
  echo "DEPLOY UNHEALTHY — MEMBRO_OWNER_EMAIL is not set in .env; the app's owner check cannot work." >&2
  exit 1
fi

anon_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo '000')"
owner_code="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-Auth-Request-Email: $owner_email" http://127.0.0.1:3000/ || echo '000')"
echo "membro.service=$app_active  oauth2-proxy.service=$auth_active  anon=$anon_code  owner=$owner_code"

if [ "$app_active" != "active" ] || [ "$auth_active" != "active" ]; then
  echo "DEPLOY UNHEALTHY — a service is down. Check: journalctl -u membro.service -n 50" >&2
  exit 1
fi
if [ "$anon_code" != "403" ]; then
  echo "DEPLOY UNHEALTHY — expected 403 for a request with no owner header, got $anon_code." >&2
  echo "The app's own owner check is NOT protecting these routes. Do not leave this deployed." >&2
  exit 1
fi
if [ "$owner_code" != "307" ]; then
  echo "DEPLOY UNHEALTHY — expected 307 for the owner, got $owner_code (the owner may be locked out)." >&2
  exit 1
fi
echo "== deploy OK — both locks verified =="
