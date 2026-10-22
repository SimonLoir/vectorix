# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN npm install --global pnpm@11.25.0
WORKDIR /app

FROM base AS deps
ENV CI=true
RUN apk add --no-cache python3 make g++
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/workers/package.json ./apps/workers/package.json
COPY packages ./packages
RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM deps AS build
COPY . .
# Next's separate TypeScript worker can exceed Node's default ~4 GiB heap.
# Keep the larger heap confined to the build stage; the runtime image is unchanged.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN pnpm --filter @repo/db generate
RUN pnpm --filter admin build

FROM node:24-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3006
RUN adduser -D nextjs
COPY --from=build --chown=nextjs:node /app/apps/admin/.next/standalone ./
COPY --from=build --chown=nextjs:node /app/apps/admin/.next/static ./apps/admin/.next/static
USER nextjs
WORKDIR /app/apps/admin
EXPOSE 3006
CMD ["node", "server.js"]
