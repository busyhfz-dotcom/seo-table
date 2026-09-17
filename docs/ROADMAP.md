# SEO Table Roadmap

## v0.3 - Production foundation
- [x] Production audit/fix/approval domain model
- [x] Connector and social-account persistence model
- [x] Metric history and content-opportunity model
- [x] Bounded multi-page crawler contract
- [x] SEO scoring and duplicate detection
- [x] Auto-fix vs approval safety policy
- [x] CI validation for Prisma + core TypeScript packages
- [ ] Persist AuditRun through the worker queue
- [ ] Replace placeholder scan APIs with database-backed endpoints

## v0.4 - Optimize Existing end-to-end
- Worker orchestration: Crawl -> Analyze -> Score -> Plan -> Approval/Auto-Fix -> Recheck
- Real dashboard data
- Audit history and before/after comparison
- WordPress connector for reversible changes
- Google Search Console connector
- GA4 metrics

## v0.5 - Multi-channel optimization
- YouTube OAuth/Data API connector
- Instagram/Meta Graph connector
- Existing-content metadata recommendations
- Cross-channel semantic consistency checks

## v0.6 - Create & Grow
- Keyword/content gap analysis
- Topic clusters
- Article/video/post briefs
- Draft -> Approval -> Publish workflow

## Production hardening
- RBAC and workspace isolation tests
- secret manager integration
- network egress policy for crawler workers
- rate limits, retries and idempotency
- observability, backups and incident runbooks
- billing and quotas
