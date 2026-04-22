#!/bin/bash
# claude-mem Health Check — monitora workers, Chroma, DB em todas as máquinas
# Envia alerta via Telegram quando algo falha
# Roda via cron a cada 30 min no .254
#
# Requisitos: curl, jq (opcional), TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no env ou .bashrc

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$HOME/.claude-mem/logs/health-check.log"
ALERT_COOLDOWN_FILE="/tmp/claude-mem-health-alert-cooldown"
COOLDOWN_SECONDS=3600  # 1h entre alertas repetidos

# ntfy config (mesmo topic do wan-monitor e health-collector do LATE)
NTFY_URL="${NTFY_URL:-https://ntfy.sh}"
NTFY_TOPIC="${NTFY_TOPIC:-late-2bb217698af50e4a}"
NTFY_TOKEN="${NTFY_TOKEN:-tk_1yjuubfgyub1byig1gfqdl4lvvfe7}"

SSH_KEY="$HOME/.ssh/mach-key"
SSH_CMD="ssh -i $SSH_KEY -o ConnectTimeout=5 -o BatchMode=yes"

MACHINES=(
  "localhost|DarkStarII (.254)|local"
  "alessandro@192.168.0.253|Mach10 (.253)|remote"
  "alessandro@192.168.0.100|HyperII (.100)|remote"
)

ERRORS=()
WARNINGS=()
timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

log() { echo "[$(timestamp)] $1" >> "$LOG_FILE"; }

send_alert() {
  local title="$1"
  local msg="$2"
  local priority="${3:-high}"
  if [ -z "$NTFY_TOPIC" ]; then return; fi

  local -a headers=(
    -H "Title: $title"
    -H "Priority: $priority"
    -H "Tags: rotating_light"
  )
  if [ -n "$NTFY_TOKEN" ]; then
    headers+=(-H "Authorization: Bearer $NTFY_TOKEN")
  fi

  curl -s -X POST "${NTFY_URL}/${NTFY_TOPIC}" \
    "${headers[@]}" \
    -d "$msg" \
    --max-time 10 >/dev/null 2>&1
}

check_cooldown() {
  if [ -f "$ALERT_COOLDOWN_FILE" ]; then
    local last_alert
    last_alert=$(cat "$ALERT_COOLDOWN_FILE")
    local now
    now=$(date +%s)
    if (( now - last_alert < COOLDOWN_SECONDS )); then
      return 1  # still in cooldown
    fi
  fi
  return 0  # can send
}

set_cooldown() {
  date +%s > "$ALERT_COOLDOWN_FILE"
}

check_worker() {
  local host="$1"
  local label="$2"
  local type="$3"
  local health_url="http://localhost:37777/health"
  local version_url="http://localhost:37777/api/version"

  local health_response
  local version_response

  if [ "$type" = "local" ]; then
    health_response=$(curl -s --max-time 5 "$health_url" 2>/dev/null)
    version_response=$(curl -s --max-time 5 "$version_url" 2>/dev/null)
  else
    # Retry up to 3 times for remote hosts to filter transient SSH/network glitches
    local attempt
    for attempt in 1 2 3; do
      health_response=$($SSH_CMD "$host" "curl -s --max-time 5 $health_url" 2>/dev/null)
      if [ -n "$health_response" ] && echo "$health_response" | grep -q '"ok"'; then
        break
      fi
      [ "$attempt" -lt 3 ] && sleep 3
    done
    version_response=$($SSH_CMD "$host" "curl -s --max-time 5 $version_url" 2>/dev/null)
  fi

  if [ -z "$health_response" ] || ! echo "$health_response" | grep -q '"ok"'; then
    if [ "$type" = "remote" ]; then
      # Workers remotos saem limpos entre sessões Claude (status=0, Restart=on-failure).
      # Não é falha real — é comportamento esperado fora de sessão ativa.
      WARNINGS+=("$label: Worker DOWN (sem sessão ativa ou iniciando)")
      log "WARN $label: Worker não responde (remoto, pode ser between-sessions)"
    else
      ERRORS+=("$label: Worker DOWN (sem resposta em :37777)")
      log "ERROR $label: Worker não responde"
    fi
    return 1
  fi

  # Check version
  local version
  version=$(echo "$version_response" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$version" ] && [ "$version" != "12.1.0" ]; then
    WARNINGS+=("$label: Versão inesperada ($version, esperado 12.1.0)")
    log "WARN $label: version=$version"
  fi

  # Check systemd status
  local systemd_status
  if [ "$type" = "local" ]; then
    systemd_status=$(systemctl --user is-active claude-mem-worker 2>/dev/null)
  else
    systemd_status=$($SSH_CMD "$host" "systemctl --user is-active claude-mem-worker" 2>/dev/null)
  fi

  if [ "$systemd_status" != "active" ]; then
    WARNINGS+=("$label: systemd=$systemd_status (worker pode estar como daemon avulso)")
    log "WARN $label: systemd=$systemd_status"
  fi

  log "OK $label: health=ok version=$version systemd=$systemd_status"
  return 0
}

check_chroma() {
  # Chroma only runs on .254
  local settings_chroma
  settings_chroma=$(grep 'CHROMA_ENABLED' "$HOME/.claude-mem/settings.json" 2>/dev/null | grep -o 'true\|false')

  if [ "$settings_chroma" != "true" ]; then
    log "INFO: Chroma disabled, skip check"
    return 0
  fi

  # Contar processos ANTES de qualquer acao (cada instancia = 2 PIDs: uv wrapper + python)
  local count
  count=$(pgrep -fc "chroma-mcp" 2>/dev/null || echo 0)

  # Limpar duplicatas primeiro — bug anterior: checava pid ANTES de limpar,
  # entao apos pkill ficava com 0 processos e disparava ERROR indevidamente.
  local just_cleaned=false
  if [ "$count" -gt 2 ]; then
    log "CLEANUP: $count chroma-mcp processos detectados, matando duplicatas"
    pkill -f "chroma-mcp" 2>/dev/null || true
    sleep 2
    count=$(pgrep -fc "chroma-mcp" 2>/dev/null || echo 0)
    just_cleaned=true
    log "CLEANUP: chroma-mcp duplicatas eliminadas ($count restantes)"
    WARNINGS+=("DarkStarII: Chroma zumbis limpos — worker vai reconectar na proxima sessao")
  fi

  # Verificar se processo esta rodando
  if [ "$count" -eq 0 ]; then
    if [ "$just_cleaned" = true ]; then
      # Esperado apos cleanup — nao e erro, worker reconecta na proxima sessao Claude
      log "INFO: Chroma: sem processo apos cleanup de zumbis (normal — reconecta na proxima sessao)"
    else
      ERRORS+=("DarkStarII: Chroma ENABLED mas processo chroma-mcp nao encontrado")
      log "ERROR: Chroma enabled mas sem processo"
      return 1
    fi
    return 0
  fi

  # Check Chroma errors in the last 30 min (ignores old backfill noise)
  local today_log="$HOME/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log"
  if [ -f "$today_log" ]; then
    local cutoff
    cutoff=$(date -d '30 minutes ago' '+%Y-%m-%d %H:%M')
    local recent_errors
    recent_errors=$(awk -v cutoff="$cutoff" '$0 ~ /^\[/ { ts=substr($0,2,16); if (ts >= cutoff) print }' "$today_log" 2>/dev/null | grep -c "ERROR.*CHROMA\|WARN.*CHROMA")
    recent_errors=${recent_errors:-0}
    if [ "$recent_errors" -gt 10 ]; then
      WARNINGS+=("DarkStarII: Chroma com $recent_errors erros nos ultimos 30min")
      log "WARN: Chroma $recent_errors errors last 30min"
    fi
  fi

  local chroma_pid
  chroma_pid=$(pgrep -f "chroma-mcp" 2>/dev/null | head -1)
  log "OK: Chroma running (PID $chroma_pid)"
  return 0
}

check_db() {
  local db_file="$HOME/.claude-mem/claude-mem.db"
  if [ ! -f "$db_file" ]; then
    ERRORS+=("DarkStarII: claude-mem.db não encontrado!")
    log "ERROR: DB not found"
    return 1
  fi

  local db_size
  db_size=$(stat -c%s "$db_file" 2>/dev/null)
  local db_age
  db_age=$(( $(date +%s) - $(stat -c%Y "$db_file" 2>/dev/null) ))

  # Alert if DB hasn't been modified in 2 hours
  if [ "$db_age" -gt 7200 ]; then
    WARNINGS+=("DarkStarII: DB sem modificação há $(( db_age / 3600 ))h")
    log "WARN: DB stale (${db_age}s since last write)"
  fi

  log "OK: DB size=$(( db_size / 1024 / 1024 ))MB age=${db_age}s"
  return 0
}

check_sync() {
  local sync_log="/tmp/claude-mem-sync.log"
  if [ -f "$sync_log" ]; then
    local last_sync
    last_sync=$(tail -1 "$sync_log" 2>/dev/null)
    local last_time
    last_time=$(echo "$last_sync" | grep -o '\[.*\]' | tr -d '[]')
    if [ -n "$last_time" ]; then
      local last_epoch
      last_epoch=$(date -d "$last_time" +%s 2>/dev/null)
      local now
      now=$(date +%s)
      local age=$(( now - last_epoch ))
      if [ "$age" -gt 3600 ]; then
        WARNINGS+=("Sync: último sync há $(( age / 60 ))min (esperado <30min)")
        log "WARN: Sync stale (${age}s)"
      else
        log "OK: Sync last=${last_time} age=${age}s"
      fi
    fi
  else
    WARNINGS+=("Sync: log não encontrado em $sync_log")
    log "WARN: Sync log missing"
  fi
}

check_settings() {
  local settings_file="$HOME/.claude-mem/settings.json"
  if [ ! -f "$settings_file" ]; then
    ERRORS+=("DarkStarII: settings.json não encontrado!")
    log "ERROR: Settings file missing"
    return 1
  fi

  # Expected values (Fase 5 — fonte de verdade)
  local -A EXPECTED=(
    ["CLAUDE_MEM_CONTEXT_OBSERVATIONS"]="8"
    ["CLAUDE_MEM_CONTEXT_SESSION_COUNT"]="3"
    ["CLAUDE_MEM_BANDIT_ENABLED"]="true"
    ["CLAUDE_MEM_SEMANTIC_INJECT"]="true"
    ["CLAUDE_MEM_TIER_ROUTING_ENABLED"]="true"
  )

  for key in "${!EXPECTED[@]}"; do
    local actual
    actual=$(grep "\"$key\"" "$settings_file" 2>/dev/null | sed 's/.*: *"//;s/"[, ]*//')
    local expected="${EXPECTED[$key]}"
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      ERRORS+=("Settings: $key=$actual (esperado $expected) — possível regressão após update!")
      log "ERROR: Setting $key=$actual expected=$expected"
    elif [ -z "$actual" ]; then
      WARNINGS+=("Settings: $key ausente no settings.json")
      log "WARN: Setting $key missing"
    fi
  done

  # Check SKIP_TOOLS doesn't contain Bash
  local skip_tools
  skip_tools=$(grep "SKIP_TOOLS" "$settings_file" 2>/dev/null)
  if echo "$skip_tools" | grep -q "Bash"; then
    WARNINGS+=("Settings: SKIP_TOOLS contém Bash (deveria ser removido)")
    log "WARN: SKIP_TOOLS contains Bash"
  fi

  log "OK: Settings verified"
}

check_vector_sanity() {
  local settings_file="$HOME/.claude-mem/settings.json"
  local backend
  backend=$(grep 'VECTOR_BACKEND' "$settings_file" 2>/dev/null | sed 's/.*: *"//;s/"[, ]*//')
  backend="${backend:-chroma}"

  if [ "$backend" != "qdrant" ]; then
    log "INFO: Vector backend=$backend, skip Qdrant sanity"
    return 0
  fi

  # Read Qdrant connection params from settings
  local qdrant_host qdrant_port qdrant_key
  qdrant_host=$(grep 'QDRANT_HOST' "$settings_file" 2>/dev/null | grep -o '"[0-9.]*"' | tr -d '"')
  qdrant_port=$(grep 'QDRANT_PORT' "$settings_file" 2>/dev/null | grep -o '": "[0-9]*"' | grep -o '[0-9]*')
  qdrant_key=$(grep 'QDRANT_API_KEY' "$settings_file" 2>/dev/null | grep -o '": "[^"]*"' | sed 's/": "//;s/"//')
  qdrant_host="${qdrant_host:-127.0.0.1}"
  qdrant_port="${qdrant_port:-6333}"

  # 1. Qdrant HTTP health check
  local qdrant_health
  qdrant_health=$(curl -s --max-time 5 "http://${qdrant_host}:${qdrant_port}/healthz" 2>/dev/null)
  if [ "$qdrant_health" != "healthz check passed" ]; then
    ERRORS+=("Qdrant: sem resposta em ${qdrant_host}:${qdrant_port} — busca semântica offline!")
    log "ERROR: Qdrant health check failed (host=${qdrant_host}:${qdrant_port})"
    return 1
  fi
  log "OK: Qdrant reachable at ${qdrant_host}:${qdrant_port}"

  # 2. Qdrant collections check (confirma que collection existe)
  local collections_response
  collections_response=$(curl -s --max-time 5 \
    -H "api-key: ${qdrant_key}" \
    "http://${qdrant_host}:${qdrant_port}/collections" 2>/dev/null)
  if echo "$collections_response" | grep -q '"result"'; then
    local coll_count
    coll_count=$(echo "$collections_response" | grep -o '"name"' | wc -l)
    log "OK: Qdrant collections=${coll_count}"
  else
    WARNINGS+=("Qdrant: não foi possível listar collections (auth ou rede)")
    log "WARN: Qdrant collections endpoint returned unexpected: ${collections_response:0:100}"
  fi

  # 3. E2E search via worker — testa pipeline completo: embed → Qdrant → SQLite
  local search_response
  search_response=$(curl -s --max-time 15 \
    "http://127.0.0.1:37777/api/search?query=vector+sanity+check&limit=1" 2>/dev/null)
  if echo "$search_response" | grep -q '"content"'; then
    log "OK: Vector E2E search OK (worker→embed→Qdrant→SQLite)"
  else
    ERRORS+=("Vector E2E: search via worker falhou — pipeline embed→Qdrant quebrado!")
    log "ERROR: E2E search returned unexpected: ${search_response:0:150}"
    return 1
  fi

  # 4. Contar erros VECTOR_SYNC/SEARCH nos últimos 30min
  local today_log="$HOME/.claude-mem/logs/claude-mem-$(date +%Y-%m-%d).log"
  if [ -f "$today_log" ]; then
    local cutoff
    cutoff=$(date -d '30 minutes ago' '+%Y-%m-%d %H:%M')
    local recent_vector_errors
    recent_vector_errors=$(awk -v cutoff="$cutoff" \
      '$0 ~ /^\[/ { ts=substr($0,2,16); if (ts >= cutoff) print }' \
      "$today_log" 2>/dev/null \
      | grep -c '\[ERROR\].*\[VECTOR_SYNC\]\|\[ERROR\].*\[SEARCH\]')
    recent_vector_errors=${recent_vector_errors:-0}

    if [ "$recent_vector_errors" -gt 5 ]; then
      WARNINGS+=("Vector: ${recent_vector_errors} erros VECTOR_SYNC/SEARCH nos últimos 30min")
      log "WARN: ${recent_vector_errors} vector/search errors last 30min"
    elif [ "$recent_vector_errors" -gt 0 ]; then
      log "INFO: ${recent_vector_errors} vector/search errors last 30min (abaixo do limiar)"
    else
      log "OK: Sem erros VECTOR_SYNC/SEARCH nos últimos 30min"
    fi
  fi

  return 0
}

check_stale_cache() {
  local cache_dir="$HOME/.claude/plugins/cache/thedotmack/claude-mem"
  local active_version
  active_version=$(grep -o '"version": "[^"]*"' "$HOME/.claude/plugins/marketplaces/thedotmack/plugin/package.json" 2>/dev/null | grep -o '[0-9][^"]*')

  if [ -d "$cache_dir" ] && [ -n "$active_version" ]; then
    for ver_dir in "$cache_dir"/*/; do
      [ -d "$ver_dir" ] || continue
      local ver
      ver=$(basename "$ver_dir")
      if [ "$ver" != "$active_version" ]; then
        rm -rf "$ver_dir"
        log "CLEANUP: Removed stale plugin cache $ver (active: $active_version)"
      fi
    done
  fi

  # Check for duplicate worker processes (daemon + systemd)
  # Usa ps + grep para evitar falso positivo do pgrep -f que conta o próprio shell
  local worker_count
  worker_count=$(ps -eo pid,args | grep "worker-service.cjs" | grep -v grep | wc -l)
  if [ "$worker_count" -gt 1 ]; then
    WARNINGS+=("DarkStarII: $worker_count worker processes (esperado 1) — possível duplicata daemon+systemd")
    log "WARN: $worker_count worker processes running"
  fi

  log "OK: Cache and duplicates checked"
}

# === Main ===
mkdir -p "$(dirname "$LOG_FILE")"
log "=== Health check started ==="

# Run all checks
for machine in "${MACHINES[@]}"; do
  IFS='|' read -r host label type <<< "$machine"
  check_worker "$host" "$label" "$type"
done

check_chroma
check_vector_sanity
check_db
check_sync
check_settings
check_stale_cache

# Build report
if [ ${#ERRORS[@]} -gt 0 ] || [ ${#WARNINGS[@]} -gt 0 ]; then
  REPORT="🔴 *claude-mem Health Alert*\n$(timestamp)\n\n"

  if [ ${#ERRORS[@]} -gt 0 ]; then
    REPORT+="*ERROS:*\n"
    for e in "${ERRORS[@]}"; do
      REPORT+="❌ $e\n"
    done
    REPORT+="\n"
  fi

  if [ ${#WARNINGS[@]} -gt 0 ]; then
    REPORT+="*AVISOS:*\n"
    for w in "${WARNINGS[@]}"; do
      REPORT+="⚠️ $w\n"
    done
  fi

  log "ALERT: ${#ERRORS[@]} errors, ${#WARNINGS[@]} warnings"

  # Send ntfy alert if errors exist and not in cooldown
  if [ ${#ERRORS[@]} -gt 0 ]; then
    if check_cooldown; then
      send_alert "[DarkStarII] claude-mem Health Alert" "$(echo -e "$REPORT")" "high"
      set_cooldown
      log "NTFY: Alert sent to ${NTFY_TOPIC}"
    else
      log "NTFY: Skipped (cooldown)"
    fi
  fi
else
  log "ALL OK: All checks passed"
fi

log "=== Health check complete ==="
