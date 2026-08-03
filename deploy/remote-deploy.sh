#!/usr/bin/env bash
# Runs ON THE SERVER, either manually or triggered by GitHub Actions on
# every push to Dev-Branch. Pulls latest code, rebuilds, migrates, restarts.
#
# Deliberately NOT silent: migrations are a visible, named step. If a
# migration fails, this script exits non-zero, the GitHub Actions run shows
# red, and the OLD server container keeps running (compose up is only
# reached after a successful migration) -- a bad migration cannot silently
# take down a working deployment.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest Dev-Branch"
git fetch origin
git checkout Dev-Branch
git reset --hard origin/Dev-Branch

echo "==> Building images"
docker compose build

echo "==> Running migrations (visible step -- fails loudly on error)"
docker compose run --rm migrate

echo "==> Starting/updating the server container"
docker compose up -d --remove-orphans postgres server

echo "==> Pruning old, now-unused images"
docker image prune -f

echo "==> Deploy complete"
docker compose ps