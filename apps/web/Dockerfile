# syntax=docker/dockerfile:1.7

# Multi-stage Dockerfile for Next.js (standalone) in a pnpm + turbo monorepo
# Runtime Node requirement per repo engines: Node 24

# -----------------------
# 1) Base image with pnpm
# -----------------------
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
# Install runtime dependencies for Node.js and Prisma
# - libc6-compat: provides glibc compatibility for Alpine's musl libc (required for some Node.js native modules)
# - openssl: required by Prisma
RUN apk add --no-cache libc6-compat openssl
# Pin pnpm to the version used by the workspace
RUN npm install --global pnpm@11.25.0
WORKDIR /app

# -----------------------
# 2) Dependencies layer
#    - install all workspace deps using lockfile
# -----------------------
FROM base AS deps
ENV CI=true

# Install build dependencies for compiling native modules
# These are only present in the deps/build stages and NOT in the final runtime image
RUN apk add --no-cache python3 make g++

# Only copy files needed to compute dependency graph to leverage Docker cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY patches ./patches
# Copy package manifests for workspaces (kept minimal for caching)
COPY apps/web/package.json ./apps/web/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/workers/package.json ./apps/workers/package.json
COPY packages ./packages

# Install dependencies (workspace-aware)
# Using frozen-lockfile to ensure reproducible builds
RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# -----------------------
# 3) Build layer
#    - builds Next.js app with standalone output
# -----------------------
FROM deps AS build
# Ensure full source is available for build
COPY . .



# Generate Prisma client (in case not covered by postinstall) before app build
# Safe to run without a live DB connection; it only reads schema
RUN pnpm --filter @repo/db generate

# Build only the web app (Next.js)
RUN pnpm --filter web build

# -----------------------
# 4) Runtime layer
#    - copy Next.js standalone output only
# -----------------------
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

# Create a non-root user for security (Alpine uses adduser instead of useradd)
RUN adduser -D nextjs

# Copy the standalone server and required assets from the build stage
# Next.js standalone places a full minimal Node.js server and node_modules into .next/standalone
COPY --from=build /app/apps/web/.next/standalone ./
# Static assets used by the server
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Public assets used at runtime
COPY --from=build /app/apps/web/public ./apps/web/public

# The app listens on PORT (defaults to 3000)
ENV PORT=3000

EXPOSE 3000

# Switch to the non-root user
# Application files stay root-owned; only the Next.js cache is writable.
RUN mkdir -p apps/web/.next/cache && chown nextjs:node apps/web/.next/cache
USER nextjs

# Switch to the app directory inside standalone output and run the server
WORKDIR /app/apps/web

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
