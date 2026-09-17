# Database Package

Prisma/PostgreSQL persistence for SEOTable.

## v0.3 domain model

The production model separates observation from execution:

- Organizations, projects and memberships
- Websites, pages and immutable page snapshots
- External connectors and social accounts
- Audit runs and normalized SEO issues
- Fix plans with explicit risk and lifecycle state
- Approval records for review-required changes
- Metric snapshots for before/after impact tracking
- Content opportunities for the Create & Grow workflow

Legacy `Scan`, `SeoOpportunity` and `Recommendation` models remain temporarily so the v0.1 web routes can migrate without a flag day.

Credential secrets must not be stored in Prisma JSON fields. `Connector.credentialRef` is an opaque reference to the deployment secret store.
