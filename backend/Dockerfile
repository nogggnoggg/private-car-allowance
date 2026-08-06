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
# `playwright` (backend runtime dependency, Spec §16 D4) IS hoisted to root
# node_modules (verified: no version conflict with root's @playwright/test devDependency).
RUN npm ci

# Download Playwright's pinned Chromium browser binary (PHASE-008-T7b; Spec §16 D4).
# T7b FW-1 (即審): package-lock's playwright/@playwright/test/playwright-core entries
# have NO postinstall script (`hasInstallScript` absent) — `npm ci` alone does NOT
# fetch the browser. This explicit step is required. Revision is derived from the
# installed `playwright` package version (1.62.1 → chromium-1234) — do not hardcode a
# revision number; two revisions (1228/1234) can coexist in local dev caches, and only
# the version resolved by `npm ci` here is authoritative for this image.
# PLAYWRIGHT_BROWSERS_PATH must be set identically in BOTH stages (see runtime stage
# below) so the browser lands at a path the runtime stage can COPY --from=builder and
# the running app can find — the installer's default path (installing user's home
# directory) would otherwise mismatch between builder root and runtime appuser
# (T7b FW-1 "下載路徑地雷").
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium

# Copy backend source
COPY backend/src/ ./backend/src/

# Generate Prisma client and compile TypeScript
WORKDIR /app/backend
RUN npm run build

# Stage 2: Production runtime (node:20-slim — no curl, use node fetch for healthcheck)
FROM node:20-slim AS runtime

WORKDIR /app

# Install openssl — required by Prisma schema engine for migrate deploy
# Install gosu — used by docker-entrypoint.sh to drop root to appuser after
#   initialising the storage volume directory (D4, Spec §8; volume mounted after
#   image layers so mkdir must run at startup as root, not in a RUN layer).
# Install fonts-noto-cjk — CJK glyph coverage for report PDFs (PHASE-008-T7b, Spec
#   §16 D4 附帶批准①／AC-09(c)). Without this package, Chinese characters in a
#   container-rendered PDF render as .notdef "tofu" boxes — a failure that does NOT
#   reproduce on Windows dev machines (which already have system CJK fonts), so it
#   is a high-probability escaped defect if omitted (see T7b Handoff for measurement
#   evidence). report-html.ts's CSS font-family stack does not name "Noto Sans CJK
#   TC" explicitly, but Chromium's fontconfig-backed per-glyph fallback substitutes
#   any installed font that has the required glyph once none of the named families
#   resolve — this is the standard mechanism by which installing fonts-noto-cjk
#   fixes tofu boxes without needing to change the CSS.
# node:20-slim is Debian-based (bookworm); openssl satisfies libssl dependency
RUN apt-get update -y && apt-get install -y openssl gosu fonts-noto-cjk --no-install-recommends && rm -rf /var/lib/apt/lists/*

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

# Playwright Chromium runtime (PHASE-008-T7b, Spec §16 D4).
# Browser binary: copied from the builder stage's download (see builder stage above)
# at the identical PLAYWRIGHT_BROWSERS_PATH — avoids the installer-home-directory
# path mismatch between builder (root) and runtime (appuser) (T7b FW-1).
# OS-level shared libraries (libnss3, libgbm1, libatk*, libasound2, etc.) are NOT
# present in node:20-slim by default and are NOT carried over by COPY --from=builder
# (they belong to the builder image's OS package database, not to node_modules).
# `install-deps` resolves the correct package list for the detected OS (Debian
# bookworm) and the installed `playwright` version, avoiding a hand-maintained
# package list that drifts across Playwright releases (T7b FW-1).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /ms-playwright /ms-playwright
RUN npx playwright install-deps chromium

# Copy entrypoint script
COPY backend/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Set ownership to non-root user for application files
RUN chown -R appuser:appgroup /app /home/appuser /ms-playwright

# NOTE: USER appuser is intentionally NOT set here.
# docker-entrypoint.sh runs as root so it can:
#   1. mkdir -p the storage volume sub-directory (volume mount is root-owned at startup)
#   2. chown it to appuser
#   3. exec gosu appuser to drop privileges before starting node
# The application process itself runs as appuser (see docker-entrypoint.sh).

WORKDIR /app/backend

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
