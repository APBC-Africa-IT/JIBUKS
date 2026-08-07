#!/usr/bin/env bash
# Runs ON THE SERVER, either manually or triggered by GitHub Actions on
# every push to Dev-Branch. Pulls latest code, rebuilds, migrates, restarts.
#
# Deliberately NOT silent: migrations are a visible, named step. If a
# migration fails, this script exits non-zero, the GitHub Actions run shows
# red, and the OLD server container keeps running (compose up is only
# reached after a successful migration) -- a bad migration cannot silently
# take down a working deployment.
#
# Builds with --no-cache and separately VERIFIES the built image actually
# contains the migrations that exist in the git checkout -- found the hard
# way that Docker's build cache can silently reuse a stale COPY . . layer,
# producing a "successful" deploy that actually served days-old code with
# no error anywhere in the pipeline output. This check turns that into a
# loud, immediate failure instead of a silent multi-day gap.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest Dev-Branch"
git fetch origin
git checkout Dev-Branch
git reset --hard origin/Dev-Branch

echo "==> Building images (--no-cache: never trust a cached layer for this)"
docker compose build --no-cache

echo "==> Verifying the built image actually contains current migrations"
EXPECTED_COUNT=$(ls backend/migrations/ | wc -l | tr -d ' ')
ACTUAL_COUNT=$(docker compose run --rm --entrypoint sh migrate -c "ls migrations/ | wc -l" | tr -d ' \r\n')
if [ "$EXPECTED_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "FATAL: built image has $ACTUAL_COUNT migration files, git checkout has $EXPECTED_COUNT."
  echo "The build did not pick up current source. Refusing to proceed."
  exit 1
fi
echo "OK: $ACTUAL_COUNT migrations in the built image match the checkout."

echo "==> Running migrations (visible step -- fails loudly on error)"
docker compose run --rm migrate

echo "==> Starting/updating the server container"
docker compose up -d postgres server

echo "==> Pruning old, now-unused images"
docker image prune -f

echo "==> Deploy complete"
docker compose ps
