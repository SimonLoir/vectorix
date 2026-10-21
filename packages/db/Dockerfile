# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store-v11,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --filter @repo/db... --store-dir=/pnpm/store
USER node
CMD ["pnpm", "--filter", "@repo/db", "migrate:deploy"]
