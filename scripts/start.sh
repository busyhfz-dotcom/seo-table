#!/bin/sh
# Entry point for the container. SERVICE_ROLE picks what this instance runs.
set -eu
export SERVICE_NAME="seo-${SERVICE_ROLE:-web}"

case "${SERVICE_ROLE:-web}" in
  web)
    # Migrations run before the server accepts traffic. They are idempotent and
    # serialised by an advisory lock, so several replicas starting at once is safe;
    # a failed migration exits non-zero and the deploy fails its health check.
    if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
      (cd packages/db && node --import tsx src/migrate.ts)
    fi
    # First-owner bootstrap: creates the initial account from OWNER_EMAIL /
    # OWNER_PASSWORD only while the database has no users at all. A failure does
    # not stop the app (it may be serving existing users), but it must be seen:
    # nobody can sign in to a fresh deployment until it succeeds.
    if [ -n "${OWNER_EMAIL:-}" ] && [ -n "${OWNER_PASSWORD:-}" ]; then
      if ! SEED_ONLY_IF_EMPTY=1 SEED_EMAIL="$OWNER_EMAIL" SEED_PASSWORD="$OWNER_PASSWORD" \
        SEED_SITE="${SEED_SITE:-}" node --import tsx scripts/seed.ts; then
        echo "[start] ERROR: owner bootstrap failed (see the [seed] line above); no owner account was created." >&2
        echo "[start] ERROR: fix the cause and restart the service; the bootstrap runs again on every start." >&2
      fi
    fi
    cd apps/web
    exec node ../../node_modules/next/dist/bin/next start -p "${PORT:-3000}" -H 0.0.0.0
    ;;
  worker)
    cd apps/worker
    exec node --import tsx src/main.ts
    ;;
  migrate)
    cd packages/db
    exec node --import tsx src/migrate.ts
    ;;
  *)
    echo "Unknown SERVICE_ROLE: ${SERVICE_ROLE}" >&2
    exit 64
    ;;
esac
