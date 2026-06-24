#!/bin/sh
# Entrypoint: sync the DB schema (idempotent) then launch the service.
# Safe to run from every replica: db push / migrate deploy take a lock and are
# no-ops once the schema is current.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
    echo "[entrypoint] applying prisma migrations..."
    npx prisma migrate deploy
  else
    echo "[entrypoint] no migrations dir; syncing schema with db push..."
    npx prisma db push --skip-generate
  fi
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] seeding default tiers..."
  node dist/seed.js || echo "[entrypoint] seed skipped/failed (non-fatal)"
fi

echo "[entrypoint] starting policyd service..."
exec node dist/main.js
