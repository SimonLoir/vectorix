# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0
WORKDIR /app
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm db:generate
ARG APP=api
RUN pnpm --filter ${APP} build
FROM base AS server
ENV NODE_ENV=production
ARG APP=api
ENV APP=${APP}
COPY --from=build --chown=node:node /app /app
USER node
CMD ["sh", "-c", "exec pnpm --filter \"$APP\" start"]
