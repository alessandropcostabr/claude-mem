# TODO — Server-Beta Migration

> Status: Fase 1-4 concluídas (2026-05-13). Dual-write ativo nas 3 máquinas.

## Concluído

- [x] Merge upstream v13.2 → fork (branch `feature/server-beta`, 8 commits)
- [x] Custom phases re-integradas após merge (dc178852): MemoryRoutes/Governance, MCP save/gov tools, HybridScorer, SEMANTIC_MAX_TOKENS, telegram-reaction — 19/19 tokens verificados
- [x] Build green + marketplace sincronizado nas 3 máquinas (.100, .253, .254)
- [x] Postgres DB `claude_mem` no .253 (12 tabelas, schema v1)
- [x] Redis db1 para BullMQ (isolado do LATE em db0)
- [x] Systemd service `claude-mem-server-beta` (enabled, linger=yes, porta 37877)
- [x] Migração SQLite → Postgres (22.116 observations, 311 sessions, 0 erros) — fonte: .254
- [x] Dedup e higienização (4.597 failed pending, 106 deprecated, 3.527 null-hash calculados)
- [x] Generation provider Gemini flash-lite (free tier, E2E testado)
- [x] Fix ModeManager (`CLAUDE_MEM_MODES_DIR` env var)
- [x] Hook forwarding dual-write (hook-command.ts → SQLite local + POST /v1/events fire-and-forget)
- [x] API key `hook-forward` criada no Postgres com scopes corretos (memories:write/read, events:write)
- [x] `CLAUDE_MEM_SERVER_BETA_API_KEY` atualizado nas 3 máquinas — dual-write E2E confirmado
- [x] SQLite canonical: .254 é fonte (merge bidirecional via sync-claude-memory.sh */15min)
- [x] Deps instaladas nas 3 máquinas (bullmq, ioredis, pg, better-auth)

## Pendente

### Próxima fase — Migrar workers

- [ ] Apontar workers para ler observations do Postgres (via server-beta API) em vez de SQLite local
- [ ] Migrar context injection (SessionStart hook) para buscar no Postgres
- [ ] Re-indexar Qdrant com IDs do Postgres (quando workers pararem de usar SQLite)
- [ ] Integrar HybridScorer no `/v1/search` do server-beta
- [ ] Desligar sync SQLite entre máquinas (rsync não mais necessário)
- [ ] Avaliar desligar Gemini generation (se workers via OAuth forem suficientes)

### Melhorias

- [ ] Auth: criar API key separada por máquina (hoje todas usam a mesma `hook-forward`)
- [ ] Adicionar `machine` field no payload do hook forward (identificar origem)
- [ ] Monitoramento: adicionar server-beta ao health-check.sh e daily-integrity.sh
- [ ] Backup: incluir Postgres `claude_mem` no cron de backup do .253
- [ ] Considerar `CLAUDE_MEM_SERVER_BETA_SESSION_ID` dinâmico (criar session por sessão CC)

### Feedback ao Alex (thedotmack)

- [ ] Compartilhar experiência de setup (multi-machine, Qdrant, custom phases)
- [ ] Reportar bug ModeManager (não inicializa no server-beta, fix com CLAUDE_MEM_MODES_DIR)
- [ ] Sugerir `machine` / `source_host` field nos events
- [ ] Discutir roadmap: Qdrant vs Chroma, HybridScorer upstream
