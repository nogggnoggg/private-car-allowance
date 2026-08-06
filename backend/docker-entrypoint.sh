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
# (see docker-compose.yml). REPORT_STORAGE_ROOT (PHASE-008-T7b, Spec §16 D6)
# defaults to /data/storage/pdf — the two roots are prefix-isolated sub-paths of
# the same storage volume, mirroring the att/rpt storage-key prefix isolation.
# ---------------------------------------------------------------------------
if [ -n "$ATTACHMENT_STORAGE_ROOT" ]; then
  mkdir -p "$ATTACHMENT_STORAGE_ROOT"
  chown -R appuser:appgroup "$ATTACHMENT_STORAGE_ROOT"
  echo "Storage directory initialised: $ATTACHMENT_STORAGE_ROOT"
else
  echo "Warning: ATTACHMENT_STORAGE_ROOT not set; storage directory not pre-initialised."
fi

if [ -n "$REPORT_STORAGE_ROOT" ]; then
  mkdir -p "$REPORT_STORAGE_ROOT"
  chown -R appuser:appgroup "$REPORT_STORAGE_ROOT"
  echo "Storage directory initialised: $REPORT_STORAGE_ROOT"
else
  echo "Warning: REPORT_STORAGE_ROOT not set; storage directory not pre-initialised."
fi

echo "Running prisma migrate deploy..."
# Use the prisma binary from backend's node_modules (not hoisted to root in npm workspaces)
# Run migrate deploy as appuser (gosu drops root before executing)
gosu appuser ./node_modules/.bin/prisma migrate deploy

echo "Starting backend server..."
exec gosu appuser node dist/index.js
