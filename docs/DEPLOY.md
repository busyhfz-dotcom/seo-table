# Deploying to Railway

Four services in one Railway project: **PostgreSQL**, **Redis**, **web** and
**worker**. Web and worker are built from the same `Dockerfile`; `SERVICE_ROLE`
decides which one a container runs.

## Automated

```bash
npm i -g @railway/cli
railway login
OWNER_EMAIL=you@example.com OWNER_PASSWORD='a-long-password' \
SEED_SITE=https://your-site.ir \
./scripts/deploy-railway.sh
```

In order, the script:

1. creates the project, PostgreSQL (unless `EXTERNAL_DATABASE_URL`), Redis, and
   the `web` and `worker` services;
2. assigns the `*.up.railway.app` domain **before** the first deploy, so
   `APP_URL` is set to the real address;
3. generates `ENCRYPTION_KEY` and `SESSION_SECRET` once, with Node's crypto (no
   stray `\r` under Git Bash). On later runs it reuses them and never replaces
   them: if the current variables cannot be read, or a key exists without a
   session secret, it stops instead of guessing;
4. sets every variable and deploys both services;
5. waits for each service's deployment to pass its health check, then for
   `/api/ready` on the public address;
6. signs in as the owner, and only if that works removes `OWNER_PASSWORD` from
   Railway (otherwise it is kept and the script says where to look);
7. runs the smoke test when `SEED_SITE` is set.

Run it from Git Bash or WSL on Windows (it needs bash, curl and node).

## PostgreSQL on Neon instead of Railway

Set `EXTERNAL_DATABASE_URL` and the script skips the Railway Postgres service
(three Railway services instead of four):

```bash
EXTERNAL_DATABASE_URL='postgresql://…@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require' \
OWNER_EMAIL=… OWNER_PASSWORD=… ./scripts/deploy-railway.sh
```

- Copy the connection string from Neon → Connect. The script switches a
  `-pooler` host to the direct endpoint (migrations hold a session-level
  advisory lock, which PgBouncer's transaction mode does not keep), drops
  `channel_binding` and sets `sslmode=verify-full`.
- Pick a Neon region close to Railway's (e.g. Frankfurt with EU West).
- Neon's free tier suspends compute after a few idle minutes; the first query
  afterwards takes ~0.5 s longer. The pool tolerates the server closing idle
  connections.
- Keep Redis on Railway: BullMQ polls Redis continuously, which exhausts
  request-metered free Redis plans quickly.

## Manual

1. New project → add **PostgreSQL** and **Redis**.
2. Add a service from this repository, name it `web`. Add a second, `worker`.
3. Variables (both services):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `ENCRYPTION_KEY` | 64 hex characters (below) — **same value on both, never rotate casually** |
   | `SESSION_SECRET` | 32+ characters (below) |
   | `NODE_ENV` | `production` |
   | `QUEUE_PREFIX` | `seo` — must match on both |

   Generate each secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   (or `openssl rand -hex 32`). Leading/trailing whitespace is ignored.

   web only: `SERVICE_ROLE=web`, `PORT=3000`, and for the first boot
   `OWNER_EMAIL`, `OWNER_PASSWORD`.
   worker only: `SERVICE_ROLE=worker`.

4. web → Settings → Networking → Generate Domain (port 3000). Then set
   `APP_URL` on web to that `https://…` address. `APP_URL` is optional and only
   informational; a value of `https://${{RAILWAY_PUBLIC_DOMAIN}}` set before the
   domain exists renders as a bare `https://`, which is treated as unset.
5. Deploy both. `railway.json` sets the Dockerfile build, the `/api/ready`
   health check (300 s, so the worker can wait for migrations), a 60 s draining
   window and the restart policy for both services. There is no start command:
   the image's own entrypoint (`tini` → `scripts/start.sh`) runs, so signals
   reach Node and shutdown is graceful.
6. Sign in, then delete `OWNER_PASSWORD` from web.

`railway.json` is Railway's (legacy) config-as-code file; Railway has announced
the end of legacy file support on 1 December 2026. If it is no longer read, set
the same values in each service's Settings.

## What happens on each deploy

- The web container runs migrations **before** it starts serving
  (`scripts/start.sh`). Migrations are idempotent and serialised with a Postgres
  advisory lock, so several replicas starting together is safe. A failed
  migration exits non-zero, the new release fails its health check, and the
  previous release keeps serving.
- On first boot, if the database has no users, the owner account is created from
  `OWNER_EMAIL`/`OWNER_PASSWORD`, in one transaction (organization, user,
  membership, optional first project). Afterwards this step does nothing, so the
  variables cannot reset a password — but delete `OWNER_PASSWORD` once you have
  signed in anyway. If the bootstrap fails the app still starts, and the web log
  shows `[start] ERROR: owner bootstrap failed` with the reason on the `[seed]`
  line above it; it is retried on every start until it succeeds.
- The worker starts its health server, then waits (up to 3 minutes) until the
  newest migration in the image is applied — on a fresh deploy the web service
  is applying it at the same moment. If it is still missing, the worker exits
  and Railway restarts it.
- Every 5 minutes (and once at start) the worker releases runs that have had no
  heartbeat for 15 minutes and have no live job in the queue. A job BullMQ gives
  up on (retries exhausted, or stalled too often because its worker died) is
  marked `DEAD_LETTER` at once.
- On redeploy Railway sends `SIGTERM`; the worker stops taking jobs and lets
  running ones finish for up to 50 s, within the 60 s `drainingSeconds`. A scan
  still running then is picked up again by the new worker.

## Health checks

| Service | Liveness | Readiness |
|---|---|---|
| web | `GET /api/health` | `GET /api/ready` — PostgreSQL + Redis + queue depth |
| worker | `GET /health` | `GET /ready` (also `/api/ready`) — PostgreSQL + Redis + workers running |

Readiness answers within about 3 seconds even when PostgreSQL or Redis is
unreachable (503 with the failing check marked `false`), so a probe never hangs.

## Custom domain and TLS

web → Settings → Networking → Custom Domain → enter e.g. `app.example.ir`.
Create the CNAME Railway shows at your DNS provider. Railway issues and renews
the certificate once the record resolves. Then set `APP_URL` to the new origin.
Session cookies are `Secure` in production, so the app must be served over HTTPS;
production builds also send `Strict-Transport-Security` (two years, including
subdomains of the host serving the app).

## Private addresses

In production the crawler and the connectors refuse loopback, private,
link-local and other internal addresses, including after redirects and DNS
changes. `ALLOW_PRIVATE_NETWORK=1` lifts that for local development, tests and
the CI smoke test only; never set it on Railway.

## CI

`.github/workflows/ci.yml` typechecks, lints, migrates (twice, to prove
idempotency), tests, builds, then starts the fixture site, worker and web and
runs the smoke test (with `ALLOW_PRIVATE_NETWORK=1`, since the fixture is on
127.0.0.1). `.github/workflows/security.yml` runs `pnpm audit`, gitleaks and
CodeQL.

CodeQL runs as an *advanced* setup from that workflow. GitHub refuses its
results while the repository's *default* setup is enabled, and the "CodeQL"
check then fails within seconds: turn it off under Settings → Code security →
Code scanning → CodeQL analysis → ⋯ → Disable (or switch it to Advanced). On a
private repository, code scanning also needs GitHub Advanced Security.

## Rolling back

Railway → web → Deployments → pick the previous deployment → Redeploy. Schema
migrations are additive in this release, so the previous code runs against the
newer schema.

## Monitoring hooks

- Structured JSON logs (pino) with secrets redacted by key; every API response
  carries `x-correlation-id`, and the same id travels into the worker job's logs.
- `metric()` in `packages/core/src/logger.ts` is the single sink for counters and
  timers (`scan.enqueued`, `run.succeeded`, `run.dead_letter`, `fix.applied`,
  `agent.auto_applied`, …). Attach an exporter with `onMetric()`; by default
  metrics go to debug logs.
- Queue depth and failed-job counts are exposed on both readiness endpoints.
