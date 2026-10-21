# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for the Vectorix BullMQ workers.
FROM node:24-alpine AS base

RUN apk add --no-cache libc6-compat openssl
RUN npm install --global pnpm@11.25.0

WORKDIR /app

FROM base AS deps
ENV CI=true

RUN apk add --no-cache python3 make g++

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/workers/package.json ./apps/workers/package.json
COPY packages ./packages

RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM deps AS build

COPY . .


RUN pnpm --filter @repo/db generate
RUN pnpm --filter workers build

# Derive a production deployment from the shared lockfile without optional
# peers (Next, TypeScript) or native accelerators; pure-JS fallbacks are used.
RUN pnpm --config.inject-workspace-packages=true deploy --filter workers --prod --no-optional /out

FROM node:24-alpine AS runner

ENV NODE_ENV=production

RUN apk add --no-cache libc6-compat openssl
RUN adduser -D workers

WORKDIR /app

COPY --from=build --chown=workers:node /out/package.json ./package.json
COPY --from=build --chown=workers:node /out/node_modules ./node_modules
COPY --from=build --chown=workers:node /app/apps/workers/dist ./dist

USER workers

CMD ["node", "dist/index.mjs"]
