# TODO — Server-Beta Migration

> Status: Fase 1-3 concluídas (2026-05-12). Paralelo operacional.

## Concluído

- [x] Merge upstream v13.2 → fork (branch `feature/server-beta`, 8 commits)
- [x] Custom phases preservadas (BanditEngine, FeedbackRecorder, FileReadTracking, HybridScorer, Qdrant)
- [x] Build green (worker-service, server-beta-service, mcp-server, npx-cli)
- [x] Postgres DB `claude_mem` no .253 (12 tabelas, schema v1)
- [x] Redis db1 para BullMQ (isolado do LATE em db0)
- [x] Systemd service `claude-mem-server-beta` (enabled, linger=yes, porta 37877)
- [x] Migração SQLite → Postgres (22.116 observations, 311 sessions, 0 erros)
- [x] Dedup e higienização (4.597 failed pending, 106 deprecated, 3.527 null-hash calculados)
- [x] Generation provider Gemini flash-lite (free tier, E2E testado)
- [x] Fix ModeManager (`CLAUDE_MEM_MODES_DIR` env var)
- [x] Hook forwarding fire-and-forget (hook-command.ts → POST /v1/events)
- [x] Settings configurados nas 3 máquinas
- [x] Deps instaladas nas 3 máquinas (bullmq, ioredis, pg, better-auth)
- [x] Testado em produção: hooks desta sessão → Postgres → Gemini → observations

## Pendente

### Próxima fase — Migrar workers

- [ ] Apontar workers para ler observations do Postgres (via server-beta API) em vez de SQLite local
- [ ] Migrar context injection (SessionStart hook) para buscar no Postgres
- [ ] Re-indexar Qdrant com IDs do Postgres (quando workers pararem de usar SQLite)
- [ ] Integrar HybridScorer no `/v1/search` do server-beta
- [ ] Desligar sync SQLite entre máquinas (rsync não mais necessário)
- [ ] Avaliar desligar Gemini generation (se workers via OAuth forem suficientes)

### Melhorias

- [ ] Auth: migrar de `local-dev` para API key scoped por máquina
- [ ] Adicionar `machine` field no payload do hook forward (identificar origem)
- [ ] Monitoramento: adicionar server-beta ao health-check.sh e daily-integrity.sh
- [ ] Backup: incluir Postgres `claude_mem` no cron de backup do .253
- [ ] Considerar `CLAUDE_MEM_SERVER_BETA_SESSION_ID` dinâmico (criar session por sessão CC)

### Feedback ao Alex (thedotmack)

- [ ] Compartilhar experiência de setup (multi-machine, Qdrant, custom phases)
- [ ] Reportar bug ModeManager (não inicializa no server-beta, fix com CLAUDE_MEM_MODES_DIR)
- [ ] Sugerir `machine` / `source_host` field nos events
- [ ] Discutir roadmap: Qdrant vs Chroma, HybridScorer upstream
