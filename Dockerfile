# syntax=docker/dockerfile:1.7

# ---- Dependency layer: install production-only deps ----
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Runtime image ----
FROM oven/bun:1-alpine
LABEL org.opencontainers.image.source="https://github.com/greatbody/roundtable"
LABEL org.opencontainers.image.description="Roundtable — backend-driven multi-agent discussion platform"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Bring in production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data

# SQLite database lives here; mount a volume in production
RUN mkdir -p /data && chown -R bun:bun /data /app
VOLUME ["/data"]

EXPOSE 3001

# Run as the non-root user shipped in the official bun image
USER bun

CMD ["bun", "src/index.ts"]
