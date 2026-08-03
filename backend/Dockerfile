# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build for the JiBUks backend (pnpm workspace monorepo).
#
# Stages: deps (install) -> build (compile all workspace packages, in
# dependency order) -> runtime (the image that actually runs).
#
# Dev dependencies are DELIBERATELY kept in the runtime image -- this lets
# the same image run migrations (node-pg-migrate is a devDependency) via a
# separate docker-compose service, without maintaining a second image.
# ---------------------------------------------------------------------------

FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Copy only manifests first, so `pnpm install` is cached unless a
# package.json or the lockfile actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ledger/package.json packages/ledger/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/server/package.json packages/server/package.json

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

COPY --from=deps /app /app
COPY . .

# Built explicitly in dependency order (matches every `pnpm --filter` build
# command used throughout local development) rather than relying on a root
# tsc --build, since there is no root tsconfig.json referencing all packages.
RUN pnpm --filter @jibuks/domain build \
 && pnpm --filter @jibuks/ledger build \
 && pnpm --filter @jibuks/db build \
 && pnpm --filter @jibuks/server build

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

EXPOSE 3000

# The default command serves traffic. The docker-compose "migrate" service
# overrides this to run migrations instead, using the same image.
CMD ["node", "packages/server/dist/server.js"]