# Daily Maintenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar `daily-integrity.sh` (detecção automática de degradação silenciosa, cron 7h50) e a skill `/daily-maintenance` (guia ações corretivas com confirmação), deployados nas 3 máquinas da frota.

**Architecture:** Dois componentes independentes — script bash puro para detecção/alertas (sem tokens, sem Claude), e uma skill Markdown carregada pelo Claude Code para orquestrar fixes interativos. Scripts bash seguem o padrão do `verify-custom-phases.sh` já existente: `RESULTS=()`, `FAILURES`/`WARNINGS` como inteiros, flags `--notify`/`--json`, ntfy para alertas.

**Tech Stack:** bash, bun (SQLite), curl (ntfy + Telegram API), python3 (patch inline), Claude Code Skills (Markdown + frontmatter)

---

## File Map

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `~/scripts/daily-integrity.sh` | Criar | 7 checks de integridade, cron-ready, ntfy |
| `~/claude-mem-contrib/skills/daily-maintenance/skill.md` | Criar | Skill `/daily-maintenance` — lê logs, guia fixes |
| `~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py` | Criar | Script Python reutilizável para reaplicar patch |

Deploy (não são arquivos novos, são cópias):
- `~/scripts/daily-integrity.sh` → scp .253 e .100
- Crontab `50 7 * * *` nas 3 máquinas

---

## Task 1: `daily-integrity.sh` — esqueleto e helpers

**Files:**
- Create: `~/scripts/daily-integrity.sh`

- [ ] **Step 1: Criar o esqueleto com variáveis e helpers**

```bash
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

PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
DB_PATH="$HOME/.claude-mem/claude-mem.db"
WORKER_CJS="$PLUGIN_DIR/scripts/worker-service.cjs"
TG_SERVER_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
TG_VERSION_FILE="$HOME/.claude-mem/.last-telegram-version"
WAL_WARN_BYTES=$((50 * 1024 * 1024))   # 50MB
LOG_FILE="$HOME/.claude-mem/logs/daily-integrity.log"
ALERT_COOLDOWN_FILE="/tmp/daily-integrity-cooldown"
COOLDOWN_SECONDS=3600
NTFY_URL="${NTFY_URL:-https://ntfy.sh}"
NTFY_TOPIC="${NTFY_TOPIC:-late-2bb217698af50e4a}"
NTFY_TOKEN="${NTFY_TOKEN:-tk_1yjuubfgyub1byig1gfqdl4lvvfe7}"
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
```

- [ ] **Step 2: Verificar que o arquivo é executável**

```bash
chmod +x ~/scripts/daily-integrity.sh
bash -n ~/scripts/daily-integrity.sh && echo "syntax OK"
```
Esperado: `syntax OK`

---

## Task 2: Checks TG-PATCH, TG-VERSION, TG-BOT

**Files:**
- Modify: `~/scripts/daily-integrity.sh`

- [ ] **Step 1: Adicionar as 3 funções de check Telegram após os helpers**

```bash
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
  local has_reaction has_allowed
  has_reaction=$(grep -c "message_reaction" "$server_ts" 2>/dev/null || echo 0)
  has_allowed=$(grep -c "allowed_updates" "$server_ts" 2>/dev/null || echo 0)
  if [ "$has_reaction" -gt 0 ] && [ "$has_allowed" -gt 0 ]; then
    RESULTS+=("OK|telegram|TG-PATCH|Patch present in server.ts $ver")
  else
    local missing=""
    [ "$has_reaction" -eq 0 ] && missing="message_reaction "
    [ "$has_allowed" -eq 0 ] && missing="${missing}allowed_updates"
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
  fi
  # Atualiza após registrar o resultado
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
```

- [ ] **Step 2: Testar as funções isoladamente**

```bash
# Source temporário para testar
source <(head -60 ~/scripts/daily-integrity.sh | grep -v "^set ")
check_tg_bot
echo "${RESULTS[@]}"
```
Esperado: `OK|telegram|TG-BOT|@DarkStarIIbot responding` (ou SKIP se não em .100)

---

## Task 3: Checks WAL, C4-DATA, JOURNAL, WORKER-CUSTOM

**Files:**
- Modify: `~/scripts/daily-integrity.sh`

- [ ] **Step 1: Adicionar checks de banco e sistema**

```bash
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
    RESULTS+=("FAIL|database|C4-DATA|FileReadTracking: 0 records last 24h (Phase 4 C4 inactive)")
    FAILURES=$((FAILURES + 1))
  fi
}

check_journal() {
  # Serviços ignorados: GUI e mnt temporários que falham normalmente
  local ignore_pattern="gnome-terminal-server|xdg-desktop-portal-gtk|mnt-backup.mount|colord|gvfs-|accounts-daemon"
  local errors
  errors=$(journalctl --since "24 hours ago" --priority=err --no-pager -q 2>/dev/null \
    | grep -vE "$ignore_pattern" \
    | grep -v "^$" \
    | wc -l)
  if [ "$errors" -gt 0 ]; then
    RESULTS+=("FAIL|system|JOURNAL|${errors} critical service errors in last 24h (check journalctl -p err)")
    FAILURES=$((FAILURES + 1))
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
```

- [ ] **Step 2: Syntax check**

```bash
bash -n ~/scripts/daily-integrity.sh && echo "syntax OK"
```

---

## Task 4: Main, output e ntfy

**Files:**
- Modify: `~/scripts/daily-integrity.sh`

- [ ] **Step 1: Adicionar main loop, output texto e JSON**

```bash
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
```

- [ ] **Step 2: Rodar localmente e verificar saída**

```bash
~/scripts/daily-integrity.sh
```

Saída esperada (exemplo .254):
```
=== claude-mem daily integrity check ===
Date: 2026-05-01  Host: darkstarii

--- Telegram ---
  ⏭  TG-PATCH         Telegram plugin not found (not a bot machine?)
  ⏭  TG-VERSION       Telegram plugin not found
  ⏭  TG-BOT           No token file at ...

--- Database ---
  ✅ WAL              db-wal is XMB
  ✅ C4-DATA          FileReadTracking: N records last 24h

--- System ---
  ✅ JOURNAL          No critical service errors

--- Worker ---
  ✅ WORKER-CUSTOM    telegram-reaction endpoint present

✅ RESULT: all checks passed
```

- [ ] **Step 3: Testar flag --json**

```bash
~/scripts/daily-integrity.sh --json | python3 -m json.tool | head -20
```
Esperado: JSON válido sem erros de parse.

- [ ] **Step 4: Commit**

```bash
cd ~  # daily-integrity.sh está em ~/scripts/, fora do repo
# Copiar para contrib para ter versão rastreada
cp ~/scripts/daily-integrity.sh ~/claude-mem-contrib/scripts/daily-integrity.sh
cd ~/claude-mem-contrib
git add scripts/daily-integrity.sh
git commit -m "feat: add daily-integrity.sh — silent degradation detector (7 checks)"
```

---

## Task 5: Deploy nas 3 máquinas + crons

**Files:**
- N/A (deploy de arquivo existente)

- [ ] **Step 1: Copiar script para .253 e .100**

```bash
scp ~/scripts/daily-integrity.sh 192.168.0.253:~/scripts/daily-integrity.sh
scp ~/scripts/daily-integrity.sh 192.168.0.100:~/scripts/daily-integrity.sh
echo "deploy OK"
```

- [ ] **Step 2: Confirmar chegada e permissões**

```bash
ssh 192.168.0.253 'ls -la ~/scripts/daily-integrity.sh && bash -n ~/scripts/daily-integrity.sh && echo ".253 syntax OK"'
ssh 192.168.0.100 'ls -la ~/scripts/daily-integrity.sh && bash -n ~/scripts/daily-integrity.sh && echo ".100 syntax OK"'
```
Esperado: ambos retornam `syntax OK`.

- [ ] **Step 3: Instalar cron nas 3 máquinas**

```bash
# .254
(crontab -l 2>/dev/null | grep -v 'daily-integrity'; \
 echo "50 7 * * * /home/alessandro/scripts/daily-integrity.sh --notify >> /home/alessandro/.claude-mem/logs/daily-integrity.log 2>&1") | crontab -

# .253
ssh 192.168.0.253 '(crontab -l 2>/dev/null | grep -v "daily-integrity"; \
 echo "50 7 * * * /home/alessandro/scripts/daily-integrity.sh --notify >> /home/alessandro/.claude-mem/logs/daily-integrity.log 2>&1") | crontab -'

# .100
ssh 192.168.0.100 '(crontab -l 2>/dev/null | grep -v "daily-integrity"; \
 echo "50 7 * * * /home/alessandro/scripts/daily-integrity.sh --notify >> /home/alessandro/.claude-mem/logs/daily-integrity.log 2>&1") | crontab -'
```

- [ ] **Step 4: Confirmar crons**

```bash
echo "=== .254 ==="; crontab -l | grep daily-integrity
echo "=== .253 ==="; ssh 192.168.0.253 'crontab -l | grep daily-integrity'
echo "=== .100 ==="; ssh 192.168.0.100 'crontab -l | grep daily-integrity'
```
Esperado: linha `50 7 * * *` nas 3 máquinas.

---

## Task 6: `patch-telegram.py` — script reutilizável

**Files:**
- Create: `~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py`

- [ ] **Step 1: Criar o script Python**

```python
#!/usr/bin/env python3
"""
patch-telegram.py — Reaplicar patches claude-mem no Telegram plugin.

Patches aplicados:
  1. bot.on('message_reaction') → POST /api/metrics/telegram-reaction
  2. bot.start({ allowed_updates: [..., 'message_reaction'] })

Uso:
  python3 patch-telegram.py             # detecta versão ativa automaticamente
  python3 patch-telegram.py 0.0.6       # versão explícita
  python3 patch-telegram.py --check     # só verifica, não altera
"""

import sys
import os
from pathlib import Path

CACHE_DIR = Path.home() / ".claude/plugins/cache/claude-plugins-official/telegram"
WORKER_URL = "http://localhost:37777"

# Bloco a encontrar (fim do handler de sticker)
STICKER_END = """bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})"""

# Bloco de substituição (sticker + handler de reação)
STICKER_WITH_REACTION = STICKER_END + """

// claude-mem patch: capture user reactions as feedback signals
bot.on('message_reaction', async ctx => {
  try {
    const newReactions = ctx.messageReaction?.new_reaction ?? []
    if (newReactions.length === 0) return
    const emoji = newReactions.find(r => r.type === 'emoji')?.emoji ?? '👍'
    const userId = String(ctx.messageReaction?.user?.id ?? ctx.messageReaction?.actor_chat?.id ?? 'unknown')
    await fetch('http://localhost:37777/api/metrics/telegram-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, userId }),
    }).catch(() => {})
  } catch {}
})"""

# bot.start() original
BOT_START_ORIGINAL = """      await bot.start({
        onStart: info => {"""

# bot.start() patchado
BOT_START_PATCHED = """      await bot.start({
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
        onStart: info => {"""


def get_active_version():
    versions = sorted(CACHE_DIR.iterdir(), key=lambda p: p.name) if CACHE_DIR.exists() else []
    versions = [v for v in versions if (v / "server.ts").exists()]
    return versions[-1] if versions else None


def check_patched(content: str) -> dict:
    return {
        "message_reaction": "message_reaction" in content,
        "allowed_updates": "allowed_updates" in content,
    }


def apply_patch(server_ts: Path, check_only=False) -> bool:
    content = server_ts.read_text()
    status = check_patched(content)

    print(f"  server.ts: {server_ts}")
    print(f"  message_reaction: {'✅ present' if status['message_reaction'] else '❌ missing'}")
    print(f"  allowed_updates:  {'✅ present' if status['allowed_updates'] else '❌ missing'}")

    if all(status.values()):
        print("  → Already fully patched.")
        return True

    if check_only:
        print("  → Patch needed (--check mode, not applying).")
        return False

    if STICKER_END not in content:
        print("  ERROR: sticker block not found — server.ts layout may have changed.")
        return False

    if BOT_START_ORIGINAL not in content:
        print("  ERROR: bot.start block not found — server.ts layout may have changed.")
        return False

    content = content.replace(STICKER_END, STICKER_WITH_REACTION)
    content = content.replace(BOT_START_ORIGINAL, BOT_START_PATCHED)
    server_ts.write_text(content)
    print("  → Patch applied successfully.")
    print("  → Restart the bot: pkill -f 'bun.*server.ts' (claude-patched will respawn it)")
    return True


def main():
    check_only = "--check" in sys.argv
    explicit_ver = next((a for a in sys.argv[1:] if not a.startswith("-")), None)

    if explicit_ver:
        ver_dir = CACHE_DIR / explicit_ver
        if not ver_dir.exists():
            print(f"ERROR: version {explicit_ver} not found in {CACHE_DIR}")
            sys.exit(1)
    else:
        ver_dir = get_active_version()
        if not ver_dir:
            print(f"ERROR: no Telegram plugin found in {CACHE_DIR}")
            sys.exit(1)

    print(f"Telegram plugin: {ver_dir.name}")
    server_ts = ver_dir / "server.ts"
    ok = apply_patch(server_ts, check_only=check_only)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Testar em modo --check**

```bash
mkdir -p ~/claude-mem-contrib/skills/daily-maintenance
python3 ~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py --check
```
Esperado (em .254, sem plugin Telegram ativo):
```
ERROR: no Telegram plugin found in ...
```
Em .100 (com plugin ativo e já patchado):
```
Telegram plugin: 0.0.6
  server.ts: ...
  message_reaction: ✅ present
  allowed_updates:  ✅ present
  → Already fully patched.
```

---

## Task 7: Skill `/daily-maintenance`

**Files:**
- Create: `~/claude-mem-contrib/skills/daily-maintenance/skill.md`

- [ ] **Step 1: Criar a skill**

```markdown
---
name: daily-maintenance
description: Guia manutenção diária do claude-mem — lê logs dos scripts de integridade e oferece ações corretivas para cada FAIL/WARN detectado. Invocar quando alerta ntfy disparar ou para revisão manual.
---

# Daily Maintenance

Guia interativo para resolver problemas detectados pelos scripts de monitoramento do claude-mem.

## Como usar

Invoque com `/daily-maintenance` após receber um alerta ntfy, ou como rotina matinal após 8h quando os crons já rodaram.

## Checklist de execução

Siga estes passos em ordem. Não pule etapas.

### 1. Ler os logs de hoje

Leia os 3 arquivos de log em paralelo:

```bash
# Log do daily-integrity (7 checks de degradação silenciosa)
tail -100 ~/.claude-mem/logs/daily-integrity.log

# Log do verify-custom-phases (código compilado + dados DB)
tail -100 ~/.claude-mem/logs/verify-phases.log

# Log do health-check (infra: workers, Qdrant, sync, settings)
tail -50 ~/.claude-mem/logs/health-check.log
```

Se algum log não existe, informe o usuário e continue com os que existem.

### 2. Montar painel consolidado

Apresente uma tabela com todos os FAILs e WARNs encontrados:

| Check | Status | Detalhe | Ação disponível |
|-------|--------|---------|-----------------|
| ... | FAIL/WARN | ... | ... |

Se não houver FAILs nem WARNs, informe "✅ Tudo OK — nenhuma ação necessária." e encerre.

### 3. Tratar cada problema (um por vez, com confirmação)

Para cada item da tabela, siga o playbook abaixo.

---

#### TG-PATCH FAIL — Patch Telegram sumiu

O patch `message_reaction` + `allowed_updates` precisa ser reaplicado.

```bash
# Verificar estado atual
python3 ~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py --check
```

Pergunte: "Aplicar patch no Telegram plugin? (vai modificar server.ts e reiniciar o bot)"

Se confirmado:
```bash
# Aplicar patch
python3 ~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py

# Reiniciar o bot (claude-patched faz respawn automático)
ssh 192.168.0.100 'pkill -f "bun.*server.ts" 2>/dev/null || true'

# Aguardar 5s e verificar
sleep 5
ssh 192.168.0.100 'ps aux | grep "bun.*server.ts" | grep -v grep | head -2'
```

Verificar:
```bash
PLUGIN_TOKEN=$(ssh 192.168.0.100 'grep TELEGRAM_BOT_TOKEN ~/.claude/channels/telegram/.env 2>/dev/null | cut -d= -f2')
curl -s -m 5 "https://api.telegram.org/bot${PLUGIN_TOKEN}/getMe" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok:',d.get('ok'),'@'+d.get('result',{}).get('username','?'))"
```

---

#### TG-VERSION FAIL — Versão do plugin mudou

O plugin Telegram foi atualizado e o patch provavelmente sumiu. Tratar igual a TG-PATCH FAIL acima.

Após resolver o patch, atualizar o arquivo de versão:
```bash
ls ~/.claude/plugins/cache/claude-plugins-official/telegram/ | sort -V | tail -1 > ~/.claude-mem/.last-telegram-version
```

---

#### TG-BOT FAIL — Bot não responde

```bash
# Verificar se bun server.ts está rodando no .100
ssh 192.168.0.100 'ps aux | grep "bun.*server.ts" | grep -v grep'

# Se não estiver: verificar sessão tmux
ssh 192.168.0.100 'tmux ls 2>/dev/null'
```

Se sessão `claude-tg` não existe:
```bash
ssh 192.168.0.100 'tmux new-session -d -s claude-tg -c /home/alessandro "claude-patched --channels plugin:telegram@claude-plugins-official"'
```

Se sessão existe mas bot não sobe em 30s, verificar logs:
```bash
ssh 192.168.0.100 'tmux capture-pane -p -t claude-tg 2>/dev/null | tail -20'
```

---

#### WAL WARN — db-wal > 50MB

Pergunte: "Executar WAL checkpoint no .253? (operação segura, reduz tamanho do db-wal)"

Se confirmado:
```bash
ssh 192.168.0.253 '~/.bun/bin/bun -e "
const Database = require(\"bun:sqlite\").Database;
const db = new Database(\"/home/alessandro/.claude-mem/claude-mem.db\");
const row = db.prepare(\"PRAGMA wal_checkpoint(TRUNCATE)\").get();
console.log(\"checkpoint:\", JSON.stringify(row));
const size = require(\"fs\").statSync(\"/home/alessandro/.claude-mem/claude-mem.db-wal\").size;
console.log(\"WAL after:\", (size/1024).toFixed(0) + \"KB\");
db.close();
"'
```

---

#### C4-DATA FAIL — FileReadTracking sem dados

```bash
# Verificar se endpoint existe no worker
curl -s -X POST http://localhost:37777/api/metrics/telegram-reaction \
  -H "Content-Type: application/json" -d '{"emoji":"🧪","userId":"test"}' | head -1
```

Se retornar `{"error":...}` ou connection refused → worker desatualizado, precisa rebuild:

Pergunte: "Rebuildar worker e fazer deploy? (vai compilar ~/claude-mem-contrib e sincronizar para as 3 máquinas)"

Se confirmado:
```bash
cd ~/claude-mem-contrib
rm -f plugin/scripts/worker-service.cjs
node scripts/build-hooks.js 2>&1 | tail -5
grep -c "telegram-reaction" plugin/scripts/worker-service.cjs && echo "build OK"

# Deploy .253
scp plugin/scripts/worker-service.cjs 192.168.0.253:~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
ssh 192.168.0.253 'systemctl --user restart claude-mem-worker && sleep 3 && curl -s http://localhost:37777/health | head -1'

# Deploy .100
scp plugin/scripts/worker-service.cjs 192.168.0.100:~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
ssh 192.168.0.100 'systemctl --user restart claude-mem-worker && sleep 3 && curl -s http://localhost:37777/health | head -1'

# Reiniciar local
systemctl --user restart claude-mem-worker 2>/dev/null || true
```

---

#### WORKER-CUSTOM FAIL — token `telegram-reaction` ausente no CJS

Mesmo procedimento de rebuild do C4-DATA acima.

---

#### JOURNAL FAIL — erros críticos no journalctl

Não tomar ação automática. Mostrar os erros ao usuário:

```bash
journalctl --since "24 hours ago" --priority=err --no-pager -q 2>/dev/null \
  | grep -vE "gnome-terminal-server|xdg-desktop-portal-gtk|mnt-backup.mount|colord|gvfs-|accounts-daemon" \
  | tail -20
```

Aguardar instrução do usuário.

---

### 4. Resumo final

Ao terminar todos os itens, apresentar:

- O que foi verificado
- O que foi corrigido
- O que ficou pendente (JOURNAL FAILs, problemas não confirmados)

Se houve mudanças em arquivos do repo (`claude-mem-contrib`), sugerir commit:
```bash
cd ~/claude-mem-contrib && git status --short
```
```

- [ ] **Step 2: Verificar que a skill tem frontmatter válido**

```bash
head -5 ~/claude-mem-contrib/skills/daily-maintenance/skill.md
```
Esperado: linhas com `---`, `name:`, `description:`.

- [ ] **Step 3: Commit dos arquivos da skill**

```bash
cd ~/claude-mem-contrib
git add skills/daily-maintenance/skill.md skills/daily-maintenance/patch-telegram.py
git commit -m "feat: add /daily-maintenance skill + patch-telegram.py reusable script"
```

---

## Task 8: Registrar a skill no plugin claude-mem

Para que `/daily-maintenance` funcione via Skill tool, a skill precisa estar acessível pelo plugin.

**Files:**
- Modify: `~/.claude/plugins/marketplaces/thedotmack/plugin/skills/` (symlink ou cópia)

- [ ] **Step 1: Verificar como as skills existentes são registradas**

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/
cat ~/.claude/plugins/marketplaces/thedotmack/plugin/package.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('claude',{}).get('skills',{}), indent=2))" 2>/dev/null | head -20
```

- [ ] **Step 2: Copiar skill para o plugin instalado**

```bash
cp -r ~/claude-mem-contrib/skills/daily-maintenance \
      ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/daily-maintenance
echo "skill copiada OK"
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/
```

- [ ] **Step 3: Verificar que a skill é carregável**

Invocar no Claude Code:
```
/daily-maintenance
```
Esperado: skill carrega e exibe a seção "Como usar".

- [ ] **Step 4: Adicionar cópia ao sync-to-marketplace.sh ou smart-install.js para persistência após updates**

```bash
# Verificar se existe script de post-install
grep -n "skills\|daily-maintenance" ~/claude-mem-contrib/scripts/smart-install.js 2>/dev/null | head -5
# Se não existe entrada, adicionar nota na memória para reaplicar após claude plugins update
```

- [ ] **Step 5: Commit final e push**

```bash
cd ~/claude-mem-contrib
git add .
git commit -m "feat: register daily-maintenance skill in plugin skills directory"
git push origin fix/chroma-orphan-on-worker-restart
```

---

## Self-Review

### Spec coverage

| Requisito | Task que implementa |
|-----------|-------------------|
| daily-integrity.sh com 7 checks | Tasks 1-4 |
| TG-PATCH check | Task 2 |
| TG-VERSION check | Task 2 |
| TG-BOT check | Task 2 |
| WAL check | Task 3 |
| C4-DATA check | Task 3 |
| JOURNAL check | Task 3 |
| WORKER-CUSTOM check | Task 3 |
| Flags --notify e --json | Task 4 |
| ntfy com cooldown | Task 4 |
| Deploy .253 e .100 | Task 5 |
| Cron `50 7 * * *` nas 3 máquinas | Task 5 |
| patch-telegram.py reutilizável | Task 6 |
| Skill /daily-maintenance | Task 7 |
| Skill registrada no plugin | Task 8 |
| SKIP para checks TG em máquinas sem bot | Task 2 (check_tg_patch/version/bot verifica token_file) |

### Sem placeholders detectados ✅
### Tipos consistentes ✅ (bash puro, sem tipos; python3 usa Path/str consistentemente)
