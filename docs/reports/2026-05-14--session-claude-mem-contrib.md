# Relatório de Sessão — claude-mem contrib (14/mai/2026)

**Data:** 2026-05-14  
**Máquinas:** Hyper (.100) / DarkStarII (.254)  
**Escopo:** Contribuições upstream, gestão de issues, divergência entre máquinas, fixes relacionados

---

## 1. Tentativa de PR upstream — BLOQUEADA

**Repo:** `thedotmack/claude-mem`

Tentamos criar um PR do branch `feature/server-beta` (fix ModeManager `server-beta`) via `gh pr create`. Resultado: **HTTP 403 Forbidden**.

**Causa:** O repo upstream tem **interaction limits** ativos desde ~19/abr/2026 (após cleanup do backlog). Todos os PRs abertos são exclusivamente do próprio `thedotmack`. Forks externos não conseguem abrir PRs via API.

**O que ainda funciona:** Abrir issues, comentar em issues existentes, fechar issues.

**Ação pendente:** Quando os interaction limits forem removidos (sem data prevista):
```bash
cd ~/claude-mem-contrib
gh pr create \
  --repo thedotmack/claude-mem \
  --base main \
  --head alessandropcostabr:feature/server-beta \
  --title "fix(server-beta): initialize ModeManager at startup + support CLAUDE_MEM_MODES_DIR"
```

---

## 2. Gestão de Issues Upstream

### Issue #2443 — ModeManager server-beta (reforçada)

**Título original:** ModeManager server-beta initialization failure  
**Status:** Aberta  
**Nossa ação:** Adicionamos comentário com:
- Código do fix completo (`ModeManager.initialize()` no startup do `worker-service`)
- Link para fork com o fix já aplicado
- Dados anonimizados de produção confirmando o bug

### Issue #2470 — FECHADA como duplicata

**Nossa ação:** Abrimos inadvertidamente uma nova issue sobre o mesmo bug do ModeManager. Ao identificar #2443 existente, fechamos #2470 com comentário apontando para a original.

### Issues #2424 e #2427 — Comentários com dados de produção

Adicionamos comentários nestas issues com dados observados em ambiente de produção (anonimizados: sem nomes de máquinas, IPs, projetos internos ou paths com username).

---

## 3. Estado do Fork — Divergência entre Hyper e DarkStarII

### Hyper (.100) — `~/claude-mem-contrib`

Remote: `git@github.com:alessandropcostabr/claude-mem.git` (SSH)

Branch `feature/server-beta` HEAD:
```
c4783b63 feat(server-beta): add GroqObservationProvider and ClaudeSubscriptionObservationProvider
aa50885a docs: update TODO-server-beta — dual-write active, phases re-integrated
dc178852 fix: re-wire custom phases lost in v13.2 merge
51d53b97 docs: add TODO-server-beta.md + rebuild all artifacts
9798dfc7 feat: forward hook events to server-beta (fire-and-forget)
a240e268 fix: load ModeManager in server-beta + support CLAUDE_MEM_MODES_DIR
```

Branch `master` HEAD:
```
958f0a26 fix(server-beta): initialize ModeManager at startup + support CLAUDE_MEM_MODES_DIR
```

### DarkStarII (.254) — `~/claude-mem-contrib`

Remote: `https://github.com/alessandropcostabr/claude-mem.git` (HTTPS)

Branch `feature/server-beta` HEAD:
```
aa50885a docs: update TODO-server-beta — dual-write active, phases re-integrated
dc178852 fix: re-wire custom phases lost in v13.2 merge
51d53b97 docs: add TODO-server-beta.md + rebuild all artifacts
9798dfc7 feat: forward hook events to server-beta (fire-and-forget)
a240e268 fix: load ModeManager in server-beta + support CLAUDE_MEM_MODES_DIR
```

### Diferença

Hyper tem 1 commit a mais em `feature/server-beta`:
```
c4783b63 feat(server-beta): add GroqObservationProvider and ClaudeSubscriptionObservationProvider
```

**Ação recomendada para sincronizar:**
```bash
# No DarkStarII (.254)
cd ~/claude-mem-contrib
git fetch origin
git checkout feature/server-beta
git pull origin feature/server-beta
```

Ou, se o commit estiver apenas local no Hyper (não pushado para o remote):
```bash
# No Hyper (.100) — verificar se está pushado
cd ~/claude-mem-contrib
git push origin feature/server-beta
```

---

## 4. Fix worker v12.2.0 — sync-jsonl-to-claude-mem (commit 0b37aea em ~/clawd)

**Problema:** `sync-jsonl-to-claude-mem.py` estava falhando 100% com HTTP 400 (`ValidationError → ON CONFLICT`).

**Causa raiz:** O worker v12.2.0 introduziu:
1. Novo endpoint `/api/memory/save-observation` (o antigo `/api/observations` mudou contrato)
2. Campo `text` renomeado para `narrative`
3. Índice composto `uq_obs_session_content_hash` no DB — bloqueava duplicatas silenciosamente no antigo endpoint

**Fix aplicado:** Atualizado `sync-jsonl-to-claude-mem.py` para usar o novo endpoint e campo correto.

---

## 5. Contribuições Planejadas (backlog CONTRIB_NOTES.md)

Status do gap analysis original (01/abr/2026, v10.5.5 vs v10.6.3):

| # | Feature | Status upstream | Prioridade |
|---|---------|-----------------|------------|
| 1 | summarize.ts — skip empty summary | Ainda necessário | Alta |
| 2 | ChromaSync.ts — duplicate ID fallback | Ainda necessário | Média |
| 3 | HealthMonitor.ts — atomic socket bind | Ainda necessário | Baixa |
| 4 | SessionCompletionHandler.ts — SIGTERM drain | Ainda necessário | Alta |
| 5 | session-init.ts — semantic context injection | Ainda necessário | Alta |
| 6 | SearchRoutes.ts — `/api/context/semantic` | Ainda necessário | Alta |
| 7 | SDKAgent.ts — tier routing | Ainda necessário | Média |
| 8 | Schema — observation_feedback table | Ainda necessário | Alta |
| 9 | FeedbackStore.ts | Ainda necessário | Alta |
| - | ModeManager server-beta init | **PR pronto** (bloqueado por interaction limits) | — |

Obs: o gap analysis foi feito contra v10.6.3. O upstream está em v13.2.0 — alguns itens podem ter sido resolvidos. Revalidar antes de contribuir.

---

## 6. Pendências desta sessão

1. **Interaction limits**: aguardar remoção para criar PR do ModeManager fix. Monitorar `https://github.com/thedotmack/claude-mem/issues` periodicamente.
2. **Sincronizar Hyper → .254**: commit `c4783b63` (GroqObservationProvider) ainda não está no .254.
3. **Gap analysis atualizado**: revalidar CONTRIB_NOTES.md contra v13.2.0 upstream antes de próxima rodada de contribuições.
4. **Remote Hyper usa SSH, .254 usa HTTPS**: padronizar em uma forma. SSH é preferível (não pede password).

---

## Referências

- Fork: https://github.com/alessandropcostabr/claude-mem
- Upstream: https://github.com/thedotmack/claude-mem
- Issues: #2424, #2427, #2443 (reforçada), #2470 (fechada)
- Memory: `reference_claude_mem_upstream.md` em `~/.claude/projects/-home-alessandro/memory/`
