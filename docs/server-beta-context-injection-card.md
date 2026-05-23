# feat(server-beta): Injeção de contexto server-side (Injetar ← PG remoto)

> Card criado 2026-05-23. Contexto: validação do cliente Windows (notebook) externo via 5G
> revelou que `runtime=server-beta` faz **save central** (→ PG) mas **inject local-only** (← SQLite).
> Objetivo deste card: fechar o inject pelo servidor e **matar o SQLite/worker local** nos clientes.

## Objetivo
Fazer o `SessionStart` injetar contexto **lendo do servidor server-beta (PG remoto)**, eliminando a
dependência do **SQLite + worker LOCAL** nos clientes. Hoje só o *save* passa pelo server-beta; o
*inject* ainda é local.

## Problema
Em `runtime=server-beta` os caminhos estão **assimétricos**:
- **Save:** hook → `POST /v1/events` → PG remoto ✅
- **Inject:** `context.ts` → `executeWithWorkerFallback('/api/context/inject', 'GET')` → **worker LOCAL** → **SQLite LOCAL** ❌

Consequência: memória forwardada não volta como contexto. Cliente novo = "no memory yet". A injeção
compartilhada da frota ainda depende do SQLite + sync — não morre enquanto isso existir.
`session-init.ts` admite: *"Skip semantic injection in server-beta mode until the server-beta context
endpoint exists."*

## Estado atual (código)
| Arquivo | Hoje | Precisa |
|---|---|---|
| `src/cli/handlers/context.ts` | chama worker local `/api/context/inject` | se `runtime===server-beta` → chamar o servidor |
| `src/cli/handlers/session-init.ts` | pula injeção semântica em server-beta | usar o endpoint novo |
| servidor server-beta (`ServerV1PostgresRoutes.ts`) | tem `/v1/search` (semântico), PG + embeddings + Qdrant | expor `/v1/context/inject` |

## Proposta técnica
1. **Endpoint novo no servidor:** `GET/POST /v1/context/inject` (scope `memories:read`) que recebe
   `project_id` + sinal de relevância (cwd/repo/últimos prompts) e retorna o **timeline formatado** +
   token budget (equivalente ao `/api/context/inject` do worker local). Reusar a base de `/v1/search`
   (Qdrant) → injeção por **relevância semântica** (melhor que o scoping por nome de projeto do SQLite).
2. **Cliente (`context.ts`):** se `resolveRuntimeContext().runtime === 'server-beta'` → usar
   `ServerBetaClient` pro endpoint novo (Bearer key + `project_id`), com **timeout curto (~1-2s) +
   fallback pra vazio** (não bloquear o start se o servidor estiver lento/offline).
3. **Scoping:** todos forwardam pro mesmo `project_id`. Opções: (a) semântico puro (top-N por
   similaridade, ignora repo); (b) tag de path/repo nas observations p/ filtrar por projeto.
   Recomendado **(a) + filtro opcional por repo**.
4. **Desligar o local:** com inject ← servidor funcionando, remover dos clientes: worker LOCAL
   (`worker-service.cjs start`), SQLite (`claude-mem.db`) e o sync de SQLite da frota. Cliente vira
   **stateless** (só forward + inject via HTTP).

## Critérios de aceite
- [ ] Sessão nova em `runtime=server-beta` injeta observations relevantes vindas do PG remoto (sem SQLite local).
- [ ] Cliente externo (notebook/5G) recebe contexto na 2ª sessão de um projeto já forwardado.
- [ ] Timeout/fallback: servidor offline → start não trava (injeta vazio).
- [ ] Paridade de formato com a injeção local atual (timeline + token budget).
- [ ] Cliente roda **sem** worker local nem `claude-mem.db`.

## Pré-requisito relacionado: fix de linkagem `tool_use` → sessão (bug)
Hoje os eventos `tool_use` chegam ao PG com **`server_session_id=NULL`** (não amarrados à sessão), então qualquer scoping por sessão/recência fica capenga. Raiz (rastreada 23/05): **nenhum** handler do cliente envia `serverSessionId` (todos mandam só `contentSessionId`); o `/v1/events` faz `serverSessionId: body.serverSessionId ?? null` e **não resolve** do `contentSessionId` que recebe e guarda. Já `assistant_message` linka porque vem via `/v1/sessions/:id/end` (o server pega a sessão do path `:id`).
- **Fix (server-side, pequeno):** no ingest do `/v1/events` (`toAgentEventInput`/`ingestOne`, `ServerV1PostgresRoutes.ts:~982`), se `serverSessionId` for null e houver `contentSessionId`, resolver `SELECT id FROM server_sessions WHERE content_session_id=$1 AND project_id=$2 (AND team_id=...)`. A sessão já existe (registrada pelo `session-init` → `/v1/sessions/start`).
- **Por que importa pra este card:** com `tool_use` linkado, o inject pode fazer scoping por sessão/recência além do semântico, e as observations da sessão viram um conjunto coeso.

## Riscos & dependências
- **Latência no start:** vira chamada de rede (~91ms medido no 5G) → exige timeout+fallback.
- **Relevância:** scoping por `project_id` único pode injetar memória de outros repos → resolver com semântico/tag.
- **Auth:** scope `memories:read` (clientes de forwarding já têm `memories:*` no modelo grosso do vanilla).
- **Migração:** desligar SQLite/sync só **depois** do inject-server validado (rollback = reativar worker local).

## Resultado
Cliente **stateless puro**: forward → PG, inject ← PG. **SQLite local e worker local mortos.** Frota
inteira (incl. clientes externos no 5G) compartilha a mesma memória central, sem sync de arquivo.

---
**Refs:** validado em 22-23/05 que `context.ts` usa `executeWithWorkerFallback('/api/context/inject')`
(worker local, porta 38888 notebook / 37777 Linux), nunca o `.253`. Server-beta deployado = 13.3.0 +
fix #2443 (branch `server-beta-13.3.0-modefix`). MCP/`/v1/search` já lê do PG (cutover concluído).
