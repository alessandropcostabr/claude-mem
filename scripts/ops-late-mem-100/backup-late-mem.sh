#!/bin/bash
# backup-late-mem.sh — daily backup of LATE memory PG + Qdrant (split DB topology)
#
# Backs up:
#   - PostgreSQL database (default: late_mem)            → ~/backups/late-mem/pg/
#   - Qdrant collection (default: late__memories)        → ~/backups/late-mem/qdrant/
#
# Retention: 30 days (configurable via RETENTION_DAYS).
# Snapshot file inside Qdrant storage is deleted after download (don't accumulate there).
#
# Required env (no defaults shipped — must be set explicitly):
#   PGPASSWORD   PostgreSQL password for $PG_USER
#   QDRANT_KEY   Qdrant API key (header: api-key)
#
# Optional env (with safe defaults):
#   BACKUP_ROOT      $HOME/backups/late-mem
#   RETENTION_DAYS   30
#   PG_HOST          127.0.0.1
#   PG_PORT          5432
#   PG_USER          late_app
#   PG_DB            late_mem
#   QDRANT_HOST      127.0.0.1
#   QDRANT_PORT      6333
#   QDRANT_COLLECTION late__memories
#   LOG_FILE         $HOME/clawd/logs/backup-late-mem.log
#
# Cron example (4:30 AM daily):
#   30 4 * * * PGPASSWORD=xxx QDRANT_KEY=yyy $HOME/clawd/scripts/backup-late-mem.sh \
#              >> $HOME/clawd/logs/backup-late-mem.log 2>&1

set -u

: "${PGPASSWORD:?PGPASSWORD env var required (PG password for backup user)}"
: "${QDRANT_KEY:?QDRANT_KEY env var required (Qdrant API key)}"

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/backups/late-mem}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-late_app}"
PG_DB="${PG_DB:-late_mem}"
QDRANT_HOST="${QDRANT_HOST:-127.0.0.1}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
QDRANT_COLLECTION="${QDRANT_COLLECTION:-late__memories}"
LOG_FILE="${LOG_FILE:-$HOME/clawd/logs/backup-late-mem.log}"
DATE=$(date +%Y-%m-%d)

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$BACKUP_ROOT/pg" "$BACKUP_ROOT/qdrant" "$(dirname "$LOG_FILE")"

log "=== backup-late-mem start ==="

# ---- PG dump ----
PG_DEST="$BACKUP_ROOT/pg/${PG_DB}-${DATE}.dump"
if pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -Fc -f "$PG_DEST.tmp" 2>>"$LOG_FILE"; then
  mv "$PG_DEST.tmp" "$PG_DEST"
  SIZE=$(du -h "$PG_DEST" | cut -f1)
  log "PG OK: $PG_DEST ($SIZE)"
else
  log "PG ERROR: pg_dump failed"
  rm -f "$PG_DEST.tmp"
fi

# ---- Qdrant snapshot ----
QDRANT_RESP=$(curl -sS -m 60 -X POST -H "api-key: $QDRANT_KEY" \
  "http://$QDRANT_HOST:$QDRANT_PORT/collections/$QDRANT_COLLECTION/snapshots" 2>>"$LOG_FILE")
SNAP_NAME=$(echo "$QDRANT_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["name"])' 2>/dev/null)

if [ -n "$SNAP_NAME" ]; then
  QDRANT_DEST="$BACKUP_ROOT/qdrant/${QDRANT_COLLECTION}-${DATE}.snapshot"
  if curl -sS -m 120 -H "api-key: $QDRANT_KEY" \
      "http://$QDRANT_HOST:$QDRANT_PORT/collections/$QDRANT_COLLECTION/snapshots/$SNAP_NAME" \
      -o "$QDRANT_DEST.tmp" 2>>"$LOG_FILE"; then
    mv "$QDRANT_DEST.tmp" "$QDRANT_DEST"
    SIZE=$(du -h "$QDRANT_DEST" | cut -f1)
    log "Qdrant OK: $QDRANT_DEST ($SIZE)"

    # Drop snapshot file inside Qdrant storage to avoid accumulation
    curl -sS -m 30 -X DELETE -H "api-key: $QDRANT_KEY" \
      "http://$QDRANT_HOST:$QDRANT_PORT/collections/$QDRANT_COLLECTION/snapshots/$SNAP_NAME" \
      -o /dev/null 2>>"$LOG_FILE"
  else
    log "Qdrant ERROR: download failed"
    rm -f "$QDRANT_DEST.tmp"
  fi
else
  log "Qdrant ERROR: snapshot create failed (resp=$QDRANT_RESP)"
fi

# ---- Retention ----
DELETED_PG=$(find "$BACKUP_ROOT/pg" -type f -name "${PG_DB}-*.dump" -mtime "+$RETENTION_DAYS" -delete -print | wc -l)
DELETED_QD=$(find "$BACKUP_ROOT/qdrant" -type f -name "${QDRANT_COLLECTION}-*.snapshot" -mtime "+$RETENTION_DAYS" -delete -print | wc -l)
log "Retention: removed pg=$DELETED_PG qdrant=$DELETED_QD (>$RETENTION_DAYS days)"

log "=== backup-late-mem complete ==="
