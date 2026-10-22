# syntax=docker/dockerfile:1.7

# Dockerfile for running Prisma migrations
# This image is the only place where `prisma migrate deploy` is executed.
# Build context must be the repository root.

# -----------------------
# 1) Base image with pnpm
# -----------------------
FROM node:24-alpine AS base

RUN apk add --no-cache libc6-compat openssl

RUN npm install --global pnpm@11.25.0

WORKDIR /app

# -----------------------
# 2) Dependencies layer
# -----------------------
FROM base AS deps
ENV CI=true

RUN apk add --no-cache python3 make g++

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches ./patches
COPY packages ./packages

RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @repo/db... --store-dir=/pnpm/store

RUN pnpm --filter @repo/db exec prisma --version

# -----------------------
# 3) Runner layer
# -----------------------
FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules

# Copy the prisma schema and migrations
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY packages/db/package.json ./packages/db/package.json

WORKDIR /app/packages/db

USER node

CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
