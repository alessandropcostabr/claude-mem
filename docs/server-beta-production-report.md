# claude-mem `server-beta` — Production Field Report

*From: running server-beta across a 3-machine fleet since 2026-05-12*
*For: Alex / thedotmack — companion to the May 19 papercut notes*

---

## TL;DR

server-beta has been our **primary** memory backend for ~10 days across 3 machines, serving real Claude Code dev work. It's a genuine step up from the SQLite+sync model — one shared backend instead of per-machine DBs with merge. This report covers what you asked for: a minimal **hello world**, how it works as we observe it, our production setup, an annotated config reference, what we do differently, and the **data/incidents from running it under load**.

The single biggest gap for a new dogfooder isn't the code — it's the **client→server handshake** (how a Claude Code instance is told to forward to the server). Section 1 nails that down.

---

## 1. Hello World — minimal single-machine bootstrap

The smallest thing that is a working server-beta + one Claude Code client on the **same box**.

**Prereqs:** Postgres and Redis reachable locally. An empty Postgres DB (`claude_mem`).

**Server `.env` (this is essentially our prod minus secrets):**
```bash
CLAUDE_MEM_QUEUE_ENGINE=bullmq
CLAUDE_MEM_SERVER_DATABASE_URL=postgresql://user:pass@localhost:5432/claude_mem
CLAUDE_MEM_REDIS_URL=redis://localhost:6379/1
CLAUDE_MEM_SERVER_HOST=0.0.0.0
CLAUDE_MEM_SERVER_PORT=37877
CLAUDE_MEM_AUTH_MODE=local-dev                 # single-user; skips API-key friction
CLAUDE_MEM_DATA_DIR=$HOME/.claude-mem
CLAUDE_MEM_MODES_DIR=<plugin>/modes            # observation prompt templates (code.json etc.)
# pick ONE provider:
CLAUDE_MEM_SERVER_PROVIDER=gemini
CLAUDE_MEM_GEMINI_API_KEY=...
CLAUDE_MEM_GEMINI_MODEL=gemini-2.5-flash
# IMPORTANT (see §6) — without this you get ~1 LLM call per tool call:
CLAUDE_MEM_SERVER_SESSION_POLICY=end-of-session
```

**Start the daemon:** our entrypoint (`start.cjs`) just calls `runServerBetaCli(["--daemon"])`. It applies the PG schema on first run. Verify:
```bash
curl -s localhost:37877/health        # → {"status":"ok"}
```

**Client (Claude Code) — point it at the server.** *This is the least-documented part.* In the client's settings env:
```bash
CLAUDE_MEM_RUNTIME=server-beta
CLAUDE_MEM_SERVER_URL=http://localhost:37877
# + an API key matching the server if AUTH_MODE != local-dev
```
When set, the local worker enters **forwarding-only mode** — it logs `MCP runtime=server-beta — skipping worker auto-start` and every hook event POSTs to `/v1/events` on the server instead of generating locally.

**Verify the loop end-to-end:** run a Claude Code session, do a little work, **end the session** (the `Stop`/`SessionEnd` hook is what triggers generation under `end-of-session`). Then:
```bash
psql "$CLAUDE_MEM_SERVER_DATABASE_URL" -c "SELECT count(*) FROM observations;"   # should grow
```

> **Honest note:** even we configured `CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` once and propagated it by hand. A `claude-mem server-beta init` that (a) checks PG/Redis, (b) starts the daemon, and (c) **prints the exact client snippet to paste** would remove ~all of the "how do I hello-world this" friction. That's the #1 onboarding win.

---

## 2. How it works (as we observe it)

```
Claude Code session
  └─ hooks (PostToolUse / Stop / SessionEnd …)
       └─ local worker in forwarding mode → POST /v1/events  (server-beta, :37877)
            └─ writes raw events to public.agent_events
            └─ creates observation_generation_jobs (gated by SESSION_POLICY)
                 └─ BullMQ queue in Redis (prefix claude_mem_37700)
                      └─ worker pulls job → LLM provider → parses <observation> XML
                           └─ INSERT public.observations (content, kind, embedding[384d], generation_key…)
                           └─ embedding synced to Qdrant
```

- **Two job types:** `observation_generate_for_event` (per tool event) and `observation_generate_session_summary` (per session). Queues: `server_beta_generate_event` / `server_beta_generate_summary`.
- **Generation prompt** is data-driven from `modes/code.json` (observation_types, observation_concepts, prompts) + a wrapper: *"You are observing an agent at work… return `<observation>` XML blocks or `<skip_summary/>`."* Output is **XML**, validated with zod after parse.
- **Storage:** `public.observations` = `content`(text) + `kind` + `embedding`(jsonb, 384-dim all-MiniLM) + `generation_key` + `created_by_job_id` + `metadata`.

---

## 3. Our production setup (the fleet)

- **Topology:** 1 server box (Postgres + Redis `db1` + Qdrant + the `server-beta` daemon on :37877); the other 2 boxes run Claude Code with `CLAUDE_MEM_RUNTIME=server-beta` → forwarding-only. All 3 share **one** backend.
- **Service:** systemd **user** service (`linger=yes`), entrypoint `start.cjs → runServerBetaCli(["--daemon"])`.
- **Migration path we took (not greenfield):** existing SQLite claude-mem → migrated rows into Postgres → flipped `CLAUDE_MEM_RUNTIME=server-beta` on clients → workers dropped into forwarding mode. The cutover was the riskiest part precisely because of the under-documented client handshake (§1).
- **Auth:** `local-dev` (trusted LAN). `CLAUDE_MEM_API_KEY` is set but not enforced in this mode.
- **Provider:** `claude-subscription` via OAuth (`CLAUDE_CODE_OAUTH_TOKEN`). The token **rotates**; a cron refreshes it — and the server env must be re-synced when the value changes (see §6, incident 2).

---

## 4. Config reference (vars that actually matter)

| Var | What it does | Our value / note |
|-----|--------------|------------------|
| `CLAUDE_MEM_QUEUE_ENGINE` | queue backend | `bullmq` |
| `CLAUDE_MEM_SERVER_DATABASE_URL` | Postgres DSN | (secret) — note: special chars in the password break naive URL parsers |
| `CLAUDE_MEM_REDIS_URL` | Redis DSN | `redis://localhost:6379/1` |
| `CLAUDE_MEM_SERVER_HOST` / `_PORT` | bind | `0.0.0.0` / `37877` |
| `CLAUDE_MEM_AUTH_MODE` | auth | `local-dev` |
| `CLAUDE_MEM_API_KEY` | server API key | (secret) |
| `CLAUDE_MEM_DATA_DIR` | data dir | `$HOME/.claude-mem` |
| `CLAUDE_MEM_MODES_DIR` | prompt templates | `<plugin>/modes` |
| `CLAUDE_MEM_SERVER_PROVIDER` | LLM provider | `claude-subscription` (also seen: google/gemini/groq/openrouter/openai/anthropic) |
| `CLAUDE_MEM_SERVER_MODEL` | model | `claude-haiku-4-5` (Sonnet didn't fit our volume — §6) |
| `CLAUDE_CODE_OAUTH_TOKEN` | subscription auth | (secret, rotates) |
| `BULLMQ_WORKER_CONCURRENCY` | worker concurrency | `3` — **note: hard-coded to 1 in the bundled service; we patch it to read this env** (May 19) |
| `CLAUDE_MEM_SERVER_SESSION_POLICY` | generation granularity | `end-of-session` — **default `per-event` is the volume bomb** (§6) |
| `CLAUDE_MEM_SERVER_SESSION_DEBOUNCE_MS` | debounce window | default `5000` (5s) — too small to coalesce |
| `CLAUDE_MEM_GENERATION_DISABLED` | HTTP-only mode | unset |
| **client:** `CLAUDE_MEM_RUNTIME` | enable forwarding | `server-beta` |
| **client:** `CLAUDE_MEM_SERVER_URL` | server endpoint | `http://<server>:37877` |

---

## 5. What's different for our team

- **One backend, 3 machines.** No more SQLite-per-box + merge/sync. This alone is the headline win.
- **Schema separation.** We keep a separate **business-memory** pipeline (domain analyses) in its own Postgres schema, fed by an independent injector — server-beta's `public` schema handles dev-session memory; the other schema handles business memory. Clean isolation in one DB.
- **We bolted on our own observability** — health-checks + alerting on queue depth, sync age, vector E2E, OAuth token expiry — because server-beta ships none (the thing that hurt us most, May 19).

---

## 6. Data & experience (operating under load)

**Volume.** Real dev usage on the fleet under the **default `per-event`** policy = **~3,500 generation jobs/day** (one LLM call per `tool_use`), the large majority trivial (`Read`/`Glob`/`Bash`) returning `<skip_summary/>`. We were paying an LLM call per tool call mostly to discard the result.

**Incidents:**
1. **Groq silent failure (~17.6k jobs / 1 week).** Free-tier throttling failed jobs with zero observability; memory injection silently stopped and we found out by accident. (May 19.)
2. **OAuth 401 storm.** The subscription access token rotates. Our refresh script only compared **expiry**, not the token **value** — so when the value rotated with time still on the clock, the server kept a dead token → 401 on *every* job. Fix: compare the value, re-sync into the server env, restart. (Worth a built-in: server should re-read the token on 401, not just on expiry.)
3. **Sonnet 429.** At ~3,500 jobs/day, `claude-subscription` on **Sonnet 4.6** blew the Max usage cap → 429 on ~100% of jobs (auth valid; pure rate-limit). **Haiku 4.5 fits; Sonnet doesn't, at this volume.**
4. **Root cause = the `per-event` default.** Switching `CLAUDE_MEM_SERVER_SESSION_POLICY=end-of-session` deferred generation to `session.end` → **~50x fewer LLM calls**, quota comfortable. This is the real fix; failover (below) is the safety net.

**Reprocessing failed jobs — the recovery recipe** (it bit us twice; undocumented):
```
1. PG:    UPDATE observation_generation_jobs
            SET status='queued', attempts=0, last_error=NULL, failed_at=NULL,
                locked_at=NULL, locked_by=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE status='failed';            -- 'pending' is REJECTED by the check constraint
2. Redis: remove the jobId  (BullMQ prefix is claude_mem_37700, NOT bull:)  — or obliterate the queue
3. addBulk: { name: job_type, data: payload, opts: { jobId: bullmq_job_id } }
            -- addBulk SILENTLY dedupes if jobId is still in Redis → hence the remove in step 2
4. restart the service (worker checks PG status before processing; 'queued' clears the terminal-status guard)
```
We keep a reusable `reprocess-failed.cjs` for this now. A built-in `claude-mem server-beta reprocess-failed` would save real pain.

**Metrics (so the suggestions aren't hand-wavy):**
- Lifetime: ~20k jobs completed, ~39k observations in Postgres.
- Per-event volume: ~3,000–6,500 jobs/day across the week.
- After `end-of-session`: generation tracks **session-close rate (~70/day)** instead of tool-call rate (~3,500/day). [Exact 24h before/after to follow.]
- Drain throughput on Haiku @ concurrency=3: ~1,700 jobs/hour observed while clearing a 7k backlog, no 429.

---

## 7. Consolidated recommendations

1. **Document the client→server handshake** (`CLAUDE_MEM_RUNTIME` + `CLAUDE_MEM_SERVER_URL` + auth) — the #1 onboarding blocker.
2. **Reconsider the `per-event` default** (or document its cost loudly); make `debounce`'s default window usable (>5s).
3. **Built-in observability:** `server-beta status`, queue-depth alerting, structured logs. (Biggest operational pain — May 19.)
4. **`reprocess-failed` subcommand** — recovery is fiddly and undocumented (recipe above).
5. **Multi-provider failover + circuit breaker** — one provider's rate-limit shouldn't take everything down (May 19).
6. **Terminal status for skipped jobs** — under `end-of-session`, per-event jobs are inserted then left `queued` forever (`shouldEnqueue:false`); same shape as the silent "stuck in queued" failures. A `skipped`/`cancelled` status fixes both + stops table bloat.
7. **Re-read OAuth token on 401**, not just on expiry (incident 2).

server-beta is a big step up from sync — these are "we operated it hard for 10 days" notes, not blockers. Happy to share more anonymized data.

---

## Addendum (2026-05-22) — `anthropic` API-key provider may leak `claude-code-20250219`

Tried to move off the OAuth `claude-subscription` provider onto a metered **`anthropic` API key** (`CLAUDE_MEM_SERVER_PROVIDER=anthropic`, `CLAUDE_MEM_ANTHROPIC_API_KEY`, model `claude-haiku-4-5-20251001`). Auth worked (no 401), but **~84% of generations failed** with what the server logs as `Anthropic bad request (400)`.

Ruled out: key valid (direct `/v1/messages` = 200), model valid (`/v1/models` lists `claude-haiku-4-5-20251001`), `max_tokens` (Haiku max 64000, we send less), input length (payloads avg ~6 KB).

**Likely cause:** the codebase hardcodes `claude-code-20250219` (the Claude Code internal model). Direct API test: `claude-haiku-4-5` → 200, but `claude-code-20250219` / `claude-3-5-sonnet-latest` / `claude-mem-context` → **404 `not_found_error`**. So a generation path under the `anthropic` provider seems to send `claude-code-20250219` (valid only on the subscription backend, 404 on the public API) instead of honoring `CLAUDE_MEM_SERVER_MODEL`. Caveat: the server reports it as `400`, but model-not-found is `404` — the error classification may be imprecise, and the server doesn't log the raw provider response (even at `LOG_LEVEL=debug`), so this isn't 100% confirmed.

**Asks:** (a) ensure the `anthropic` provider always uses `CLAUDE_MEM_SERVER_MODEL` (no `claude-code-*` leak); (b) surface the raw provider error body in logs/job `last_error` (right now every failure is an opaque "400"); (c) distinguish 400 vs 404 in the classification.

**Current setup:** stayed on `claude-subscription`, but switched model **Haiku → Sonnet 4.6** — with `SESSION_POLICY=end-of-session` the volume is low enough that **Sonnet now fits the quota at `concurrency=1` (0× 429)**. So end-of-session didn't just fix Haiku; it made Sonnet viable.
