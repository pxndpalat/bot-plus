# Keep the runtime aligned with package.json's pinned Bun toolchain.
FROM oven/bun:1.4.2-alpine AS base

WORKDIR /app
ENV NODE_ENV=production

FROM base AS dependencies

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN bun run build

FROM base AS production-dependencies

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runner

WORKDIR /app
ENV NODE_ENV=production

# The image contains only runtime dependencies and the compiled app. Migration
# sources are retained because the release migration step executes through Bun.
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/infrastructure/db ./src/infrastructure/db

USER bun
EXPOSE 3000

# Bun has fetch but the minimal Alpine image does not promise curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

# The application handles SIGTERM and drains HTTP/worker resources before exit.
STOPSIGNAL SIGTERM
CMD ["bun", "dist/index.js"]
