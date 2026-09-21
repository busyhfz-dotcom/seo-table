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

The script creates the project and services, generates `ENCRYPTION_KEY` and
`SESSION_SECRET` once (and reuses them on later runs), sets every variable,
deploys both services, assigns a `*.up.railway.app` domain, waits for
`/api/ready`, and runs the smoke test when `SEED_SITE` is set.

## Manual

1. New project → add **PostgreSQL** and **Redis**.
2. Add a service from this repository, name it `web`. Add a second, `worker`.
3. Variables (both services):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` — **same value on both, never rotate casually** |
   | `SESSION_SECRET` | `openssl rand -hex 32` |
   | `NODE_ENV` | `production` |
   | `QUEUE_PREFIX` | `seo` — must match on both |

   web only: `SERVICE_ROLE=web`, `APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`,
   and for the first boot `OWNER_EMAIL`, `OWNER_PASSWORD`.
   worker only: `SERVICE_ROLE=worker`.

4. Deploy. `railway.json` sets the Dockerfile build, `/api/ready` health check
   and restart policy for both services.
5. web → Settings → Networking → Generate Domain.

## What happens on each deploy

- The web container runs migrations **before** it starts serving
  (`scripts/start.sh`). Migrations are idempotent and serialised with a Postgres
  advisory lock, so several replicas starting together is safe. A failed
  migration exits non-zero, the new release fails its health check, and the
  previous release keeps serving.
- On first boot, if the database has no users, the owner account is created from
  `OWNER_EMAIL`/`OWNER_PASSWORD`. Afterwards this step does nothing, so the
  variables cannot reset a password — but delete `OWNER_PASSWORD` once you have
  signed in anyway.
- The worker releases any run a previous crash left in `RUNNING`.

## Health checks

| Service | Liveness | Readiness |
|---|---|---|
| web | `GET /api/health` | `GET /api/ready` — PostgreSQL + Redis + queue depth |
| worker | `GET /health` | `GET /ready` (also `/api/ready`) — PostgreSQL + Redis + workers running |

## Custom domain and TLS

web → Settings → Networking → Custom Domain → enter e.g. `app.example.ir`.
Create the CNAME Railway shows at your DNS provider. Railway issues and renews
the certificate once the record resolves. Then set `APP_URL` to the new origin.
Session cookies are `Secure` in production, so the app must be served over HTTPS.

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
