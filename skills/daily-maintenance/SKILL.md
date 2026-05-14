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

#### SKILL-INSTALL FAIL — /daily-maintenance skill ausente

A skill foi apagada por um plugin update. Reinstalar:

```bash
# Do repo para o plugin dir local
cp ~/claude-mem-contrib/skills/daily-maintenance/{SKILL.md,patch-telegram.py} \
   ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/daily-maintenance/

# Para as outras máquinas
scp ~/claude-mem-contrib/skills/daily-maintenance/{SKILL.md,patch-telegram.py} \
  192.168.0.253:~/.claude/plugins/marketplaces/thedotmack/plugin/skills/daily-maintenance/
scp ~/claude-mem-contrib/skills/daily-maintenance/{SKILL.md,patch-telegram.py} \
  192.168.0.100:~/.claude/plugins/marketplaces/thedotmack/plugin/skills/daily-maintenance/
```

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
