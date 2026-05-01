/**
 * Session Completion Handler
 *
 * Consolidates session completion logic for manual session deletion/completion.
 * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete endpoints.
 *
 * Completion flow (normal):
 * 1. Delete session from SessionManager (aborts SDK agent, cleans up in-memory state)
 * 2. Drain orphaned pending messages (marked abandoned since generator was killed)
 * 3. Broadcast session completed event (updates UI spinner)
 *
 * Completion flow (soft — reason=clear):
 * 1. Mark session completed in DB
 * 2. Remove from active sessions map WITHOUT aborting the generator
 * 3. Generator drains pending queue naturally, then exits
 * 4. Broadcast session completed event
 */

import { SessionManager } from '../SessionManager.js';
import { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { DatabaseManager } from '../DatabaseManager.js';
import { logger } from '../../../utils/logger.js';

export class SessionCompletionHandler {
  constructor(
    private sessionManager: SessionManager,
    private eventBroadcaster: SessionEventBroadcaster,
    private dbManager: DatabaseManager
  ) {}

  /**
   * Complete session by database ID
   * Used by DELETE /api/sessions/:id and POST /api/sessions/:id/complete
   *
   * @param options.abortGenerator - When false (e.g. SessionEnd reason=clear), the generator
   *   is NOT aborted and pending messages are NOT drained. The generator will finish
   *   processing the queue naturally before exiting. This preserves observations that
   *   were queued before /clear but not yet written to the database.
   *   Port of upstream v12.4.4 fix.
   */
  async completeByDbId(sessionDbId: number, options?: { abortGenerator?: boolean }): Promise<void> {
    const abortGenerator = options?.abortGenerator ?? true;

    // Persist completion to database before in-memory cleanup (fix for #1532)
    this.dbManager.getSessionStore().markSessionCompleted(sessionDbId);

    if (abortGenerator) {
      // Delete from session manager (aborts SDK agent via SIGTERM)
      await this.sessionManager.deleteSession(sessionDbId);

      // Drain orphaned pending messages left by SIGTERM.
      // When deleteSession() aborts the generator, pending messages in the queue
      // are never processed. Without drain, they stay in 'pending' status forever
      // since no future generator will pick them up for a completed session.
      // Note: this is best-effort — if a generator outlives the 30s SIGTERM timeout
      // (SessionManager.deleteSession), it may enqueue messages after this drain.
      // In practice this race is rare (zero orphans over 23 days, 3400+ observations).
      try {
        const pendingStore = this.sessionManager.getPendingMessageStore();
        const drainedCount = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
        if (drainedCount > 0) {
          logger.warn('SESSION', `Drained ${drainedCount} orphaned pending messages on session completion`, {
            sessionId: sessionDbId, drainedCount
          });
        }
      } catch (e) {
        logger.debug('SESSION', 'Failed to drain pending queue on session completion', {
          sessionId: sessionDbId, error: e instanceof Error ? e.message : String(e)
        });
      }
    } else {
      // Soft completion: remove session from active map without aborting the generator.
      // The generator will drain the pending queue naturally, then exit on its own.
      this.sessionManager.removeSessionImmediate(sessionDbId);
      logger.info('SESSION', 'Session soft-completed (generator left running to drain queue)', {
        sessionId: sessionDbId
      });
    }

    // Broadcast session completed event
    this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
  }
}
