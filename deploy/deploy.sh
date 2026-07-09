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
# The app binds loopback only and sits behind the auth gate, so an unauthenticated
# hit is a 307 auth redirect = healthy.
app_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo '000')"
echo "membro.service=$app_active  oauth2-proxy.service=$auth_active  app_http=$app_code"

if [ "$app_active" != "active" ] || [ "$auth_active" != "active" ] || [ "$app_code" != "307" ]; then
  echo "DEPLOY UNHEALTHY — check: journalctl -u membro.service -n 50" >&2
  exit 1
fi
echo "== deploy OK =="
