#!/bin/bash
# Sync fleet config: .254 → .100 (HyperII), .253 (Mach10), .220 (Windows)
# Memory files (bidirecional) + settings + CLAUDE.md + plugin bundles
# NÃO inclui merge/push de DB — isso fica no sync-claude-memory.sh
# Roda via cron na .254

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"

# Fleet config (hosts, SSH)
FLEET_ENV="$HOME/.claude-mem/.env-fleet"
[ -f "$FLEET_ENV" ] && source "$FLEET_ENV"

SSH_KEY="${FLEET_SSH_KEY:-$HOME/.ssh/mach-key}"
SSH_CMD="ssh -i $SSH_KEY -o ConnectTimeout=5"
LOCAL_MEM="$HOME/.claude/projects/-home-alessandro/memory/"
REMOTE_MEM=".claude/projects/-home-alessandro/memory/"
LOCAL_SETTINGS="$HOME/.claude-mem/settings.json"
TEMP_DIR="/tmp/claude-config-sync"

REMOTES=(
  "${FLEET_USER:-alessandro}@${FLEET_BOT_HOST:-192.168.0.100}"
  "${FLEET_USER:-alessandro}@${FLEET_PROD_HOST:-192.168.0.253}"
  "${FLEET_WIN_USER:-aless}@${FLEET_WIN_HOST:-192.168.0.220}"
)
LABELS=("${FLEET_BOT_HOST:-100} (HyperII)" "${FLEET_PROD_HOST:-253} (Mach10)" "${FLEET_WIN_HOST:-220} (Windows)")

# SSH retry: 3 tentativas com 3s entre elas
ssh_check() {
  local remote="$1"
  local attempt
  for attempt in 1 2 3; do
    if $SSH_CMD "$remote" "echo ok" >/dev/null 2>&1; then
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep 3
  done
  return 1
}

sync_remote() {
  local remote="$1"
  local label="$2"

  if ! ssh_check "$remote"; then
    echo "[$(date '+%Y-%m-%d %H:%M')] $label offline after 3 attempts, skip"
    return
  fi

  # Detect Windows (user aless = Windows)
  local is_windows=false
  case "$remote" in *aless@*) is_windows=true ;; esac

  if [ "$is_windows" = true ]; then
    sync_windows "$remote" "$label"
  else
    sync_linux "$remote" "$label"
  fi
}

sync_linux() {
  local remote="$1"
  local label="$2"

  # === 1. Memory files (bidirecional, timestamp wins) ===
  local temp="$TEMP_DIR/$label"
  mkdir -p "$temp"
  rsync -az -e "$SSH_CMD" "$remote:$REMOTE_MEM" "$temp/" 2>/dev/null

  for f in "$temp"/*; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    local_f="$LOCAL_MEM/$fname"
    if [ -f "$local_f" ]; then
      [ "$f" -nt "$local_f" ] && cp "$f" "$local_f"
    else
      cp "$f" "$local_f"
    fi
  done

  rsync -az -e "$SSH_CMD" "$LOCAL_MEM" "$remote:$REMOTE_MEM"

  # === 2. Settings (.254 → remote, preserva CHROMA_ENABLED do remote) ===
  if [ -f "$LOCAL_SETTINGS" ]; then
    local remote_chroma
    remote_chroma=$($SSH_CMD "$remote" 'grep CHROMA_ENABLED ~/.claude-mem/settings.json 2>/dev/null | grep -o "true\|false"' 2>/dev/null)
    rsync -az -e "$SSH_CMD" "$LOCAL_SETTINGS" "$remote:.claude-mem/settings.json"
    if [ -n "$remote_chroma" ]; then
      $SSH_CMD "$remote" "sed -i 's/\"CLAUDE_MEM_CHROMA_ENABLED\": \"[^\"]*\"/\"CLAUDE_MEM_CHROMA_ENABLED\": \"$remote_chroma\"/' ~/.claude-mem/settings.json" 2>/dev/null
    fi
  fi

  # === 3. CLAUDE.md (.254 → remote) ===
  rsync -az -e "$SSH_CMD" "$HOME/.claude/CLAUDE.md" "$remote:.claude/CLAUDE.md" 2>/dev/null

  # === 4. Plugin bundles (.254 → remote, restart worker on changes) ===
  local LOCAL_PLUGIN="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/"
  if [ -d "$LOCAL_PLUGIN" ]; then
    local changes
    changes=$(rsync -az --itemize-changes -e "$SSH_CMD" \
      --exclude='node_modules' \
      --exclude='package-lock.json' \
      --exclude='bun.lock' \
      --exclude='*.log' \
      "$LOCAL_PLUGIN" "$remote:.claude/plugins/marketplaces/thedotmack/plugin/" 2>/dev/null | grep -c '^>f')
    if [ "${changes:-0}" -gt 0 ]; then
      $SSH_CMD "$remote" "curl -sf -X POST --max-time 3 http://localhost:37777/api/admin/restart >/dev/null 2>&1 || true" 2>/dev/null
      echo "[$(date '+%Y-%m-%d %H:%M')] Plugin bundles updated on $label ($changes files), worker restarted"
    fi
  fi

  echo "[$(date '+%Y-%m-%d %H:%M')] Config sync OK (.254 → $label)"
}

sync_windows() {
  local remote="$1"
  local label="$2"

  # === 1. Settings: build Windows-specific version, then scp ===
  if [ -f "$LOCAL_SETTINGS" ]; then
    local win_settings="/tmp/claude-mem-win-settings.json"
    python3 -c "
import json
with open('$LOCAL_SETTINGS') as f: s = json.load(f)
s['CLAUDE_MEM_CHROMA_ENABLED'] = 'false'
s['CLAUDE_MEM_WORKER_PORT'] = '38888'
s['CLAUDE_MEM_WORKER_HOST'] = '127.0.0.1'
s['CLAUDE_MEM_DATA_DIR'] = 'C:\\\\Users\\\\aless\\\\.claude-mem'
json.dump(s, open('$win_settings','w'), indent=2)
" 2>/dev/null
    scp -i "$SSH_KEY" -o ConnectTimeout=5 "$win_settings" "$remote:.claude-mem/settings.json" 2>/dev/null
    rm -f "$win_settings"
  fi

  # === 2. Plugin bundles (.cjs + plugin.json) via scp ===
  local LOCAL_PLUGIN_SCRIPTS="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/scripts"
  local LOCAL_PLUGIN_MANIFEST="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/.claude-plugin"
  if [ -d "$LOCAL_PLUGIN_SCRIPTS" ]; then
    for cjs in worker-service.cjs mcp-server.cjs context-generator.cjs worker-wrapper.cjs; do
      [ -f "$LOCAL_PLUGIN_SCRIPTS/$cjs" ] && \
        scp -i "$SSH_KEY" -o ConnectTimeout=5 "$LOCAL_PLUGIN_SCRIPTS/$cjs" \
          "$remote:.claude/plugins/marketplaces/thedotmack/plugin/scripts/$cjs" 2>/dev/null
    done
    [ -f "$LOCAL_PLUGIN_MANIFEST/plugin.json" ] && \
      scp -i "$SSH_KEY" -o ConnectTimeout=5 "$LOCAL_PLUGIN_MANIFEST/plugin.json" \
        "$remote:.claude/plugins/marketplaces/thedotmack/plugin/.claude-plugin/plugin.json" 2>/dev/null
  fi

  echo "[$(date '+%Y-%m-%d %H:%M')] Config sync OK (.254 → $label)"
}

# Lock + temp dir
SYNC_LOCK="/tmp/claude-config-sync.lock"
touch "$SYNC_LOCK"
trap 'rm -f "$SYNC_LOCK"' EXIT

mkdir -p "$TEMP_DIR"

for i in "${!REMOTES[@]}"; do
  sync_remote "${REMOTES[$i]}" "${LABELS[$i]}"
done

rm -rf "$TEMP_DIR"
