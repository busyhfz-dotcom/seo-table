#!/usr/bin/env bash
#
# One-shot Railway deployment: PostgreSQL + Redis + web + worker, secrets,
# migrations, health checks, a public domain, and a smoke test at the end.
#
# Requirements on the machine running this:
#   - Railway CLI v4+   (npm i -g @railway/cli)   and   `railway login` done once
#   - openssl, curl, node 22, pnpm
#
# Usage (from the repository root):
#   OWNER_EMAIL=you@example.com OWNER_PASSWORD='a-long-password' ./scripts/deploy-railway.sh
#
# Optional:
#   RAILWAY_PROJECT_NAME   default: seo-table
#   EXTERNAL_DATABASE_URL  use this Postgres (e.g. Neon, direct endpoint) instead
#                          of creating a Railway Postgres service
#   SEED_SITE              first project's site URL (you can also add it in the UI)
#   CUSTOM_DOMAIN          e.g. app.example.ir — prints the DNS record to create
#
# Safe to re-run: existing services and variables are reused, secrets are only
# generated the first time, and migrations are idempotent.

set -euo pipefail

PROJECT_NAME="${RAILWAY_PROJECT_NAME:-seo-table}"
: "${OWNER_EMAIL:?set OWNER_EMAIL}"
: "${OWNER_PASSWORD:?set OWNER_PASSWORD (10+ characters)}"

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v railway >/dev/null || die "Railway CLI not found: npm i -g @railway/cli"
railway whoami >/dev/null 2>&1 || die "Not logged in: run 'railway login' first"
[ ${#OWNER_PASSWORD} -ge 10 ] || die "OWNER_PASSWORD must be at least 10 characters"

# ---------------------------------------------------------------- project
say "Project: $PROJECT_NAME"
if ! railway status >/dev/null 2>&1; then
  railway init --name "$PROJECT_NAME"
fi

# ---------------------------------------------------------------- data services
# EXTERNAL_DATABASE_URL: use a Postgres outside Railway (for example Neon)
# instead of creating a Railway Postgres service.
if [ -n "${EXTERNAL_DATABASE_URL:-}" ]; then
  say "PostgreSQL: external database (Railway Postgres is not created)"
  # Normalise a Neon connection string:
  #  - the direct endpoint, not '-pooler': migrations hold a session-level
  #    advisory lock, which a transaction-mode pooler does not keep;
  #  - sslmode=verify-full (Neon certificates are publicly trusted);
  #    channel_binding dropped (node-postgres negotiates SCRAM itself).
  DB_URL="$(EXTERNAL_DATABASE_URL="$EXTERNAL_DATABASE_URL" node -e '
    const raw = process.env.EXTERNAL_DATABASE_URL.trim().replace(/^psql\s+/, "").replace(/^["\x27]|["\x27]$/g, "");
    let u;
    try { u = new URL(raw); } catch { console.error("not a valid URL"); process.exit(2); }
    if (!/^postgres(ql)?:$/.test(u.protocol)) { console.error("must start with postgresql://"); process.exit(2); }
    if (!u.password) { console.error("the connection string has no password"); process.exit(2); }
    u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
    u.searchParams.delete("channel_binding");
    u.searchParams.set("sslmode", "verify-full");
    process.stdout.write(u.toString());
  ')" || die "EXTERNAL_DATABASE_URL is not a usable PostgreSQL connection string"
  DB_HOST="$(printf '%s' "$DB_URL" | sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#')"
  echo "  host: $DB_HOST"
  DATABASE_URL_VALUE="$DB_URL"
else
  say "PostgreSQL"
  if printf '%s' "$(railway status --json 2>/dev/null || true)" | grep -qi '"name": *"postgres"'; then
    echo "  postgres already present"
  else
    railway add --database postgres </dev/null || die "could not create Postgres"
  fi
  DATABASE_URL_VALUE='${{Postgres.DATABASE_URL}}'
fi
say "Redis"
if printf '%s' "$(railway status --json 2>/dev/null || true)" | grep -qi '"name": *"redis"'; then
  echo "  redis already present"
else
  railway add --database redis </dev/null || die "could not create Redis"
fi

# ---------------------------------------------------------------- app services
say "Services: web and worker"
# --variables keeps `railway add` from asking for variables on an invisible
# prompt; stdin from /dev/null makes any other prompt fail fast instead of hanging.
existing_services="$(railway status --json 2>/dev/null || true)"
for svc in web worker; do
  if printf '%s' "$existing_services" | grep -q "\"name\": *\"$svc\""; then
    echo "  $svc already present"
  else
    railway add --service "$svc" --variables "SERVICE_ROLE=$svc" </dev/null \
      || die "could not create the $svc service"
  fi
done

# ---------------------------------------------------------------- secrets
# Generated once. If they already exist they are left alone: rotating
# ENCRYPTION_KEY would make every stored connector credential unreadable.
existing_key="$(railway variables --service web --kv 2>/dev/null | sed -n 's/^ENCRYPTION_KEY=//p' || true)"
if [ -z "$existing_key" ]; then
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  say "Generated new ENCRYPTION_KEY and SESSION_SECRET"
else
  ENCRYPTION_KEY="$existing_key"
  SESSION_SECRET="$(railway variables --service web --kv | sed -n 's/^SESSION_SECRET=//p')"
  say "Reusing existing secrets"
fi

set_vars() {
  local service="$1"; shift
  railway variables --service "$service" --skip-deploys "$@" >/dev/null
}

COMMON=(
  --set "DATABASE_URL=$DATABASE_URL_VALUE"
  --set 'REDIS_URL=${{Redis.REDIS_URL}}'
  --set "ENCRYPTION_KEY=$ENCRYPTION_KEY"
  --set "SESSION_SECRET=$SESSION_SECRET"
  --set "NODE_ENV=production"
  --set "QUEUE_PREFIX=seo"
  --set "LOG_LEVEL=info"
)

say "Variables"
set_vars web    "${COMMON[@]}" --set "SERVICE_ROLE=web" --set 'APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
                --set "OWNER_EMAIL=$OWNER_EMAIL" --set "OWNER_PASSWORD=$OWNER_PASSWORD" \
                --set "SEED_SITE=${SEED_SITE:-}"
set_vars worker "${COMMON[@]}" --set "SERVICE_ROLE=worker" --set "WORKER_CONCURRENCY=2"

# ---------------------------------------------------------------- deploy
# The web container runs migrations before it starts serving (scripts/start.sh), so
# a failed migration fails the health check and the old release keeps serving.
say "Deploying web (runs migrations first)"
railway up --service web --detach
say "Deploying worker"
railway up --service worker --detach

# ---------------------------------------------------------------- domain
say "Public domain"
DOMAIN="$(railway domain --service web 2>/dev/null | grep -Eo '[a-z0-9.-]+\.up\.railway\.app' | head -1 || true)"
[ -n "$DOMAIN" ] || die "Could not obtain a railway.app domain; run 'railway domain --service web'"
BASE_URL="https://$DOMAIN"
echo "  $BASE_URL"

if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  say "Custom domain $CUSTOM_DOMAIN"
  railway domain "$CUSTOM_DOMAIN" --service web || true
  echo "  Create the CNAME record Railway printed above at your DNS provider."
  echo "  TLS is issued automatically once the record resolves."
fi

# ---------------------------------------------------------------- wait for health
say "Waiting for /api/ready"
for i in $(seq 1 90); do
  if curl -sf -m 10 "$BASE_URL/api/ready" >/dev/null; then echo "  ready"; break; fi
  [ $((i % 6)) = 0 ] && echo "  still waiting ($((i * 5 / 60)) min) - build progress: railway logs --service web --build"
  [ "$i" = 90 ] && die "web did not become ready; check 'railway logs --service web'"
  sleep 5
done

# The owner account is created inside the web container on its first start
# (scripts/start.sh), where the private database hostname resolves. It only
# ever runs against an empty users table, so the variables are inert afterwards;
# delete OWNER_PASSWORD from the web service's variables once you have signed in.

# ---------------------------------------------------------------- smoke
say "Smoke test against $BASE_URL"
if [ -n "${SEED_SITE:-}" ]; then
  BASE_URL="$BASE_URL" SMOKE_EMAIL="$OWNER_EMAIL" SMOKE_PASSWORD="$OWNER_PASSWORD" \
    SMOKE_SITE="$SEED_SITE" pnpm exec tsx scripts/smoke.ts
else
  echo "  Set SEED_SITE to a site you own to run the full crawl smoke test."
  curl -sf "$BASE_URL/api/health" && echo
fi

say "Done — $BASE_URL"
