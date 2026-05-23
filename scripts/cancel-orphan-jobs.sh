#!/bin/bash
# Cancela jobs órfãos per-event do end-of-session (queued attempts=0 agent_event que nunca processam).
# Band-aid local até o upstream marcar skip como terminal (feedback Alex rec #6).
set -uo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ENV="$HOME/.claude-mem/.env-server-beta"
LOG="$HOME/.claude-mem/logs/cancel-orphan-jobs.log"
mkdir -p "$(dirname "$LOG")"
set -a; source "$ENV" 2>/dev/null; set +a
rest="${CLAUDE_MEM_SERVER_DATABASE_URL#postgresql://}"; rest="${rest#postgres://}"
creds="${rest%@*}"; hostpart="${rest##*@}"
export PGPASSWORD="${creds#*:}"; U="${creds%%:*}"
hp="${hostpart%%/*}"; DB="${hostpart##*/}"; DB="${DB%%\?*}"
H="${hp%%:*}"; PT="${hp##*:}"; [ "$PT" = "$H" ] && PT=5432
N=$(psql -h "$H" -p "$PT" -U "$U" -d "$DB" -At -c "WITH x AS (UPDATE observation_generation_jobs SET status='cancelled', updated_at=now() WHERE status='queued' AND attempts=0 AND source_type='agent_event' RETURNING 1) SELECT count(*) FROM x;" 2>>"$LOG")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] cancelled ${N:-ERR} orphan per-event jobs" >> "$LOG"
