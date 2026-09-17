# Production Foundation v0.3

This slice ports the validated concepts from the v0.2 prototype into the production monorepo without wiring UI or queue execution prematurely.

## Domain boundaries

1. **Observe** — `AuditRun`, `PageSnapshot`, and `SeoIssue` record what was measured. Audit evidence is never overwritten by a later run.
2. **Decide** — recommendations map issues to an action type and execution risk.
3. **Approve** — review-required actions receive an `Approval` record. Approval is data, not a front-end-only state.
4. **Execute** — `SeoFix` stores the requested payload, result, errors, and rollback lifecycle.
5. **Measure** — `MetricSnapshot` supports before/after impact analysis across crawler, Search Console, GA4, YouTube, and Instagram.
6. **Grow** — `ContentOpportunity` is intentionally separate from technical fixes so the primary Optimize Existing workflow stays distinct from Create & Grow.

## Safety invariants

- Redirects, URL changes and page merges are never autonomous.
- Canonical, robots, sitemap, internal-link and content-rewrite changes require approval.
- Only metadata/schema/image-alt actions are initially classified as low-risk auto-fix candidates.
- Every applied fix must be attributable to an issue or explicit user action and retain its payload/result for audit history.
- Connector credentials live in a secret manager; the database stores only an opaque `credentialRef`.
- The crawler rejects obvious localhost/private-network targets. Production deployment must additionally enforce network-level egress controls to defend against DNS rebinding and metadata-service access.

## Crawler v0.3

`@seo-table/crawler` now provides:

- bounded same-host crawl
- timeout and response-size limits
- basic SSRF input guards
- semantic extraction for title, description, canonical, robots, H1, image alt and links
- page-level scoring
- robots/sitemap availability probes
- duplicate title/description detection
- site-level audit result contract

The parser intentionally has no heavy browser dependency. JavaScript-rendered sites will require the later browser-rendering worker path.

## Next integration slice

The next PR should create a real `AuditRun` in Postgres, enqueue it in Redis/BullMQ, persist page snapshots/issues from `auditSite`, and expose run status through the Next.js API. Only after that contract is proven should the approved bilingual dashboard consume the live data.
