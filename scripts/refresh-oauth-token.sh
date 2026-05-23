#!/bin/bash
# Renova OAuth token do Claude Code e atualiza .env-server-beta
# Roda em cron a cada 30min (CLI só renova com <5min para expirar)
# Ordem: stop -> renova creds -> update .env -> start (sem race de token invalidado)

set -e
export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

LOG=~/.claude-mem/logs/oauth-refresh.log
ENV_FILE=~/.claude-mem/.env-server-beta
CREDS=~/.claude/.credentials.json

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Verifica antes se renovação é provável (faltam <10min) — evita stop/start desnecessário
CURR_EXP=$(python3 -c "import json; print(json.load(open('$CREDS'))['claudeAiOauth']['expiresAt'])" 2>/dev/null || echo 0)
NOW_MS=$(($(date +%s%N) / 1000000))
REMAINING=$(( (CURR_EXP - NOW_MS) / 1000 ))

if [ "$REMAINING" -gt 600 ]; then
  # >10min para expirar — só pinga o CLI sem mexer no service (CLI não vai renovar mesmo)
  echo "ok" | claude -p --max-turns 1 --model claude-haiku-4-5 "responda apenas: ok" > /dev/null 2>&1 || true
  NEW_EXP=$(python3 -c "import json; print(json.load(open('$CREDS'))['claudeAiOauth']['expiresAt'])" 2>/dev/null || echo 0)
  if [ "$NEW_EXP" = "$CURR_EXP" ]; then
    # expiry inalterado, mas o VALOR do token pode ter rotacionado → env antigo vira 401.
    CRED_TOKEN=$(python3 -c "import json; print(json.load(open('$CREDS'))['claudeAiOauth']['accessToken'])" 2>/dev/null || echo "")
    ENV_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
    if [ -n "$CRED_TOKEN" ] && [ ${#CRED_TOKEN} -ge 50 ] && [ "$CRED_TOKEN" != "$ENV_TOKEN" ]; then
      sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$CRED_TOKEN|" "$ENV_FILE"
      systemctl --user restart claude-mem-server-beta
      log "FIX: token defasado (expiry igual, valor rotacionou) — sincronizado + restart"
      exit 0
    fi
    log "OK: ${REMAINING}s restantes, sem mudança"
    exit 0
  fi
fi

# Janela de renovação provável (<10min) OU já renovou inesperadamente — fazer com service parado
log "INFO: ${REMAINING}s restantes, iniciando refresh com service stopped"

systemctl --user stop claude-mem-server-beta

# Força refresh do token via claude CLI (chamada mínima)
if ! echo "ok" | claude -p --max-turns 1 --model claude-haiku-4-5 "responda apenas: ok" > /dev/null 2>&1; then
  log "FAIL: claude CLI refresh — reiniciando service mesmo assim"
  systemctl --user start claude-mem-server-beta
  exit 1
fi

TOKEN=$(python3 -c "import json; print(json.load(open('$CREDS'))['claudeAiOauth']['accessToken'])")
NEW_EXP=$(python3 -c "import json,datetime; e=json.load(open('$CREDS'))['claudeAiOauth']['expiresAt']; print(datetime.datetime.fromtimestamp(e/1000))")

if [ -z "$TOKEN" ] || [ ${#TOKEN} -lt 50 ]; then
  log "FAIL: token vazio ou inválido — restart service com env antigo"
  systemctl --user start claude-mem-server-beta
  exit 1
fi

OLD_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ "$TOKEN" != "$OLD_TOKEN" ]; then
  sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$TOKEN|" "$ENV_FILE"
  log "OK: token renovado (expira $NEW_EXP)"
else
  log "OK: token inalterado (expira $NEW_EXP) — service será reiniciado igual"
fi

systemctl --user start claude-mem-server-beta
