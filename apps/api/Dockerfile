# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the API in a pnpm + turbo monorepo
# Uses Alpine for the final API image

# -----------------------
# 1) Base image with pnpm
# -----------------------
FROM node:24-alpine AS base

# Runtime dependencies commonly needed by Node native modules & Prisma
RUN apk add --no-cache libc6-compat openssl

# Pin pnpm to the version used by the workspace
RUN npm install --global pnpm@11.25.0

WORKDIR /app

# -----------------------
# 2) Dependencies layer
#    - install workspace deps with caching
# -----------------------
FROM base AS deps
ENV CI=true

# Build toolchain for native modules (not in final image)
RUN apk add --no-cache python3 make g++

# Copy only files needed to resolve the dependency graph to leverage Docker cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches ./patches

# Copy workspace manifests used by the API and its internal deps
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/workers/package.json ./apps/workers/package.json
COPY packages ./packages

# Install dependencies (workspace-aware) using lockfile
RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# -----------------------
# 3) Build layer
# -----------------------
FROM deps AS build

# Bring in full source to build the api package
COPY . .

# Generate Prisma client for @repo/db (no live DB needed)
RUN pnpm --filter @repo/db generate

# Build the api app (outputs to apps/api/dist)
RUN pnpm --filter api build

# Produce a pruned, production-ready output for just the api package
# This includes the package files, its dist, and a pruned node_modules
# pnpm 11 can derive a dedicated deployment lockfile from the shared lockfile.
# Inject workspace packages at deploy time; exclude optional peers/build tools.
RUN pnpm --config.inject-workspace-packages=true deploy --filter api --prod --no-optional /out

# -----------------------
# 4) Runtime layer (Alpine)
# -----------------------
FROM node:24-alpine AS runner

ENV NODE_ENV=production

# Runtime libs needed by Prisma and other native deps
RUN apk add --no-cache libc6-compat openssl

# Non-root user for security
RUN adduser -D api

WORKDIR /app

# Copy the pruned deployment from build stage
COPY --from=build --chown=api:node /out/package.json ./package.json
COPY --from=build --chown=api:node /out/node_modules ./node_modules
COPY --from=build --chown=api:node /app/apps/api/dist ./dist

USER api

ENV PORT=3001
EXPOSE 3001

# Start the api process
CMD ["node", "dist/index.mjs"]
