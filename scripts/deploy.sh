#!/usr/bin/env bash
# scripts/deploy.sh: deploy the COMMITTED tree (HEAD) to CreateOS Deploy, then promote it to the live environment.
# Only files tracked by git are uploaded, so .env, .env.local, data/ and CLAUDE.md can never ship.
# Usage: bash scripts/deploy.sh [--force]   (--force skips the running-sandbox check; use it only when no run can be live)
# Needs data/deploy.json: {"projectId": "...", "environmentId": "...", "url": "https://live-holdout.tyzo.nodeops.app"}
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi
jget() { python3 -c 'import json, sys; print(json.load(open("data/deploy.json"))[sys.argv[1]])' "$1"; }
P=$(jget projectId)
E=$(jget environmentId)
URL=$(jget url)

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy: note: tracked files have uncommitted changes; only HEAD is deployed." >&2
fi

# A deploy or promote restarts the app and loses in-memory runs (SMOKE-TESTS, Deploy probe 2).
if [ "$FORCE" -ne 1 ]; then
  running=$(curl -sS -m 10 "$URL/api/health" 2>/dev/null | python3 -c 'import sys, json; r = json.load(sys.stdin).get("running", 0); print("unknown" if r is None else r)' 2>/dev/null || echo 0)
  if [ "$running" = "unknown" ]; then
    echo "deploy: /api/health reports running as unknown (whoami was slow). Retry in 5 s; use --force only if no run can be live." >&2
    exit 1
  fi
  if [ "$running" != "0" ]; then
    echo "deploy: the app reports $running running sandbox(es); a live run may be in flight. Refused. Re-run with --force only if none is." >&2
    exit 1
  fi
fi

rm -rf .deploy
mkdir .deploy
git archive HEAD | tar -x -C .deploy
git rev-parse --short HEAD > .deploy/VERSION
want=$(cat .deploy/VERSION)
t0=$(date +%s)

# macOS has no GNU timeout: perl's alarm bounds the deploy at 240 s in case the CLI keeps streaming logs.
rc=0
out=$(perl -e 'alarm shift @ARGV; exec @ARGV' 240 createos deploy --project "$P" --dir .deploy 2>&1) || rc=$?
printf '%s\n' "$out" | tail -n 5
D=$(printf '%s\n' "$out" | grep 'Live at' | grep -oE 'https://dep-[0-9A-Za-z-]+\.' | head -n 1 | sed -E 's#^https://dep-##; s#\.$##' || true)
if [ -z "$D" ]; then
  echo "deploy: no 'Live at' URL in the output (exit $rc); taking the newest deployment from the list." >&2
  D=$(createos -o json deployments list --project "$P" 2>/dev/null | python3 -c 'import json, sys; print(max(json.load(sys.stdin), key=lambda d: d["createdAt"])["id"])' 2>/dev/null || true)
fi
if [ -z "$D" ]; then
  echo "deploy: no deployment id found. Check createos -o table deployments list --project $P; promote by hand if it went live." >&2
  exit 1
fi

createos deployments promote --project "$P" --deployment "$D" --environment "$E"

# The environment switches about 10-12 s after promote (SMOKE-TESTS). Wait up to 60 s for the new build.
v=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 5
  v=$(curl -sS -m 10 "$URL/api/health" 2>/dev/null | python3 -c 'import sys, json; print(json.load(sys.stdin).get("version", ""))' 2>/dev/null || true)
  if [ "$v" = "$want" ]; then break; fi
done
echo "deploy: deployment $D promoted to $URL in $(( $(date +%s) - t0 )) s; /api/health version: ${v:-none} (HEAD $want)."
