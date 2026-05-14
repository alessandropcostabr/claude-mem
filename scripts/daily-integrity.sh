#!/usr/bin/env bash
# daily-integrity.sh — Detecção de degradação silenciosa do claude-mem
#
# Checks: TG-PATCH, TG-VERSION, TG-BOT, WAL, C4-DATA, JOURNAL, WORKER-CUSTOM
#
# Usage:
#   ~/scripts/daily-integrity.sh              # check local
#   ~/scripts/daily-integrity.sh --notify     # alerta ntfy em FAIL
#   ~/scripts/daily-integrity.sh --json       # JSON para parsing/cron

set -euo pipefail

# Fleet config (hosts, ntfy, SSH)
FLEET_ENV="$HOME/.claude-mem/.env-fleet"
[ -f "$FLEET_ENV" ] && source "$FLEET_ENV"

PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
DB_PATH="$HOME/.claude-mem/claude-mem.db"
WORKER_CJS="$PLUGIN_DIR/scripts/worker-service.cjs"
TG_SERVER_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
TG_VERSION_FILE="$HOME/.claude-mem/.last-telegram-version"
WAL_WARN_BYTES=$((50 * 1024 * 1024))   # 50MB
LOG_FILE="$HOME/.claude-mem/logs/daily-integrity.log"
ALERT_COOLDOWN_FILE="/tmp/daily-integrity-cooldown"
COOLDOWN_SECONDS=3600
NTFY_URL="${NTFY_URL:-}"
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_TOKEN="${NTFY_TOKEN:-}"
NOTIFY=false
JSON=false
FAILURES=0
WARNINGS=0
RESULTS=()

for arg in "$@"; do
  case "$arg" in
    --notify) NOTIFY=true ;;
    --json)   JSON=true ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

send_alert() {
  local title="$1" msg="$2"
  [ -z "$NTFY_TOPIC" ] && return
  local -a headers=(-H "Title: $title" -H "Priority: high" -H "Tags: warning")
  [ -n "$NTFY_TOKEN" ] && headers+=(-H "Authorization: Bearer $NTFY_TOKEN")
  curl -s -X POST "${NTFY_URL}/${NTFY_TOPIC}" "${headers[@]}" -d "$msg" --max-time 10 >/dev/null 2>&1
}

check_cooldown() {
  [ -f "$ALERT_COOLDOWN_FILE" ] || return 0
  local last now
  last=$(cat "$ALERT_COOLDOWN_FILE")
  now=$(date +%s)
  (( now - last < COOLDOWN_SECONDS )) && return 1 || return 0
}

# Retorna a versão ativa do plugin Telegram (maior semver em cache)
get_tg_active_version() {
  ls "$TG_SERVER_DIR/" 2>/dev/null | sort -V | tail -1
}

check_tg_patch() {
  local ver
  ver=$(get_tg_active_version)
  if [ -z "$ver" ]; then
    RESULTS+=("SKIP|telegram|TG-PATCH|Telegram plugin not found (not a bot machine?)")
    return
  fi
  local server_ts="$TG_SERVER_DIR/$ver/server.ts"
  if [ ! -f "$server_ts" ]; then
    RESULTS+=("FAIL|telegram|TG-PATCH|server.ts not found at $server_ts")
    FAILURES=$((FAILURES + 1))
    return
  fi
  local has_reaction has_allowed has_keepalive
  has_reaction=$(grep -c "message_reaction" "$server_ts" 2>/dev/null || true)
  has_allowed=$(grep -c "allowed_updates" "$server_ts" 2>/dev/null || true)
  has_keepalive=$(grep -c "telegram-keepalive" "$server_ts" 2>/dev/null || true)
  if [ "$has_reaction" -gt 0 ] && [ "$has_allowed" -gt 0 ] && [ "$has_keepalive" -gt 0 ]; then
    RESULTS+=("OK|telegram|TG-PATCH|Patch present in server.ts $ver (reaction+keepalive)")
  else
    local missing=""
    [ "$has_reaction" -eq 0 ] && missing="message_reaction "
    [ "$has_allowed" -eq 0 ] && missing="${missing}allowed_updates "
    [ "$has_keepalive" -eq 0 ] && missing="${missing}keepalive"
    RESULTS+=("FAIL|telegram|TG-PATCH|Missing in server.ts $ver: $missing")
    FAILURES=$((FAILURES + 1))
  fi
}

check_tg_version() {
  local ver
  ver=$(get_tg_active_version)
  if [ -z "$ver" ]; then
    RESULTS+=("SKIP|telegram|TG-VERSION|Telegram plugin not found")
    return
  fi
  if [ ! -f "$TG_VERSION_FILE" ]; then
    echo "$ver" > "$TG_VERSION_FILE"
    RESULTS+=("OK|telegram|TG-VERSION|First run, recorded version $ver")
    return
  fi
  local last_ver
  last_ver=$(cat "$TG_VERSION_FILE")
  if [ "$ver" = "$last_ver" ]; then
    RESULTS+=("OK|telegram|TG-VERSION|Plugin version unchanged ($ver)")
  else
    RESULTS+=("FAIL|telegram|TG-VERSION|Version changed: $last_ver → $ver (patch may have been lost)")
    FAILURES=$((FAILURES + 1))
    return
  fi
  # Atualiza apenas quando versão está OK (não consumir o FAIL)
  echo "$ver" > "$TG_VERSION_FILE"
}

check_tg_bot() {
  local token_file="$HOME/.claude/channels/telegram/.env"
  if [ ! -f "$token_file" ]; then
    RESULTS+=("SKIP|telegram|TG-BOT|No token file at $token_file")
    return
  fi
  local token
  token=$(grep "TELEGRAM_BOT_TOKEN" "$token_file" 2>/dev/null | cut -d= -f2)
  if [ -z "$token" ]; then
    RESULTS+=("SKIP|telegram|TG-BOT|TELEGRAM_BOT_TOKEN not set")
    return
  fi
  local response
  response=$(curl -s --max-time 5 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || echo "")
  local ok
  ok=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null || echo "False")
  if [ "$ok" = "True" ]; then
    local username
    username=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('result',{}).get('username','?'))" 2>/dev/null || echo "?")
    RESULTS+=("OK|telegram|TG-BOT|@${username} responding")
  else
    RESULTS+=("FAIL|telegram|TG-BOT|getMe failed or timeout")
    FAILURES=$((FAILURES + 1))
  fi
}

check_wal() {
  local wal_path="${DB_PATH}-wal"
  if [ ! -f "$wal_path" ]; then
    RESULTS+=("OK|database|WAL|No WAL file (clean state)")
    return
  fi
  local size
  size=$(stat -c%s "$wal_path" 2>/dev/null || echo 0)
  local size_mb=$(( size / 1024 / 1024 ))
  if [ "$size" -gt "$WAL_WARN_BYTES" ]; then
    RESULTS+=("WARN|database|WAL|db-wal is ${size_mb}MB (> 50MB threshold — run checkpoint)")
    WARNINGS=$((WARNINGS + 1))
  else
    RESULTS+=("OK|database|WAL|db-wal is ${size_mb}MB")
  fi
}

check_c4_data() {
  if [ ! -f "$DB_PATH" ]; then
    RESULTS+=("FAIL|database|C4-DATA|DB not found at $DB_PATH")
    FAILURES=$((FAILURES + 1))
    return
  fi
  local bun_bin
  bun_bin=$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
  local count
  count=$("$bun_bin" -e "
    const Database = require('bun:sqlite').Database;
    const db = new Database('$DB_PATH', {readonly:true});
    try {
      const row = db.prepare(\"SELECT COUNT(*) as cnt FROM file_read_tracking WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000\").get();
      console.log(row?.cnt ?? 0);
    } catch(e) { console.log(0); }
    db.close();
  " 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    RESULTS+=("OK|database|C4-DATA|FileReadTracking: $count records last 24h")
  else
    RESULTS+=("WARN|database|C4-DATA|FileReadTracking: 0 records last 24h (no session today, or Phase 4 C4 inactive)")
    WARNINGS=$((WARNINGS + 1))
  fi
}

check_journal() {
  # Serviços/eventos ignorados: GUI, mnt temporários, coredumps de bun, sudo auth, SSH scans,
  # hardware ThinkPad (ACPI/VMX/battery), rclone gdrive (transient no reboot)
  local ignore_pattern="gnome-terminal-server|xdg-desktop-portal-gtk|mnt-backup.mount|colord|gvfs-|accounts-daemon|systemd-coredump|pam_unix|sudo|sshd.*preauth|thinkpad_acpi|ThinkPad Battery|ACPI.*HKEY|ACPI.*battery|VMX.*BIOS|rclone|fusermount|home\.mount"
  local JOURNAL_FAIL_THRESHOLD=5
  local errors
  errors=$(journalctl --since "24 hours ago" --priority=err --no-pager -q 2>/dev/null \
    | grep -v "^[[:space:]]" \
    | grep -vE "$ignore_pattern" \
    | grep -v "^$" \
    | wc -l) || errors=0
  errors=$(echo "$errors" | tr -d '[:space:]')
  if [ "$errors" -gt "$JOURNAL_FAIL_THRESHOLD" ]; then
    RESULTS+=("FAIL|system|JOURNAL|${errors} critical service errors in last 24h (check journalctl -p err)")
    FAILURES=$((FAILURES + 1))
  elif [ "$errors" -gt 0 ]; then
    RESULTS+=("WARN|system|JOURNAL|${errors} minor errors in last 24h (below threshold of $JOURNAL_FAIL_THRESHOLD)")
    WARNINGS=$((WARNINGS + 1))
  else
    RESULTS+=("OK|system|JOURNAL|No critical service errors")
  fi
}

check_worker_custom() {
  if [ ! -f "$WORKER_CJS" ]; then
    RESULTS+=("FAIL|worker|WORKER-CUSTOM|worker-service.cjs not found at $WORKER_CJS")
    FAILURES=$((FAILURES + 1))
    return
  fi
  if grep -q "telegram-reaction" "$WORKER_CJS" 2>/dev/null; then
    RESULTS+=("OK|worker|WORKER-CUSTOM|telegram-reaction endpoint present")
  else
    RESULTS+=("FAIL|worker|WORKER-CUSTOM|telegram-reaction endpoint missing — rebuild required")
    FAILURES=$((FAILURES + 1))
  fi
}

check_skill_install() {
  local skill_dir="$PLUGIN_DIR/skills/daily-maintenance"
  if [ ! -f "$skill_dir/SKILL.md" ]; then
    RESULTS+=("FAIL|worker|SKILL-INSTALL|/daily-maintenance skill missing from plugin dir")
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [ ! -f "$skill_dir/patch-telegram.py" ]; then
    RESULTS+=("WARN|worker|SKILL-INSTALL|SKILL.md present but patch-telegram.py missing")
    WARNINGS=$((WARNINGS + 1))
    return
  fi
  RESULTS+=("OK|worker|SKILL-INSTALL|/daily-maintenance skill installed (SKILL.md + patch-telegram.py)")
}

# ========================================
# MAIN
# ========================================

check_tg_patch
check_tg_version
check_tg_bot
check_wal
check_c4_data
check_journal
check_worker_custom
check_skill_install

# ========================================
# OUTPUT
# ========================================

if $JSON; then
  echo "{"
  echo "  \"timestamp\": \"$(date -Iseconds)\","
  echo "  \"hostname\": \"$(hostname)\","
  echo "  \"failures\": $FAILURES,"
  echo "  \"warnings\": $WARNINGS,"
  echo "  \"checks\": ["
  for i in "${!RESULTS[@]}"; do
    IFS='|' read -r status category label detail <<< "${RESULTS[$i]}"
    comma=","
    [ "$i" -eq $((${#RESULTS[@]} - 1)) ] && comma=""
    echo "    {\"status\": \"$status\", \"category\": \"$category\", \"label\": \"$label\", \"detail\": \"$detail\"}$comma"
  done
  echo "  ]"
  echo "}"
else
  echo "=== claude-mem daily integrity check ==="
  echo "Date: $(date '+%Y-%m-%d')  Host: $(hostname)"
  echo ""

  prev_category=""
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r status category label detail <<< "$result"
    if [ "$category" != "$prev_category" ]; then
      echo ""
      case "$category" in
        telegram)  echo "--- Telegram ---" ;;
        database)  echo "--- Database ---" ;;
        system)    echo "--- System ---" ;;
        worker)    echo "--- Worker ---" ;;
      esac
      prev_category="$category"
    fi
    case "$status" in
      OK)   printf "  ✅ %-16s %s\n" "$label" "$detail" ;;
      WARN) printf "  ⚠️  %-15s %s\n" "$label" "$detail" ;;
      FAIL) printf "  ❌ %-16s %s\n" "$label" "$detail" ;;
      SKIP) printf "  ⏭  %-16s %s\n" "$label" "$detail" ;;
    esac
  done

  echo ""
  if [ "$FAILURES" -gt 0 ]; then
    echo "❌ RESULT: $FAILURES failures, $WARNINGS warnings — run /daily-maintenance"
  elif [ "$WARNINGS" -gt 0 ]; then
    echo "⚠️  RESULT: $WARNINGS warnings — run /daily-maintenance to fix"
  else
    echo "✅ RESULT: all checks passed"
  fi
fi

# ========================================
# NTFY ALERT
# ========================================

if $NOTIFY && [ "$FAILURES" -gt 0 ]; then
  if check_cooldown; then
    FAILED_LIST=""
    for result in "${RESULTS[@]}"; do
      IFS='|' read -r status category label detail <<< "$result"
      [ "$status" = "FAIL" ] && FAILED_LIST="${FAILED_LIST}\n- ${label}: ${detail}"
    done
    send_alert "claude-mem integrity FAILED on $(hostname)" \
      "$(printf '%b' "$FAILURES failures:$FAILED_LIST")"
    date +%s > "$ALERT_COOLDOWN_FILE"
    log "NTFY: alert sent ($FAILURES failures)"
  else
    log "NTFY: skipped (cooldown)"
  fi
fi

exit $FAILURES
