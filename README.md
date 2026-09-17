# SEO Table

AI-powered SEO growth operating system.

## Vision
Improve existing websites without forcing new content production.

## Optimization Modes

### Invisible Mode
- Preserve website design
- Apply safe SEO improvements
- Metadata, schema, technical optimization

### Full Optimization Mode
- Allow deeper SEO changes
- Structural improvements
- Controlled experiments

## Architecture

- Next.js Web Application
- Background Workers
- PostgreSQL + Prisma
- Redis Queues
- AI Recommendation Engine
- SEO Crawler
- Connectors

## Reference implementation — v0.2.0

The product redesign session produced a working bilingual reference implementation covering the approved dashboard, FastAPI API, multi-page SEO audit flow, scoring, safe auto-fix planning, approval queue, content opportunities, connectors, Docker and tests.

It is preserved under `prototype/organic-growth-agent-v0.2.0/` without replacing the production monorepo architecture. The full clean source snapshot is stored as `SEOTable-platform-v0.2.0-source.zip` with a SHA256 checksum next to it.

The next engineering phase is to port validated behavior from this prototype into `apps/web`, workers, database and connector packages in controlled production slices.

## Development Status

Prototype v0.2.0 captured; production integration is the next phase.
