#!/bin/bash
# check-late-mem.sh — standalone health check for split LATE memory infra.
#
# Verifies:
#   - PostgreSQL: row count of late.memories above min threshold
#   - Qdrant:    points_count of LATE collection above min threshold
#
# Designed to be invoked from a larger monitoring loop (cron + ntfy/Telegram).
# Returns:
#   0 = OK
#   1 = WARN (alive but degraded — counts below threshold)
#   2 = ERROR (cannot reach service)
#
# Required env (no defaults):
#   PGPASSWORD            PostgreSQL password
#   LATE_QDRANT_API_KEY   Qdrant API key
#
# Optional env (safe defaults):
#   LATE_PG_HOST           127.0.0.1
#   LATE_PG_PORT           5432
#   LATE_PG_USER           late_app
#   LATE_PG_DATABASE       late_mem
#   LATE_PG_SCHEMA         late
#   LATE_PG_MIN_ROWS       18000
#   LATE_QDRANT_HOST       127.0.0.1
#   LATE_QDRANT_PORT       6333
#   LATE_QDRANT_COLLECTION late__memories
#   LATE_QDRANT_MIN_POINTS 17000
#
# Example use in a wrapper:
#   if ! ./check-late-mem.sh; then ntfy_alert "$(./check-late-mem.sh 2>&1)"; fi

set -u

: "${PGPASSWORD:?PGPASSWORD env var required}"
: "${LATE_QDRANT_API_KEY:?LATE_QDRANT_API_KEY env var required}"

PG_HOST="${LATE_PG_HOST:-127.0.0.1}"
PG_PORT="${LATE_PG_PORT:-5432}"
PG_USER="${LATE_PG_USER:-late_app}"
PG_DB="${LATE_PG_DATABASE:-late_mem}"
PG_SCHEMA="${LATE_PG_SCHEMA:-late}"
PG_MIN="${LATE_PG_MIN_ROWS:-18000}"
QDRANT_HOST="${LATE_QDRANT_HOST:-127.0.0.1}"
QDRANT_PORT="${LATE_QDRANT_PORT:-6333}"
QDRANT_COLLECTION="${LATE_QDRANT_COLLECTION:-late__memories}"
QDRANT_MIN="${LATE_QDRANT_MIN_POINTS:-17000}"

EXIT=0

# --- PG check ---
PG_COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tA \
  -c "SELECT count(*) FROM ${PG_SCHEMA}.memories" 2>/dev/null | tr -d ' ')
if [[ ! "$PG_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR LATE-PG ${PG_HOST}:${PG_PORT}: cannot reach ${PG_DB}.${PG_SCHEMA}.memories" >&2
  EXIT=2
elif (( PG_COUNT < PG_MIN )); then
  echo "WARN  LATE-PG ${PG_HOST}:${PG_PORT}: memories=${PG_COUNT} (expected >= ${PG_MIN})" >&2
  (( EXIT < 1 )) && EXIT=1
else
  echo "OK    LATE-PG ${PG_HOST}:${PG_PORT}: memories=${PG_COUNT}"
fi

# --- Qdrant check ---
QDRANT_POINTS=$(curl -sS -m 5 -H "api-key: $LATE_QDRANT_API_KEY" \
  "http://${QDRANT_HOST}:${QDRANT_PORT}/collections/${QDRANT_COLLECTION}" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["points_count"])' 2>/dev/null)
if [[ ! "$QDRANT_POINTS" =~ ^[0-9]+$ ]]; then
  echo "ERROR LATE-Qdrant ${QDRANT_HOST}:${QDRANT_PORT}: cannot reach collection ${QDRANT_COLLECTION}" >&2
  EXIT=2
elif (( QDRANT_POINTS < QDRANT_MIN )); then
  echo "WARN  LATE-Qdrant ${QDRANT_HOST}:${QDRANT_PORT}: points=${QDRANT_POINTS} (expected >= ${QDRANT_MIN})" >&2
  (( EXIT < 1 )) && EXIT=1
else
  echo "OK    LATE-Qdrant ${QDRANT_HOST}:${QDRANT_PORT}: points=${QDRANT_POINTS}"
fi

exit "$EXIT"
