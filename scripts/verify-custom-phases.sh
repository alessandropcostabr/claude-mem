#!/usr/bin/env bash
# verify-custom-phases.sh — Daily health check for custom phases
#
# Checks two things:
#   1. Code: compiled artifacts contain required tokens per phase
#   2. Data: database has recent writes from each phase (last 24h)
#
# Exit codes:
#   0 = all OK
#   1 = failures detected
#
# Usage:
#   ./scripts/verify-custom-phases.sh              # local check
#   ./scripts/verify-custom-phases.sh --notify     # send ntfy alert on failure
#   ./scripts/verify-custom-phases.sh --json       # JSON output for cron/monitoring

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
DB_PATH="$HOME/.claude-mem/claude-mem.db"
WORKER_URL="http://localhost:37777"
NOTIFY=false
JSON=false
FAILURES=0
WARNINGS=0
RESULTS=()
IDLE=false   # true quando não houve atividade na janela de 24h (máquina ociosa)

for arg in "$@"; do
  case "$arg" in
    --notify) NOTIFY=true ;;
    --json) JSON=true ;;
  esac
done

# --- Helpers ---

check_token() {
  local file="$1" token="$2" label="$3"
  if grep -q "$token" "$file" 2>/dev/null; then
    RESULTS+=("OK|code|$label|$token")
  else
    RESULTS+=("FAIL|code|$label|$token missing from $(basename "$file")")
    FAILURES=$((FAILURES + 1))
  fi
}

db_count() {
  # Executa a query e devolve a contagem (0 em qualquer erro)
  local query="$1"
  bun -e "
    const Database = require('bun:sqlite').Database;
    const db = new Database('$DB_PATH', {readonly:true});
    try {
      const row = db.prepare(\`$query\`).get();
      console.log(row?.cnt ?? 0);
    } catch(e) { console.log(0); }
  " 2>/dev/null || echo 0
}

# check_db_recent QUERY LABEL [min_expected] [zero_sev]
#   zero_sev = fail (default) | warn
#     fail: 0 registros durante atividade é bloqueante (sinal core: observations/sessions)
#     warn: 0 registros é só aviso (sinal opcional: feedback/bandit/c4/summaries)
#   Quando a máquina está ociosa (IDLE), 0 registros é ESPERADO e vira SKIP — nunca FAIL.
check_db_recent() {
  local query="$1" label="$2" min_expected="${3:-1}" zero_sev="${4:-fail}"
  if [ ! -f "$DB_PATH" ]; then
    RESULTS+=("FAIL|data|$label|DB not found at $DB_PATH")
    FAILURES=$((FAILURES + 1))
    return
  fi
  local count
  count=$(db_count "$query")
  if [ "$count" -ge "$min_expected" ]; then
    RESULTS+=("OK|data|$label|$count records (last 24h)")
  elif [ "$count" -eq 0 ]; then
    if $IDLE; then
      RESULTS+=("SKIP|data|$label|sem atividade na janela (idle) — esperado")
    elif [ "$zero_sev" = "warn" ]; then
      RESULTS+=("WARN|data|$label|0 records (sinal opcional)")
      WARNINGS=$((WARNINGS + 1))
    else
      RESULTS+=("FAIL|data|$label|0 records in last 24h")
      FAILURES=$((FAILURES + 1))
    fi
  else
    RESULTS+=("WARN|data|$label|only $count records (expected >= $min_expected)")
    WARNINGS=$((WARNINGS + 1))
  fi
}

check_api() {
  local endpoint="$1" label="$2" expect_field="$3"
  local response
  response=$(curl -s --max-time 5 "$WORKER_URL$endpoint" 2>/dev/null || echo "")
  if [ -z "$response" ]; then
    RESULTS+=("FAIL|api|$label|no response from $endpoint")
    FAILURES=$((FAILURES + 1))
    return
  fi
  if echo "$response" | grep -q "$expect_field"; then
    RESULTS+=("OK|api|$label|responding")
  else
    RESULTS+=("FAIL|api|$label|missing $expect_field in response")
    FAILURES=$((FAILURES + 1))
  fi
}

# ========================================
# 1. CODE VERIFICATION — tokens in compiled artifacts
# ========================================

WORKER="$PLUGIN_DIR/scripts/worker-service.cjs"
MCP="$PLUGIN_DIR/scripts/mcp-server.cjs"

# Phase 0: Schema
check_token "$WORKER" "generated_by_model" "Phase 0 (Schema)"
check_token "$WORKER" "relevance_count" "Phase 0 (Schema)"

# Phase 2: Bandit
check_token "$WORKER" "BanditEngine" "Phase 2 (Bandit)"
check_token "$WORKER" "selectArm" "Phase 2 (Bandit)"
check_token "$WORKER" "recordReward" "Phase 2 (Bandit)"

# Phase 4: C4 FileReadTracking
check_token "$WORKER" "file_read_tracking" "Phase 4 (C4)"
check_token "$WORKER" "FileReadTracking" "Phase 4 (C4)"

# Phase 7: Governance
check_token "$WORKER" "handleConfirm" "Phase 7 (Governance)"
check_token "$WORKER" "handleDeprecate" "Phase 7 (Governance)"
check_token "$WORKER" "handleStats" "Phase 7 (Governance)"
check_token "$MCP" "mem_confirm" "Phase 7 (MCP tools)"
check_token "$MCP" "mem_deprecate" "Phase 7 (MCP tools)"
check_token "$MCP" "mem_stats" "Phase 7 (MCP tools)"
check_token "$MCP" "save_memory" "Phase 3 (MCP save)"

# Phase 0 Item 6: CLAUDE_MEM_SEMANTIC_MAX_TOKENS
check_token "$WORKER" "SEMANTIC_MAX_TOKENS" "Phase 0 Item 6 (token limit)"

# Phase 8: HybridScorer
check_token "$WORKER" "scoreAndRank" "Phase 8 (Scoring)"
check_token "$WORKER" "computeScore" "Phase 8 (Scoring)"
check_token "$WORKER" "SCORING" "Phase 8 (Scoring)"
check_token "$WORKER" "normalizeRecency" "Phase 8 (Scoring)"

# ========================================
# 2. DATA VERIFICATION — recent writes in DB
# ========================================

# Sentinela de atividade: houve QUALQUER observação na janela de 24h?
# Se 0, a máquina estava ociosa (ex.: check rodou antes do trabalho do dia) — então
# 0 registros nos demais checks é esperado e não deve gerar FAIL "DO NOT DEPLOY".
if [ -f "$DB_PATH" ]; then
  ACTIVITY=$(db_count "SELECT COUNT(*) as cnt FROM observations WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000")
  [ "$ACTIVITY" -eq 0 ] && IDLE=true
fi

# Observations being created — sinal CORE (0 durante atividade = problema real)
check_db_recent \
  "SELECT COUNT(*) as cnt FROM observations WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "Observations (last 24h)" 5 fail

# Sessions active — sinal OPCIONAL (legado): o rastreamento de sessão migrou para o
# Postgres do server-beta (tabela server_sessions) no cutover de 19/05/2026. A sdk_sessions
# local ficou congelada por design — fonte de verdade agora é o PG do server-beta.
check_db_recent \
  "SELECT COUNT(*) as cnt FROM sdk_sessions WHERE started_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "Active sessions (last 24h)" 1 warn

# Feedback signals flowing — sinal OPCIONAL (reações podem legitimamente ser 0)
check_db_recent \
  "SELECT COUNT(*) as cnt FROM observation_feedback WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "Feedback signals (last 24h)" 10 warn

# Bandit arms being updated — sinal OPCIONAL
check_db_recent \
  "SELECT COUNT(*) as cnt FROM bandit_arms WHERE updated_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "Bandit arms updated (last 24h)" 1 warn

# FileReadTracking — sinal OPCIONAL (feature ativa mas sem context_acceptance events ainda)
check_db_recent \
  "SELECT COUNT(*) as cnt FROM file_read_tracking WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "FileReadTracking (last 24h)" 1 warn

# Summaries generated — sinal OPCIONAL
check_db_recent \
  "SELECT COUNT(*) as cnt FROM session_summaries WHERE created_at_epoch > (strftime('%s','now') - 86400) * 1000" \
  "Summaries (last 24h)" 1 warn

# ========================================
# 3. API VERIFICATION — worker responding
# ========================================

check_api "/health" "Worker health" "ok"
check_api "/api/stats" "General stats" "database"

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
  echo "=== claude-mem custom phases verification ==="
  echo "Date: $(date)"
  echo "Host: $(hostname)"
  echo ""

  prev_category=""
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r status category label detail <<< "$result"
    if [ "$category" != "$prev_category" ]; then
      echo ""
      case "$category" in
        code) echo "--- Code Tokens ---" ;;
        data) echo "--- Database Writes ---" ;;
        api)  echo "--- API Endpoints ---" ;;
      esac
      prev_category="$category"
    fi
    case "$status" in
      OK)   printf "  ✅ %-30s %s\n" "$label" "$detail" ;;
      WARN) printf "  ⚠️  %-30s %s\n" "$label" "$detail" ;;
      SKIP) printf "  ⏭️  %-30s %s\n" "$label" "$detail" ;;
      FAIL) printf "  ❌ %-30s %s\n" "$label" "$detail" ;;
    esac
  done

  echo ""
  $IDLE && echo "ℹ️  Sem atividade na janela de 24h — checks de escrita pulados (idle)."
  if [ "$FAILURES" -gt 0 ]; then
    echo "❌ RESULT: $FAILURES failures, $WARNINGS warnings — DO NOT DEPLOY"
  elif [ "$WARNINGS" -gt 0 ]; then
    echo "⚠️  RESULT: $WARNINGS warnings, 0 failures — check warnings"
  else
    echo "✅ RESULT: all checks passed"
  fi
fi

# ========================================
# 4. NTFY ALERT (optional)
# ========================================

if $NOTIFY && [ "$FAILURES" -gt 0 ]; then
  FAILED_LIST=""
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r status category label detail <<< "$result"
    [ "$status" = "FAIL" ] && FAILED_LIST="$FAILED_LIST\n- $label: $detail"
  done
  curl -s -d "claude-mem phase check FAILED on $(hostname): $FAILURES failures$FAILED_LIST" \
    "ntfy.sh/claude-mem-alerts" >/dev/null 2>&1 || true
fi

exit $FAILURES
