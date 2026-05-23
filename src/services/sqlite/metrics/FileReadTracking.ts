/**
 * FileReadTracking — Context Enrichment Metrics (C4)
 *
 * Tracks whether Claude receives injected observation timelines when reading files.
 * Measures effective context enrichment rather than explicit tool opt-in.
 *
 * Table: file_read_tracking
 *   - migration 28: initial schema
 *   - migration 29 (2026-04-10): expand `action` semantics to distinguish
 *     auto-enrichment via PreToolUse hook from pure reads and explicit fetches
 *
 * Action semantics:
 *   - 'read'           — read issued, no observations available (baseline)
 *   - 'auto_enriched'  — read issued, PreToolUse hook injected observation timeline
 *                        via hookSpecificOutput.additionalContext (Claude saw the
 *                        timeline without needing a separate tool call)
 *   - 'explicit_fetch' — Claude called MCP get_observations after a read in the
 *                        same session on the same file (reserved; correlation
 *                        pipeline not yet implemented)
 *   - 'no_context'     — read issued, gate bypassed for structural reasons (file
 *                        below FILE_READ_GATE_MIN_BYTES, excluded project, etc.)
 *   - 'get_observations' / 'skipped' — legacy values kept for backward
 *                        compatibility with pre-migration-29 rows
 */

import { Database } from 'bun:sqlite';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TOKENS_PER_BYTE = 0.25;

export type FileReadAction =
  | 'read'
  | 'auto_enriched'
  | 'explicit_fetch'
  | 'no_context'
  | 'get_observations'
  | 'skipped';

export interface FileReadEvent {
  sessionId: string;
  filePath: string;
  hasObservations: boolean;
  observationCount: number;
  action: FileReadAction;
  fileSizeBytes?: number;
}

export interface ContextAcceptanceStats {
  totalReads: number;
  readsWithObservations: number;
  readsEnriched: number;
  acceptanceRate: number;
  tokensSavedEstimate: number;
  period: { sinceEpoch: number; untilEpoch: number };
}

export class FileReadTracking {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  trackFileRead(event: FileReadEvent): void {
    this.db.prepare(`
      INSERT INTO file_read_tracking
        (session_id, file_path, has_observations, observation_count, action, file_size_bytes, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.filePath,
      event.hasObservations ? 1 : 0,
      event.observationCount,
      event.action,
      event.fileSizeBytes ?? null,
      Date.now()
    );
  }

  getStats(sinceEpoch?: number): ContextAcceptanceStats {
    const since = sinceEpoch ?? (Date.now() - SEVEN_DAYS_MS);
    const now = Date.now();

    // Every row in file_read_tracking represents a read that was attempted.
    // "Enriched" means the PreToolUse hook injected an observation timeline
    // (auto_enriched) or Claude explicitly fetched observations afterwards
    // (explicit_fetch). Legacy 'get_observations' rows count toward enrichment
    // for backward compatibility with pre-migration-29 data.
    const totalReads = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ?
    `).get(since) as { cnt: number }).cnt;

    const readsWithObs = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ? AND has_observations = 1
    `).get(since) as { cnt: number }).cnt;

    const readsEnriched = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ?
        AND has_observations = 1
        AND action IN ('auto_enriched', 'explicit_fetch', 'get_observations')
    `).get(since) as { cnt: number }).cnt;

    // Acceptance = fraction of reads-with-observations that actually received
    // enrichment. Under migration 29 the PreToolUse hook emits 'auto_enriched'
    // for every qualifying read, so this rate converges to 1.0 once enough
    // fresh data accumulates. Legacy rows (action='read' with has_observations=1)
    // drag the rate down for ~7 days until the window rolls past them.
    const acceptanceRate = readsWithObs > 0 ? readsEnriched / readsWithObs : 0;

    // Estimate token savings: sum of file sizes on enriched reads (the hook
    // forces `limit:1` on those, so we read ~1 line instead of the full file).
    const savedBytes = (this.db.prepare(`
      SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM file_read_tracking
      WHERE created_at_epoch >= ?
        AND action = 'auto_enriched'
        AND file_size_bytes IS NOT NULL
    `).get(since) as { total: number }).total;

    return {
      totalReads,
      readsWithObservations: readsWithObs,
      readsEnriched,
      acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
      tokensSavedEstimate: Math.round(savedBytes * TOKENS_PER_BYTE),
      period: { sinceEpoch: since, untilEpoch: now },
    };
  }
}
