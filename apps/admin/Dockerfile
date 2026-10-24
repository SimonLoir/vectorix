# syntax=docker/dockerfile:1.7

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
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

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3006
RUN adduser -D nextjs
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static
# Application files stay root-owned; only the Next.js cache is writable.
RUN mkdir -p apps/admin/.next/cache && chown nextjs:node apps/admin/.next/cache
USER nextjs
WORKDIR /app/apps/admin
EXPOSE 3006
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3006)+'/sign-in',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
