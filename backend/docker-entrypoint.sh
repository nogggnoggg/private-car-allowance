#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Storage volume initialisation (Spec §8, NFR-US-07, D4)
# ---------------------------------------------------------------------------
# The named volume is mounted at runtime as root. This entrypoint runs as root
# so it can initialise the ATTACHMENT_STORAGE_ROOT sub-directory and chown it
# to appuser before dropping privileges via gosu.
#
# Without this step the appuser process cannot mkdir inside the volume root
# (which Docker creates with root:root 755 ownership on first mount).
#
# ATTACHMENT_STORAGE_ROOT defaults to /data/storage/attachments in compose
# (see docker-compose.yml). The PDF prefix (/data/storage/pdf) is reserved for
# PHASE-008 and does NOT need to be created here.
# ---------------------------------------------------------------------------
if [ -n "$ATTACHMENT_STORAGE_ROOT" ]; then
  mkdir -p "$ATTACHMENT_STORAGE_ROOT"
  chown -R appuser:appgroup "$ATTACHMENT_STORAGE_ROOT"
  echo "Storage directory initialised: $ATTACHMENT_STORAGE_ROOT"
else
  echo "Warning: ATTACHMENT_STORAGE_ROOT not set; storage directory not pre-initialised."
fi

echo "Running prisma migrate deploy..."
# Use the prisma binary from backend's node_modules (not hoisted to root in npm workspaces)
# Run migrate deploy as appuser (gosu drops root before executing)
gosu appuser ./node_modules/.bin/prisma migrate deploy

echo "Starting backend server..."
exec gosu appuser node dist/index.js
