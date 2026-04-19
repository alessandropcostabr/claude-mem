/**
 * VectorBackend — shared interface for vector search backends (Chroma, Qdrant).
 *
 * Consumers (DatabaseManager, SearchOrchestrator, strategies) depend on this
 * interface instead of concrete implementations, minimising upstream diff
 * and enabling runtime backend switching via CLAUDE_MEM_VECTOR_BACKEND.
 */

export interface VectorQueryResult {
  /** Deduplicated SQLite observation/summary IDs */
  ids: number[];
  /** Distance scores (0 = perfect, higher = worse) — Qdrant scores are converted */
  distances: number[];
  /** Raw metadata objects from the vector store */
  metadatas: any[];
}

export interface VectorBackend {
  /** Sync a single observation to the vector store (fire-and-forget safe) */
  syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: any,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;

  /** Sync a single session summary */
  syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: any,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;

  /** Sync a single user prompt */
  syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void>;

  /** Semantic search — returns deduplicated SQLite IDs sorted by relevance */
  queryVector(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<VectorQueryResult>;

  /** Backfill missing documents from SQLite into the vector store */
  ensureBackfilled(projectOverride?: string): Promise<void>;

  /** Graceful shutdown */
  close(): Promise<void>;
}
