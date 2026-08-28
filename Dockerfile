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

# The Docker build context does not include .git. Pass the source revision from
# CI so the generated frontend version still identifies the published image.
ARG BUILD_SHA=local
ENV BUILD_SHA=$BUILD_SHA
ENV VITE_APP_GIT_SHA=$BUILD_SHA

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

# Create data directory for SQLite persistence. The runtime keeps the base
# image's root default so rootless Podman/Docker bind mounts map to the
# invoking host user without requiring a fixed container UID.
RUN mkdir -p /app/data/files

# Copy only the production backend entrypoint and built frontend static assets
COPY server/server.ts ./server/server.ts
COPY --from=builder /app/excalidraw-app/build ./excalidraw-app/build

EXPOSE 8080

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["bun", "server/server.ts"]
