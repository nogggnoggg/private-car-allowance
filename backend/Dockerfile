# Stage 1: Build
# Context: repo root (see docker-compose.yml build.context)
# This gives us access to root package.json / package-lock.json / tsconfig.base.json
FROM node:20 AS builder

WORKDIR /app

# Copy workspace manifest files (root level)
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy backend package files and prisma schema
COPY backend/package.json ./backend/
COPY backend/tsconfig.json ./backend/
COPY backend/prisma/ ./backend/prisma/

# Install all workspace dependencies (npm workspaces)
# NOTE: prisma/@prisma/client are NOT hoisted to root node_modules by npm workspaces;
# they stay in backend/node_modules. Root node_modules gets shared/hoisted deps only.
RUN npm ci

# Copy backend source
COPY backend/src/ ./backend/src/

# Generate Prisma client and compile TypeScript
WORKDIR /app/backend
RUN npm run build

# Stage 2: Production runtime (node:20-slim — no curl, use node fetch for healthcheck)
FROM node:20-slim AS runtime

WORKDIR /app

# Install openssl — required by Prisma schema engine for migrate deploy
# node:20-slim is Debian-based (bookworm); openssl satisfies libssl dependency
RUN apt-get update -y && apt-get install -y openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Create non-root group and user for security, with a proper home directory
RUN groupadd -r appgroup && useradd -r -g appgroup -d /home/appuser -m appuser

# Copy root node_modules (hoisted shared deps: fastify, zod, pino, dotenv, etc.)
COPY --from=builder /app/node_modules ./node_modules

# Copy backend-specific node_modules (prisma, @prisma/client — not hoisted in npm workspaces)
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# Copy built application artifacts
COPY --from=builder /app/backend/dist ./backend/dist

# Copy prisma schema and migrations (needed for migrate deploy at startup)
COPY --from=builder /app/backend/prisma ./backend/prisma

# Copy package manifests (needed for module resolution and node_modules symlink)
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/backend/package.json ./backend/package.json

# Copy entrypoint script
COPY backend/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app /home/appuser

USER appuser

WORKDIR /app/backend

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
