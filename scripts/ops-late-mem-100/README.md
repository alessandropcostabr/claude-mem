# Operational scripts: LATE memory infra on `.100`

Auxiliary infrastructure scripts and units used in production for the LATE memory
agent topology where a dedicated PostgreSQL + Qdrant pair runs on the bot/agent
host (`.100`), separate from the claude-mem server-beta PG on the gateway host
(`.253`). See companion ADR in [`docs/`](../../docs/) (TBD).

## Contents

### `backup-late-mem.sh`
Daily backup of the LATE memory PostgreSQL database and the Qdrant collection
that holds OpenClaw agent memories. Writes timestamped artifacts to
`~/backups/late-mem/{pg,qdrant}/`, applies retention, and deletes the
intermediate Qdrant snapshot from the server's storage dir after download.

**Required env:** `PGPASSWORD`, `QDRANT_KEY` (no defaults shipped).
**Optional env:** `BACKUP_ROOT`, `RETENTION_DAYS`, `PG_*`, `QDRANT_*`.

Cron example (daily 04:30):
```cron
30 4 * * * PGPASSWORD=xxx QDRANT_KEY=yyy $HOME/clawd/scripts/backup-late-mem.sh \
           >> $HOME/clawd/logs/backup-late-mem.log 2>&1
```

### `check-late-mem.sh`
Standalone health check returning exit code 0/1/2 (OK/WARN/ERROR). Validates
that PostgreSQL `late.memories` row count and Qdrant collection point count
are at least at expected thresholds.

**Required env:** `PGPASSWORD`, `LATE_QDRANT_API_KEY`.
**Optional env:** `LATE_PG_HOST` (default `127.0.0.1`), `LATE_PG_MIN_ROWS`
(default `18000`), `LATE_QDRANT_HOST`, `LATE_QDRANT_MIN_POINTS` (default
`17000`), etc.

Designed to be invoked from a larger monitoring loop (cron + ntfy/Telegram).

### `claude-tg.service`
Systemd user unit that supervises the Claude Code Telegram channel bot in a
tmux session named `claude-tg`. Survives reboots when the user has linger
enabled (`sudo loginctl enable-linger $USER`).

Install: `cp claude-tg.service ~/.config/systemd/user/ && systemctl --user enable --now claude-tg.service`.

### `claude-patch-check`
Idempotent verification + auto-recovery for the Claude Code patcher. Detects
both native ELF installs (preferred) and legacy npm installs; when the active
Claude Code version doesn't match the last patched version, re-invokes
`~/.local/bin/claude-patch` automatically.

Designed to be invoked from a Claude Code SessionStart hook so post-upgrade
re-patching is automatic. Requires `claude-patch` to already exist in
`~/.local/bin/`.

## Conventions

- **No secrets shipped.** All sensitive values are read from environment variables.
- **Cron-safe.** Scripts use `set -u` and fail fast with `${VAR:?...}` when
  required environment is missing.
- **Idempotent.** Safe to re-run; retention purges on the way out instead of
  growing unbounded.
