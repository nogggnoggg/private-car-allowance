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
RUN npm ci --ignore-scripts

# Copy frontend source
COPY frontend/ ./frontend/

# Build frontend (vite build)
WORKDIR /app/frontend
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:stable AS runtime

# Copy built assets
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
