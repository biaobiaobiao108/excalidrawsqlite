# Stage 1: Build packages and frontend app with Bun
FROM oven/bun:1.4-alpine AS builder

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
FROM oven/bun:1.4-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/app/data/excalidraw.db

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

# Copy backend server code and built frontend static assets
COPY server ./server
COPY package.json ./
COPY --from=builder /app/excalidraw-app/build ./excalidraw-app/build

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["bun", "run", "server/server.ts"]
