#!/bin/sh
set -e

echo "Running prisma migrate deploy..."
# Use the prisma binary from backend's node_modules (not hoisted to root in npm workspaces)
./node_modules/.bin/prisma migrate deploy

echo "Starting backend server..."
exec node dist/index.js
