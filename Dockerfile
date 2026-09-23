#
# One image, two services. Railway (or any orchestrator) picks the role with
# SERVICE_ROLE=web|worker; migrations run as the release step, not at build.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# ---- dependencies (cached on the lockfile) --------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/connectors/package.json packages/connectors/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/browser/package.json packages/browser/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
# No BuildKit cache mount: Railway rejects cache mounts whose id is not
# prefixed with its own service id, and the id differs per service.
RUN pnpm install --frozen-lockfile

# ---- build ----------------------------------------------------------------
FROM deps AS build
COPY . .
# A checkout on Windows can turn LF into CRLF, which breaks every shell script
# ("set: Illegal option -"). Normalise them whatever the source machine was.
RUN find . -path ./node_modules -prune -o -name '*.sh' -type f -exec sed -i 's/\r$//' {} +
# The build needs a syntactically valid environment but never connects to it.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    REDIS_URL=redis://localhost:6379 \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001 \
    SESSION_SECRET=build-time-placeholder-not-used-at-runtime-000 \
    NODE_ENV=production \
    pnpm --filter @seo/web build \
 && rm -rf apps/web/.next/cache
# Dev dependencies stay installed: the worker, migrations and the seed script
# run TypeScript through tsx at runtime.

# ---- runtime --------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# The in-panel browser (worker): Chromium's headless shell plus the system
# libraries it needs, installed as root before dropping to the app user, in a
# layer that only changes with the Playwright version. That version must be the
# playwright-core pinned in packages/browser/package.json (checked below), or
# Playwright would look for a Chromium build that is not there. Fonts: Latin,
# Persian/Arabic (DejaVu) and emoji, for pages that do not bring their own.
ARG PLAYWRIGHT_VERSION=1.56.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && npx -y "playwright-core@${PLAYWRIGHT_VERSION}" install --with-deps --only-shell chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/* \
    && groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app /app
RUN cd packages/browser && node -e ' \
      const v = require("playwright-core/package.json").version; \
      if (v !== process.env.PLAYWRIGHT_VERSION) { \
        console.error(`playwright-core is ${v} but the image installed Chromium for ${process.env.PLAYWRIGHT_VERSION}; update PLAYWRIGHT_VERSION`); \
        process.exit(1); \
      }'
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "scripts/start.sh"]
