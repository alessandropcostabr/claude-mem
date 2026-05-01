# Daily Maintenance — Design Spec
**Data:** 2026-05-01
**Status:** Aprovado
**Branch:** fix/chroma-orphan-on-worker-restart

---

## Contexto

Durante a sessão de 01/mai/2026 foram identificadas várias categorias de problemas que surgem silenciosamente e só são percebidos em revisões manuais:

- Patch Telegram (`message_reaction`) some após `claude plugins update`
- WAL do SQLite cresce indefinidamente se não há checkpoint periódico
- FileReadTracking (Phase 4 C4) pode estar sem dados sem que o alerta disparasse
- `verify-custom-phases.sh` tinha bug bash que impedia execução (`((FAILURES++))` com `set -euo pipefail`)
- Plugin version bumps sobrescrevem patches locais sem aviso

O sistema já tem `claude-mem-health-check.sh` (infra: workers, Qdrant, sync, settings) e `verify-custom-phases.sh` (código compilado + dados DB). O gap é a detecção de degradação silenciosa de integridade — coisas que ficam "vivas mas erradas".

---

## Solução: Híbrido — Script de detecção + Skill de ação

### Componente 1: `daily-integrity.sh`

**Arquivo:** `~/scripts/daily-integrity.sh` (deployado nas 3 máquinas via scp)
**Cron:** `50 7 * * *` — 10 minutos antes do verify-custom-phases (8h)
**Log:** `~/.claude-mem/logs/daily-integrity.log`
**Flags:** `--notify` (alerta ntfy), `--json` (output estruturado para parsing)
**Exit code:** número de FAILs (0 = tudo OK)

#### Checks implementados

| ID | Check | Condição FAIL | Condição WARN |
|----|-------|--------------|---------------|
| TG-PATCH | Patch Telegram intacto | `message_reaction` ou `allowed_updates` ausentes no server.ts ativo | — |
| TG-VERSION | Plugin version bump | versão do plugin mudou desde último run (arquivo `.last-telegram-version`) | — |
| TG-BOT | Telegram bot polling | `getMe` não responde em 5s | — |
| WAL | WAL size | — | `.db-wal` > 50MB |
| C4-DATA | FileReadTracking ativo | 0 registros em `file_read_tracking` nas últimas 24h | — |
| JOURNAL | journalctl erros críticos | serviços core com erro nas últimas 24h. Ignorados: `gnome-terminal-server`, `xdg-desktop-portal-gtk`, `mnt-backup.mount`, `colord`, `gvfs-*` | — |
| WORKER-CUSTOM | worker custom tokens | `telegram-reaction` ausente no worker-service.cjs instalado | FAIL |

#### Comportamento

```bash
# Saída texto padrão
=== claude-mem daily integrity check ===
Date: 2026-05-01  Host: darkstarii

--- Telegram ---
  ✅ TG-PATCH     Patch message_reaction present in server.ts 0.0.6
  ✅ TG-VERSION   Plugin version unchanged (0.0.6)
  ✅ TG-BOT       @DarkStarIIbot responding

--- Database ---
  ⚠️  WAL         db-wal is 62MB (> 50MB threshold)
  ✅ C4-DATA      FileReadTracking: 47 records last 24h

--- System ---
  ✅ JOURNAL      No critical service errors

--- Worker ---
  ✅ WORKER-CUSTOM telegram-reaction endpoint present

⚠️  RESULT: 1 warning — run /daily-maintenance to fix
```

#### Notas de implementação

- Checks TG-* só rodam em `.100` (único com bot ativo). Nas outras máquinas, reportam `SKIP`.
- Token do bot lido de `~/.claude/channels/telegram/.env` — nunca hardcoded.
- `.last-telegram-version` salvo em `~/.claude-mem/` após cada run bem-sucedido.
- Alerta ntfy só quando há FAIL (não para WARN) — mesma lógica do health-check.

---

### Componente 2: Skill `/daily-maintenance`

**Arquivo:** `~/claude-mem-contrib/skills/daily-maintenance/skill.md`
**Invocação:** `/daily-maintenance` no Claude Code
**Propósito:** guiar o operador pelos fixes necessários com base nos logs dos 3 scripts

#### Fluxo

```
1. LEITURA DE ESTADO
   - Lê daily-integrity.log (hoje)
   - Lê verify-phases.log (hoje)
   - Lê health-check.log (última hora)
   - Consolida: lista de FAILs + WARNs com timestamps

2. PAINEL CONSOLIDADO
   Exibe tabela: check | status | última vez OK | ação disponível

3. AÇÕES GUIADAS (uma por vez, com confirmação)

   Se TG-PATCH FAIL:
   → Mostra patch necessário, pergunta máquina alvo, aplica via python3 inline
   → Reinicia bun server.ts (kill + aguarda respawn do claude-patched)
   → Verifica com getMe

   Se WAL > 50MB:
   → Executa PRAGMA wal_checkpoint(TRUNCATE) na máquina afetada
   → Reporta tamanho antes/depois

   Se C4-DATA FAIL:
   → Verifica endpoint /api/metrics/telegram-reaction no worker
   → Se ausente: instrui rebuild (rm .cjs + node scripts/build-hooks.js) + scp
   → Se presente mas zero: investiga (file-context.ts ativo? hook rodando?)

   Se WORKER-CUSTOM FAIL:
   → Instrui rebuild completo do contrib + deploy nas máquinas

   Se JOURNAL FAIL:
   → Mostra os erros, não toma ação — operador decide

4. RESUMO FINAL
   - Lista o que foi feito
   - Se houve mudanças em arquivos: sugere commit
   - Atualiza memória com o estado pós-manutenção
```

#### O que a skill NUNCA faz sem confirmação explícita

- Rebuild do worker (`rm .cjs + build-hooks.js`)
- `scp` para máquinas remotas
- Restart de processos
- Modificar arquivos de plugin

#### Localização dos arquivos de skill

```
~/claude-mem-contrib/skills/daily-maintenance/
  skill.md          ← conteúdo da skill (carregado pelo Skill tool)
  patch-telegram.py ← script python reutilizável para aplicar o patch
```

---

## Crons finais (nas 3 máquinas)

| Horário | Script | Máquina |
|---------|--------|---------|
| `50 7 * * *` | `daily-integrity.sh --notify` | .254/.253/.100 |
| `0 8 * * *` | `verify-custom-phases.sh --notify` | .254/.253/.100 |
| `0,30 7-21 * * *` | `claude-mem-health-check.sh` | .254 (monitora as 3) |

---

## Arquivos a criar/modificar

| Arquivo | Ação |
|---------|------|
| `~/scripts/daily-integrity.sh` | Criar (novo) |
| `~/claude-mem-contrib/skills/daily-maintenance/skill.md` | Criar (novo) |
| `~/claude-mem-contrib/skills/daily-maintenance/patch-telegram.py` | Criar (novo) |
| `~/scripts/` em .253 e .100 | Deploy via scp |
| crontab em .253 e .100 | Adicionar entry `50 7 * * *` |

---

## Fora de escopo

- Modo `--auto` (executar ações sem confirmação) — pode ser adicionado futuramente
- Checks de telemetria PG / benchmark CC versions
- Monitoramento do OraClaw / OpenClaw (já coberto por seus próprios logs)
