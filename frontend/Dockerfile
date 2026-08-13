# Stage 1: Build
# Build context must be the repo root (set in docker-compose.yml)
# so we can access root package.json / package-lock.json / tsconfig.base.json
FROM node:20 AS builder

WORKDIR /app

# Copy workspace manifest files from repo root
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy frontend package files
COPY frontend/package.json ./frontend/

# Install all workspace dependencies (npm workspaces)
# --include=dev (DEPLOY-ZB-T3): platforms such as Zeabur inject the service's
# runtime env vars (including our own NODE_ENV=production) into the Docker
# BUILD environment too. Under NODE_ENV=production, `npm ci` silently skips
# devDependencies — including vite/typescript, both needed for this build —
# which would break `npm run build` below. The build stage must not be
# sensitive to an externally-injected NODE_ENV.
RUN npm ci --ignore-scripts --include=dev

# Copy frontend source
COPY frontend/ ./frontend/

# Build frontend (vite build)
WORKDIR /app/frontend
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:stable AS runtime

# Copy built assets
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy nginx configuration as a template: the nginx:stable base image's
# entrypoint (/docker-entrypoint.d/20-envsubst-on-templates.sh, run before
# `exec "$@"`) runs envsubst on every /etc/nginx/templates/*.template file
# and writes the result to /etc/nginx/conf.d/ under the same base name.
# BACKEND_UPSTREAM defaults to the docker-compose service name; override at
# deploy time (e.g. Zeabur's <service>.zeabur.internal:3000).
ENV BACKEND_UPSTREAM=backend:3000
# NGINX_ENVSUBST_FILTER restricts the entrypoint's envsubst substitution to
# only variables whose NAME matches this regex (see the base image's
# 20-envsubst-on-templates.sh: without a filter it substitutes ANY env var
# present in the container, by name, wherever that name appears in the
# template — including as an accidental match of an nginx built-in variable
# like $host/$uri/$scheme if someone happens to set an env var of that exact
# lowercase name). Restricting to exactly BACKEND_UPSTREAM turns "no other
# env var happens to collide with an nginx variable name" from a naming
# coincidence into a structural guarantee.
ENV NGINX_ENVSUBST_FILTER=^BACKEND_UPSTREAM$
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
