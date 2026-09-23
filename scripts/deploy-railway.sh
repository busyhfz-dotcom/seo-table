#!/usr/bin/env bash
#
# One-shot Railway deployment: PostgreSQL + Redis + web + worker, secrets,
# migrations, health checks, a public domain, and a smoke test at the end.
#
# Requirements on the machine running this:
#   - Railway CLI v4+   (npm i -g @railway/cli)   and   `railway login` done once
#   - curl, node 22, pnpm
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
#   BROWSER_MAX_SESSIONS   in-panel browser sessions on the worker (default 3,
#                          0 turns the browser off); see docs/DEPLOY.md for memory
#
# Safe to re-run: existing services and variables are reused, secrets are only
# generated the first time (never replaced), and migrations are idempotent.

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
  DB_HOST="$(sed -E 's#^[a-z]+://[^@]*@([^/:?]+).*#\1#' <<<"$DB_URL")"
  echo "  host: $DB_HOST"
  DATABASE_URL_VALUE="$DB_URL"
else
  say "PostgreSQL"
  # Here-strings, not `printf | grep -q`: under pipefail grep's early exit can
  # SIGPIPE the printf and turn a match into a failure.
  if grep -qi '"name": *"postgres"' <<<"$(railway status --json 2>/dev/null || true)"; then
    echo "  postgres already present"
  else
    railway add --database postgres </dev/null || die "could not create Postgres"
  fi
  # shellcheck disable=SC2016  # a Railway reference, resolved by Railway, not the shell
  DATABASE_URL_VALUE='${{Postgres.DATABASE_URL}}'
fi
say "Redis"
if grep -qi '"name": *"redis"' <<<"$(railway status --json 2>/dev/null || true)"; then
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
  if grep -q "\"name\": *\"$svc\"" <<<"$existing_services"; then
    echo "  $svc already present"
  else
    railway add --service "$svc" --variables "SERVICE_ROLE=$svc" </dev/null \
      || die "could not create the $svc service"
  fi
done

# ---------------------------------------------------------------- domain
# Created before the first deploy so APP_URL can be set to the real address
# (a `${{RAILWAY_PUBLIC_DOMAIN}}` reference renders as a bare "https://" until
# the domain exists). Railway allows one generated domain per service; on a
# re-run the command reports the existing one.
say "Public domain"
domain_out="$(railway domain --service web --port 3000 </dev/null 2>&1 || railway domain --service web </dev/null 2>&1 || true)"
if [[ $domain_out =~ ([a-z0-9-]+(\.[a-z0-9-]+)*\.up\.railway\.app) ]]; then
  DOMAIN="${BASH_REMATCH[1]}"
else
  printf '%s\n' "$domain_out" >&2
  die "Could not obtain a railway.app domain; run 'railway domain --service web' and re-run this script"
fi
BASE_URL="https://$DOMAIN"
echo "  $BASE_URL"

if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  say "Custom domain $CUSTOM_DOMAIN"
  railway domain "$CUSTOM_DOMAIN" --service web </dev/null || true
  echo "  Create the CNAME record Railway printed above at your DNS provider."
  echo "  TLS is issued automatically once the record resolves."
fi

# ---------------------------------------------------------------- secrets
# Generated once and never replaced: a new ENCRYPTION_KEY would make every
# stored connector credential unreadable. So a failure to *read* the current
# values is fatal - treating it as "no key yet" would silently rotate the key.
read_var() { # read_var <kv-output> <NAME>; strips a stray CR from Windows shells
  sed -n "s/^$2=//p" <<<"$1" | tr -d '\r' | head -n 1
}
web_vars="$(railway variables --service web --kv </dev/null)" \
  || die "Could not read the web service's variables; refusing to continue (secrets must not be regenerated)"
worker_vars="$(railway variables --service worker --kv </dev/null)" \
  || die "Could not read the worker service's variables; refusing to continue (secrets must not be regenerated)"

web_key="$(read_var "$web_vars" ENCRYPTION_KEY)"
worker_key="$(read_var "$worker_vars" ENCRYPTION_KEY)"
if [ -n "$web_key" ] && [ -n "$worker_key" ] && [ "$web_key" != "$worker_key" ]; then
  die "web and worker have different ENCRYPTION_KEY values; set both to the one that encrypted your data, then re-run"
fi
ENCRYPTION_KEY="${web_key:-$worker_key}"
SESSION_SECRET="$(read_var "$web_vars" SESSION_SECRET)"
[ -n "$SESSION_SECRET" ] || SESSION_SECRET="$(read_var "$worker_vars" SESSION_SECRET)"

# node's crypto rather than openssl: Git Bash's openssl can end its output with
# "\r", which the app would then reject (or use) as part of the key.
random_hex() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'; }

if [ -z "$ENCRYPTION_KEY" ]; then
  [ -z "$SESSION_SECRET" ] || echo "  SESSION_SECRET exists without a key; keeping it"
  ENCRYPTION_KEY="$(random_hex)"
  SESSION_SECRET="${SESSION_SECRET:-$(random_hex)}"
  say "Generated new ENCRYPTION_KEY and SESSION_SECRET"
else
  [ -n "$SESSION_SECRET" ] \
    || die "ENCRYPTION_KEY exists but SESSION_SECRET is missing; set SESSION_SECRET on web and worker (32+ characters) and re-run"
  say "Reusing existing secrets"
fi
[[ $ENCRYPTION_KEY =~ ^[0-9a-fA-F]{64}$ ]] || die "ENCRYPTION_KEY is not 64 hex characters"
[ ${#SESSION_SECRET} -ge 32 ] || die "SESSION_SECRET is shorter than 32 characters"

set_vars() {
  local service="$1"; shift
  railway variables --service "$service" --skip-deploys "$@" >/dev/null
}

# shellcheck disable=SC2016  # ${{...}} are Railway references, resolved by Railway
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
# Pin the web port so the public domain and the app always agree
# (the Dockerfile EXPOSEs 3000; Railway would otherwise inject its own PORT).
# The worker's port is pinned too: web reaches its internal browser API over
# Railway's private network at worker.RAILWAY_PRIVATE_DOMAIN:3001 (contract K3).
# shellcheck disable=SC2016  # a Railway reference, resolved by Railway, not the shell
set_vars web    "${COMMON[@]}" --set "SERVICE_ROLE=web" --set "PORT=3000" --set "APP_URL=$BASE_URL" \
                --set "OWNER_EMAIL=$OWNER_EMAIL" --set "OWNER_PASSWORD=$OWNER_PASSWORD" \
                --set "SEED_SITE=${SEED_SITE:-}" \
                --set 'WORKER_INTERNAL_URL=http://${{worker.RAILWAY_PRIVATE_DOMAIN}}:3001'
set_vars worker "${COMMON[@]}" --set "SERVICE_ROLE=worker" --set "WORKER_CONCURRENCY=2" --set "PORT=3001" \
                --set "BROWSER_MAX_SESSIONS=${BROWSER_MAX_SESSIONS:-3}"

# ---------------------------------------------------------------- deploy
# The web container runs migrations before it starts serving (scripts/start.sh), so
# a failed migration fails the health check and the old release keeps serving.
say "Deploying web (runs migrations first)"
railway up --service web --detach
say "Deploying worker"
railway up --service worker --detach

# ---------------------------------------------------------------- wait for health
# Status of a service's newest deployment (SUCCESS once its /api/ready health
# check has passed, see railway.json). Polling this rather than the public URL
# means a re-run does not mistake the previous, still-serving release for the new one.
latest_status() {
  railway deployment list --service "$1" --limit 1 --json </dev/null 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let status = "";
      try {
        const j = JSON.parse(s);
        const first = Array.isArray(j) ? j[0] : (j.deployments ?? j.edges ?? [])[0];
        status = first?.status ?? first?.node?.status ?? "";
      } catch {}
      process.stdout.write(String(status).toUpperCase());
    });' || true
}

wait_deployment() { # wait_deployment <service> <minutes>
  local service="$1" polls=$(( $2 * 12 )) status="" i
  for i in $(seq 1 "$polls"); do
    status="$(latest_status "$service")"
    case "$status" in
      SUCCESS) echo "  $service: deployed and healthy"; return 0 ;;
      FAILED|CRASHED|REMOVED) die "$service deployment $status; check 'railway logs --service $service'" ;;
    esac
    [ $((i % 12)) = 0 ] && echo "  $service: ${status:-pending} ($((i / 12)) min) - logs: railway logs --service $service --build"
    sleep 5
  done
  echo "  $service: still ${status:-unknown} after $2 min; check 'railway logs --service $service'"
  return 1
}

say "Waiting for the web deployment (migrations, then /api/ready)"
wait_deployment web 15 || true
say "Waiting for the worker deployment"
wait_deployment worker 10 || true

say "Checking $BASE_URL/api/ready"
for i in $(seq 1 24); do
  if curl -sf -m 10 "$BASE_URL/api/ready" >/dev/null; then echo "  ready"; break; fi
  [ "$i" = 24 ] && die "web is not answering on $BASE_URL; check 'railway logs --service web'"
  sleep 5
done

# The owner account is created inside the web container on its first start
# (scripts/start.sh), only ever against an empty users table. The password is
# removed from Railway only once signing in with it has been seen to work;
# otherwise it stays so a fixed bootstrap can still use it on the next start.
say "Checking the owner account"
login_body="$(OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$OWNER_PASSWORD" node -e \
  'process.stdout.write(JSON.stringify({ email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD }))')"
login_status="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST "$BASE_URL/api/auth/login" \
  -H 'content-type: application/json' --data-binary @- <<<"$login_body" || true)"
if [ "$login_status" = "200" ]; then
  echo "  $OWNER_EMAIL can sign in; removing OWNER_PASSWORD from Railway"
  railway variable delete OWNER_PASSWORD --service web </dev/null >/dev/null 2>&1 \
    || echo "  could not remove it automatically: delete OWNER_PASSWORD in web > Variables"
else
  printf '\n\033[1;33m! Signing in as %s failed (HTTP %s). OWNER_PASSWORD is kept.\033[0m\n' "$OWNER_EMAIL" "${login_status:-none}"
  echo "  Look for '[start] ERROR' or '[seed]' in: railway logs --service web"
  echo "  (An account that already existed keeps its own password; the bootstrap never changes it.)"
fi

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
