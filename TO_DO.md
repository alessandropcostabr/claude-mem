# TO_DO — claude-mem-contrib

> **⚠️ INTERNAL FILE — DO NOT SEND UPSTREAM**
>
> This file tracks local debt and pending work specific to the fork at
> `alessandropcostabr/claude-mem`. It lives on the `test/rebase-12.1.0-custom`
> branch (and any derivatives). It must NOT be included in any PR to
> `thedotmack/claude-mem` upstream.
>
> When preparing an upstream PR, cherry-pick only the functional commits
> (feat/fix/docs) onto a clean branch derived from `main`, and explicitly
> exclude the `chore(internal): add TO_DO.md tracking local debt` commit.

> Pendências conhecidas com nível de prioridade e contexto suficiente pra retomar em qualquer sessão futura.
> Última atualização: **2026-04-10** (pós bug-fix `dominantType`)
> Branch atual: `test/rebase-12.1.0-custom`

---

## ✅ Fechado em 2026-04-10 (referências)

- **`dominantType is not defined` em `SessionRoutes.ts::applyTierRouting`** — bug de refactor, variável `dominantType` usada em linha 887 quando o nome correto era `rewardedType` (declarado linha 881). Afetava 100% das observations criadas por PostToolUse (Bash, Write, Edit) e o endpoint `/api/sessions/summarize`. 71 errors acumulados no log `claude-mem-2026-04-10.log` antes do fix. **Fixado, rebuilt, deployed, sync pro fleet. Zero errors depois do restart às 14:40**. Commit pendente.

---

## 🔴 Alta prioridade

### 1. Abrir issue/PR upstream sobre `createObservationFeedbackTable` (bug nosso merged)
**Contexto**: commit `0fcc0788` ("feat: tier routing by queue complexity + observation feedback table", Alessandro, 2026-04-01) introduziu em `src/services/sqlite/migrations/runner.ts` o método `createObservationFeedbackTable` com schema **incompatível** com o que `src/services/bandit/FeedbackRecorder.ts::recordFeedback()` insere. PR #1641 mergeou upstream. Como `runner.ts` é orphan no runtime (worker usa SessionStore direto), o bug nunca exploded em produção — mas uma **instalação fresca** do plugin quebraria ao receber o primeiro signal.

**Ação local já aplicada (2026-04-10)**:
- `SessionStore.ts` ganhou `createObservationFeedbackTable()` com schema correto (migration 30)
- `runner.ts` schema corrigido pra consistência
- Fleet atual protegido

**Ação upstream pendente**:
- [ ] Abrir issue em `thedotmack/claude-mem` descrevendo o bug (mencionar PR #1641 como origem)
- [ ] Abrir PR de fix — opções:
  - (a) Mover método pro equivalente no SessionStore upstream se existir
  - (b) Ou apenas corrigir schema em runner.ts e adicionar nota de que é orphan
- [ ] Referenciar o fix local deste repo como comprovação

**Arquivos relevantes**:
- `src/services/sqlite/migrations/runner.ts` (linhas 868+, método orphan)
- `src/services/sqlite/SessionStore.ts` (linhas 1103+, implementação correta — migration 30)
- `src/services/bandit/FeedbackRecorder.ts:18` (query que define o schema esperado)

---

### 2. Consolidar runner.ts → SessionStore.ts (deletar duplicação)
**Contexto**: hoje existem **dois sistemas de migration** rodando paralelos:
- `src/services/sqlite/migrations/runner.ts::MigrationRunner` — **orphan no runtime do worker**, só alcançado por tests e pelo singleton `sqlite/Database.ts::DatabaseManager` (sem callers de produção)
- `src/services/sqlite/SessionStore.ts` (constructor linhas 40-70) — **runtime source of truth** do worker

Os dois divergem em migrations específicas (ex: `runner.ts` tem `createObservationFeedbackTable` schema errado historicamente, `SessionStore.ts` tem `addObservationModelColumns` v26 que runner.ts não tem). A sessão de 2026-04-10 gastou ~30 minutos diagnosticando essa confusão.

**Mitigação já aplicada**: cabeçalhos de aviso prominentes em ambos arquivos alertando devs futuros pra adicionar migrations SEMPRE em SessionStore. Ver class-level docstrings.

**Ação pendente (escopo dedicado)**:
- [ ] Deletar `src/services/sqlite/migrations/runner.ts`
- [ ] Remover uso em `src/services/sqlite/Database.ts` (linhas 8, 171-172, 351)
- [ ] Remover re-exports em `src/services/sqlite/migrations.ts:5` e `src/services/sqlite/index.ts:7`
- [ ] Reescrever ou deletar `tests/services/sqlite/migration-runner.test.ts` (~28 usos de `MigrationRunner`)
- [ ] Atualizar `tests/services/sqlite/schema-repair.test.ts` (3 usos)
- [ ] Verificar que os 9 arquivos de teste que importam `sqlite/Database.ts` continuam compilando
- [ ] Rodar `npm test` pra garantir nada quebrou
- [ ] Rebuild + deploy + smoke test

**Estimativa**: sessão dedicada de 2-3 horas. Não misturar com feature work.

---

### 3. Investigar 657 observations com `generated_by_model=null` (7d)
**Contexto**: snapshot de 2026-04-10 mostrou que **657 das ~1.550 observations criadas nos últimos 7 dias** têm `generated_by_model = null`. Isso é ~42% — bem acima do esperado. Pode ser:
- Observations criadas antes do schema `generated_by_model` existir (mas a column existe desde v26 em 02/abr)
- Observations criadas via path que não preenche o campo (workers antigos? merge do sync?)
- Bug de migração do script de sync (`sync-claude-memory.sh` faz INSERT OR IGNORE mas pode não preservar `generated_by_model` em certos paths — vi antes que ele usa `bun -e` com INSERT explícito que ALI inclui `generated_by_model`)

**Ação pendente**:
- [ ] Query diagnóstica: `SELECT memory_session_id, DATE(datetime(created_at_epoch/1000,'unixepoch','localtime')), COUNT(*) FROM observations WHERE generated_by_model IS NULL AND created_at_epoch > (strftime('%s','now')-604800)*1000 GROUP BY 1,2 ORDER BY 3 DESC`
- [ ] Verificar se as null rows vêm de sessões específicas (worker antigo? agent sem atribuição?)
- [ ] Se forem de sync, verificar qual path do sync não preenche
- [ ] Backfill opcional via heurística (author default baseado em session platform_source)

---

## 🟡 Média prioridade

### 4. Correlação `explicit_fetch` no file_read_tracking
**Contexto**: migration 29 (2026-04-10) expandiu o enum `action` para incluir `'explicit_fetch'`, reservado para quando Claude chama `get_observations` via MCP tool *após* um read. Hoje a coluna existe mas **nenhum código escreve nela** — o `get_observations` handler em `src/servers/mcp-server.ts:325` apenas loga (via `logger.info`) e delega pro worker API.

**Ação pendente** (opcional, baixo ROI no momento):
- [ ] No handler `get_observations` do MCP server, antes do POST para `/api/observations/batch`, correlacionar com reads recentes via:
  - Heurística: consultar `file_read_tracking` pela `sessionId` corrente nos últimos 60s
  - Se houver match, inserir nova row com `action='explicit_fetch'` copiando `file_path` do read correlacionado
- [ ] Alternativa mais limpa: adicionar endpoint `/api/metrics/explicit-fetch` que recebe `{sessionId, ids}` e faz o correlation + insert no worker
- [ ] Atualizar `FileReadTracking.getStats()` se precisar (já conta `explicit_fetch` em `readsEnriched`)

**Motivação de baixo ROI atual**: `get_observations_hit` está dormindo há 9 dias (último event em 01/abr 07:05). Ninguém chama. Só vale implementar quando houver consumer ativo.

---

### 5. Ghost da migration 28 — identificar origem histórica
**Contexto**: a tabela `file_read_tracking` existia no DB antes do SessionStore tê-la declarada como migration, e antes da v28 aparecer em `schema_versions`. `createFileReadTrackingTable` foi adicionado ao SessionStore apenas em 2026-04-10 (esta sessão). Origem desconhecida — provavelmente script ad-hoc, test fixture ou migração manual via CLI que foi removida depois.

**Ação pendente** (baixo ROI, só pra completude forense):
- [ ] `git log --all -p --follow -- src/services/sqlite/` procurando primeiro commit com `file_read_tracking`
- [ ] Verificar se há script em `scripts/` ou `bin/` que cria a tabela manualmente
- [ ] Documentar a origem ou fechar como "histórico perdido aceito"

---

### 6. `get_observations` MCP tool — revisar em 30 dias
**Contexto**: sessão de 2026-04-10 decidiu manter o tool como fallback documentado (não deprecar). Foi adicionada telemetria leve (`logger.info('MCP', 'get_observations invoked (fallback path): N IDs requested')`) pra monitorar se o path volta a ser usado. Último `get_observations_hit` feedback registrado: 2026-04-01 07:05.

**Ação pendente (revisar em ~2026-05-10)**:
- [ ] Grep logs do worker por "get_observations invoked" nos últimos 30 dias
- [ ] Se zero invocations → considerar deprecation formal (remover do manifest + enforce sunset)
- [ ] Se alguma invocation → identificar consumer, documentar, manter

---

## 🟢 Baixa prioridade / longo prazo

### 7. Fase 8 — Retrieval Inteligente (DESBLOQUEADA 2026-04-10)
**Contexto**: plano mestre em `~/.claude/docs/memory-architecture-proposal.md`. A dependência "C4 acceptance > 0" foi reinterpretada — métrica agora usa `'auto_enriched'` (migration 29) e reporta 100% corretamente. Reward signals reais (`semantic_inject_hit` com ~1.048 events/48h) já alimentam o bandit `model-per-obs-type`.

**Target soft**: 2026-05-03.

**Ação pendente** (feature de peso — sessão dedicada):
- [ ] Hydration condicional por distância temporal (sessão atual: raw, passado: summary)
- [ ] Pesos dinâmicos por tipo de query (temporal / factual / geral)
- [ ] Scoring híbrido pós-ChromaDB: `similarity×0.4 + recency×0.3 + authority×0.2 + coherence×0.1`
- [ ] Log de decisão de ranking (new table? existing logger?)
- [ ] Instrumentar as 5 métricas do pipeline

**Critério de conclusão**: scoring híbrido ativo + acceptance rate ≥ 90% + log de decisão rastreável.

---

### 8. Fase 7 — Governança `/mem` commands (TARGET 19/abr)
**Contexto**: plano mestre. UX pura, sem dependência de dados.

**Ação pendente**:
- [ ] `/mem add`
- [ ] `/mem forget <id>` (com sole-memory protection — checar se é a última observation ativa)
- [ ] `/mem confirm <id>`
- [ ] `/mem flag <id>`
- [ ] `/mem stats`
- [ ] Corrigir `dateRange` no Chroma free-text path (cutoff rígido de 90 dias bloqueia scoring gradual)

---

### 9. Fase 9 — Detecção de conflito por entidades (TARGET 17/mai)
**Contexto**: depende das fases 7-8 estáveis + ≥5 observations com `correctness='confirmed'` (via `/mem confirm`).

- [ ] Ver notas completas em `~/.claude/docs/memory-architecture-proposal.md`

### 10. Bandit arms residuais (não é bug, é design — documentar)
**Contexto**: 2026-04-10 esclarecido — arms com `pulls=0` e `total_reward>0` (ex: `change:sonnet`, `decision:opus`) não são bug. Dois code paths atualizam os arms: sampling loop incrementa `pulls`, FeedbackRecorder atualiza `alpha/beta` + `total_reward` mas não `pulls`. Esses arms recebem rewards via `semantic_inject_hit` mesmo sem terem sido selecionados via Thompson Sampling. Verificável com `total_reward == (alpha-1)` exato em todas as linhas.

**Ação pendente**:
- [ ] Opcional: renomear colunas pra maior clareza semântica (`pulls` → `sampling_count`, `total_reward` → `accumulated_reward_from_all_sources`) — MUITO invasivo, só se tiver outra refactor junto
- [ ] Ou adicionar nota no schema/comentário

---

## 📝 Notas operacionais

### Sobre o fleet sync
- `.254 → .253`: 100% uptime
- `.254 → .100`: 93.7% uptime (SSH glitches intermitentes — patch retry 3x aplicado em `~/scripts/sync-claude-memory.sh` em 2026-04-10)
- `.254 → .220`: ~27% uptime (esperado, Windows laptop offline maior parte do tempo)

### Sobre diferenças runner.ts ↔ SessionStore.ts
**NUNCA** adicione migrations em `src/services/sqlite/migrations/runner.ts` pensando que o worker vai executar. Adicione em `src/services/sqlite/SessionStore.ts` no constructor. Verifique que foi bundled com:

```bash
cd ~/claude-mem-contrib && npm run build
grep 'your_unique_marker' plugin/scripts/worker-service.cjs
```

Se zero matches, o método foi tree-shaken/não importado.

### Sobre o `channelsEnabled` gate em Claude Code 2.1.100+
Plugins que usam `mcp.notification({ method: 'notifications/claude/channel' })` (telegram, discord, slack, imessage etc) precisam de `claude --channels plugin:<name>@<marketplace>` na CLI. Sem a flag, a notification é descartada silenciosamente. Ver `~/.claude/projects/-home-alessandro--claude/memory/reference_claude_code_channels_gate.md`.
