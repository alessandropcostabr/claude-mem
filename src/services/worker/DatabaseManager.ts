/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { VectorSync } from '../sync/VectorSync.js';
import { QdrantClient } from '../sync/QdrantClient.js';
import type { VectorBackend } from '../sync/VectorBackend.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private vectorSync: VectorBackend | null = null;

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Initialize vector backend based on settings
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const backend = (settings as any).CLAUDE_MEM_VECTOR_BACKEND || 'chroma';
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';

    if (backend === 'qdrant') {
      const host = (settings as any).CLAUDE_MEM_QDRANT_HOST || '127.0.0.1';
      const port = (settings as any).CLAUDE_MEM_QDRANT_PORT || '6333';
      const apiKey = (settings as any).CLAUDE_MEM_QDRANT_API_KEY || '';
      const embedHost = (settings as any).CLAUDE_MEM_EMBED_HOST || '127.0.0.1:11436';
      const qdrant = new QdrantClient(host, port, apiKey);
      this.vectorSync = new VectorSync('claude-mem', qdrant, embedHost);
      logger.info('DB', 'Vector backend: Qdrant', { host, port });
    } else if (backend === 'chroma' && chromaEnabled) {
      this.vectorSync = new ChromaSync('claude-mem') as any;
      logger.info('DB', 'Vector backend: Chroma');
    } else {
      logger.info('DB', 'Vector search disabled, using SQLite-only (FTS5)');
    }

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close vector backend
    if (this.vectorSync) {
      await this.vectorSync.close();
      this.vectorSync = null;
    }

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get vector sync backend (returns null if vector search is disabled)
   * Alias getChromaSync() maintained for consumer compatibility
   */
  getChromaSync(): VectorBackend | null {
    return this.vectorSync;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
