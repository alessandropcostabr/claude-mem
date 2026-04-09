/**
 * FileReadTracking — Context Acceptance Metrics (C4)
 *
 * Tracks when Claude reads files vs using stored observations.
 * Measures whether injected context is accepted or ignored.
 *
 * Table: file_read_tracking (migration 25 in runner.ts)
 * Actions: 'read' (direct file access), 'get_observations' (used stored context), 'skipped'
 */

import { Database } from 'bun:sqlite';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TOKENS_PER_BYTE = 0.25;

export interface FileReadEvent {
  sessionId: string;
  filePath: string;
  hasObservations: boolean;
  observationCount: number;
  action: 'read' | 'get_observations' | 'skipped';
  fileSizeBytes?: number;
}

export interface ContextAcceptanceStats {
  totalReads: number;
  readsWithObservations: number;
  readsUsingObservations: number;
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

    const totalReads = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ? AND action = 'read'
    `).get(since) as { cnt: number }).cnt;

    const readsWithObs = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ? AND action = 'read' AND has_observations = 1
    `).get(since) as { cnt: number }).cnt;

    const obsUsed = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM file_read_tracking
      WHERE created_at_epoch >= ? AND action = 'get_observations'
    `).get(since) as { cnt: number }).cnt;

    const denominator = readsWithObs + obsUsed;
    const acceptanceRate = denominator > 0 ? obsUsed / denominator : 0;

    // Estimate token savings: sum of file sizes where get_observations was used instead of read
    const savedBytes = (this.db.prepare(`
      SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM file_read_tracking
      WHERE created_at_epoch >= ? AND action = 'get_observations' AND file_size_bytes IS NOT NULL
    `).get(since) as { total: number }).total;

    return {
      totalReads,
      readsWithObservations: readsWithObs,
      readsUsingObservations: obsUsed,
      acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
      tokensSavedEstimate: Math.round(savedBytes * TOKENS_PER_BYTE),
      period: { sinceEpoch: since, untilEpoch: now },
    };
  }
}
