# SEO Table

SEO audit, fix and approval console. It crawls a site, records what it finds as
an append-only history, scores it, proposes fixes, applies the safe ones on its
own, and routes everything else to a person for approval.

Persian (RTL) is the default interface language; English (LTR) is fully
supported.

## What is in here

```
apps/
  web/            Next.js 15 — the interface and the HTTP API
  worker/         BullMQ worker — runs scans and fix executions
packages/
  db/             Drizzle schema, SQL migrations, the database guards
  core/           crawler, rules, scoring, safety policy, RBAC, rate limits, queue
  connectors/     WordPress, Search Console, GA4, Instagram, YouTube
  pipeline/       analysis, fix execution, rollback, agent mode
tests/            end-to-end tests against a real HTTP fixture site
scripts/          seed, smoke test, fixture server, container entrypoint, Railway deploy
design/           the approved UI prototype and design tokens
```

## How a scan works

```
POST /api/projects/:id/scans  (Idempotency-Key)
  → audit_runs row (QUEUED)             ← unique (project, key): a replay returns the same run
                                        ← partial unique index: one active run per project
  → BullMQ job "audit-<runId>"          ← job id derived from the run: one job per run
  → worker: crawl (robots.txt, rate limit, timeouts, page cap)
  → page_snapshots (one row per URL per run, redirects recorded, not followed blindly)
  → 26 rules → seo_issues (roll-up) + issue_occurrences (append-only ledger)
  → score (per page, averaged, capped per category)
  → fix proposals → agent: LOW risk applied, everything else to the approval queue
GET /api/scans/:id  → status, progress, score, pages
```

Retries use exponential backoff (3 attempts); a run that exhausts them is marked
`DEAD_LETTER` with its error. A worker that crashes mid-run leaves nothing
stuck: runs older than an hour are released on the next worker start.

## The rules the code is not allowed to break

These are enforced by the database, not just by application code, so a bug or a
stray script cannot violate them:

| Invariant | Enforced by |
|---|---|
| One active scan per project | partial unique index `audit_runs_one_active_per_project` |
| `issue_occurrences` and `audit_log` are append-only | trigger rejecting UPDATE/DELETE; deletion only through an explicit purge flag |
| Redirect, URL change and page merge never execute without human approval | trigger on `fix_proposals` + safety policy + API check |
| An agent can request approval but never grant it | `proposalService.decide` refuses non-USER actors |

## Execution safety policy

| Risk | Actions | Automatic? |
|---|---|---|
| LOW | image alt text, add to sitemap, trim meta description | agent may apply |
| SENSITIVE | title, H1, canonical, robots, internal links | approval required |
| RESTRICTED | redirect, URL change, page merge | approval required, no automatic path at all |

Every live apply requires a prior dry run, is capped at `MAX_CHANGES_PER_EXECUTION`
changes, records the value it replaces, and refuses to overwrite a page that was
edited after the scan. Rollback restores the recorded values.

## Running locally

Requirements: Node 22, pnpm 10, PostgreSQL 16, Redis 7.

```bash
cp .env.example .env            # then set ENCRYPTION_KEY and SESSION_SECRET:
                                #   openssl rand -hex 32
pnpm install
pnpm db:migrate
SEED_EMAIL=you@example.com SEED_PASSWORD='at-least-10-chars' pnpm exec tsx scripts/seed.ts

pnpm dev:worker                 # terminal 1
pnpm dev:web                    # terminal 2 → http://localhost:3000
```

## Tests

```bash
pnpm test                       # 73 tests: unit, pipeline end-to-end, agent + WordPress
pnpm -r typecheck
pnpm --filter @seo/web lint
```

The end-to-end tests crawl a real HTTP fixture site (`tests/fixture-site.ts`)
with deliberate defects and a WordPress REST double (`tests/fake-wordpress.ts`),
against real PostgreSQL and Redis.

Smoke test against any running deployment:

```bash
BASE_URL=https://your-app SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_SITE=https://a-site-you-own pnpm smoke
```

## Connectors

- **WordPress** — REST API with an Application Password. Title and image alt text
  work on any WordPress. SEO title, meta description, canonical, robots and
  redirects need the bridge plugin in
  `packages/connectors/wordpress-plugin/seo-table-bridge.php` (install as a
  must-use plugin); without it those fixes fail with an explicit
  "unsupported field" rather than pretending to succeed.
- **Search Console / GA4** — service-account key or OAuth refresh token. Content
  Opportunities is built only from Search Console data; with no connector it is
  empty.
- **Instagram / YouTube** — connector, token handling and OAuth flow are
  implemented, but no OAuth application is registered yet. They report "not
  connected" and show no data until one is.

## Deploying

See [`docs/DEPLOY.md`](docs/DEPLOY.md). Short version, with the Railway CLI logged in:

```bash
OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' ./scripts/deploy-railway.sh
```
