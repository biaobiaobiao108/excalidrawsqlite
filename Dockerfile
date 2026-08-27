# Stage 1: Build packages and frontend app with Bun
FROM oven/bun:1.4.0-alpine AS builder

WORKDIR /app

# Copy dependency configs
COPY package.json bun.lock ./
COPY packages/common/package.json ./packages/common/
COPY packages/math/package.json ./packages/math/
COPY packages/laser-pointer/package.json ./packages/laser-pointer/
COPY packages/fractional-indexing/package.json ./packages/fractional-indexing/
COPY packages/element/package.json ./packages/element/
COPY packages/utils/package.json ./packages/utils/
COPY packages/excalidraw/package.json ./packages/excalidraw/
COPY excalidraw-app/package.json ./excalidraw-app/

# Install dependencies with frozen lockfile
RUN bun install --frozen-lockfile

# Copy source files
COPY . .

# Build all packages and the frontend app
RUN bun run build:packages && bun run build

# Stage 2: Production runtime with Bun + SQLite
FROM oven/bun:1.4.0-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DB_PATH=/app/data/excalidraw.db
ENV FILES_DIR=/app/data/files
ENV STATIC_DIR=/app/excalidraw-app/build

# Create data directory for SQLite persistence and run the service as the
# unprivileged Bun user. Bind-mounted data directories should be owned by the
# same UID (or overridden in compose with CONTAINER_UID/CONTAINER_GID).
RUN mkdir -p /app/data/files && chown -R bun:bun /app/data

# Copy backend server code and built frontend static assets
COPY server ./server
COPY package.json ./
COPY --from=builder /app/excalidraw-app/build ./excalidraw-app/build

EXPOSE 8080

VOLUME ["/app/data"]

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["bun", "run", "server/server.ts"]
