/**
 * VectorSync — Qdrant-backed vector sync implementation.
 *
 * Drop-in replacement for ChromaSync. Implements VectorBackend interface.
 * Uses QdrantClient (HTTP) + FastEmbed embedding server — zero subprocesses.
 *
 * Key differences from ChromaSync:
 * - HTTP REST instead of MCP stdio (no subprocess zombies)
 * - External embedding via FastEmbed server (not bundled in chroma-mcp)
 * - Qdrant returns cosine similarity scores (0–1, higher=better);
 *   queryVector() converts to distances (1-score) for consumer compatibility
 * - Point IDs are numeric (Qdrant uint64) using a hash of the string doc ID
 */

import { QdrantClient } from './QdrantClient.js';
import { logger } from '../../utils/logger.js';
import type { VectorBackend, VectorQueryResult } from './VectorBackend.js';

// ── Types (mirror ChromaSync's internal types) ──────────────────────

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string;
  subtitle: string;
  facts: string;
  narrative: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface VectorDocument {
  stringId: string;
  document: string;
  metadata: Record<string, string | number>;
}

// ── Helpers ─────────────────────────────────────────────────────────

const BATCH_SIZE = 100;
const EMBED_TIMEOUT_MS = 300_000; // 5min — backfill batches can be large

function parseFileList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic numeric ID from string (for Qdrant uint64 point IDs).
 * Uses FNV-1a 32-bit hash — fast, low collision for our ID patterns.
 */
function stringToPointId(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ── VectorSync ──────────────────────────────────────────────────────

export class VectorSync implements VectorBackend {
  private project: string;
  private collectionName: string;
  private qdrant: QdrantClient;
  private embedHost: string;
  private collectionCreated: boolean = false;
  private vectorSize: number = 384; // bge-small-en-v1.5 default

  constructor(
    project: string,
    qdrant: QdrantClient,
    embedHost: string = '127.0.0.1:11436'
  ) {
    this.project = project;
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');
    this.collectionName = `cm__${sanitized || 'unknown'}`;
    this.qdrant = qdrant;
    this.embedHost = embedHost;
  }

  // ── Embedding ───────────────────────────────────────────────────

  private async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    try {
      const response = await fetch(`http://${this.embedHost}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Embed server error: ${response.status}`);
      }

      const data = await response.json() as { embeddings: number[][]; dimensions: number };
      this.vectorSize = data.dimensions;
      return data.embeddings;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Embedding timed out after ${EMBED_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Collection ──────────────────────────────────────────────────

  private async ensureCollectionExists(): Promise<void> {
    if (this.collectionCreated) return;

    await this.qdrant.createCollection(this.collectionName, this.vectorSize);
    this.collectionCreated = true;
  }

  // ── Document formatting (mirrors ChromaSync) ────────────────────

  private formatObservationDocs(obs: StoredObservation): VectorDocument[] {
    const documents: VectorDocument[] = [];

    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const filesRead = parseFileList(obs.files_read);
    const filesModified = parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled',
    };

    if (obs.subtitle) baseMetadata.subtitle = obs.subtitle;
    if (concepts.length > 0) baseMetadata.concepts = concepts.join(',');
    if (filesRead.length > 0) baseMetadata.files_read = filesRead.join(',');
    if (filesModified.length > 0) baseMetadata.files_modified = filesModified.join(',');

    if (obs.narrative) {
      documents.push({
        stringId: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' },
      });
    }

    if (obs.text) {
      documents.push({
        stringId: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' },
      });
    }

    facts.forEach((fact: string, index: number) => {
      documents.push({
        stringId: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index },
      });
    });

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): VectorDocument[] {
    const documents: VectorDocument[] = [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0,
    };

    const fields: Array<[string, string | null]> = [
      ['request', summary.request],
      ['investigated', summary.investigated],
      ['learned', summary.learned],
      ['completed', summary.completed],
      ['next_steps', summary.next_steps],
      ['notes', summary.notes],
    ];

    for (const [fieldType, value] of fields) {
      if (value) {
        documents.push({
          stringId: `summary_${summary.id}_${fieldType}`,
          document: value,
          metadata: { ...baseMetadata, field_type: fieldType },
        });
      }
    }

    return documents;
  }

  // ── Add documents (embed + upsert) ──────────────────────────────

  private async addDocuments(docs: VectorDocument[]): Promise<void> {
    if (docs.length === 0) return;

    await this.ensureCollectionExists();

    // Embed in small batches to avoid OOM on CPU (FastEmbed ONNX)
    const EMBED_BATCH = 20;
    const allPoints: Array<{ id: number; vector: number[]; payload: Record<string, any> }> = [];

    for (let i = 0; i < docs.length; i += EMBED_BATCH) {
      const batch = docs.slice(i, i + EMBED_BATCH);
      const texts = batch.map(d => d.document);
      const embeddings = await this.embed(texts);

      for (let j = 0; j < batch.length; j++) {
        allPoints.push({
          id: stringToPointId(batch[j].stringId),
          vector: embeddings[j],
          payload: {
            ...batch[j].metadata,
            _string_id: batch[j].stringId,
          },
        });
      }
    }

    await this.qdrant.upsertPoints(this.collectionName, allPoints);
  }

  // ── Public API (VectorBackend) ──────────────────────────────────

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: any,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project,
      text: null,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts || []),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch,
    };

    const documents = this.formatObservationDocs(stored);

    logger.info('VECTOR_SYNC', 'Syncing observation', {
      observationId,
      documentCount: documents.length,
      project,
    });

    await this.addDocuments(documents);
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: any,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project,
      request: summary.request || '',
      investigated: summary.investigated || '',
      learned: summary.learned || '',
      completed: summary.completed || '',
      next_steps: summary.next_steps || '',
      notes: summary.notes || '',
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch,
    };

    const documents = this.formatSummaryDocs(stored);

    logger.info('VECTOR_SYNC', 'Syncing summary', {
      summaryId,
      documentCount: documents.length,
      project,
    });

    await this.addDocuments(documents);
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    const doc: VectorDocument = {
      stringId: `prompt_${promptId}`,
      document: promptText,
      metadata: {
        sqlite_id: promptId,
        doc_type: 'user_prompt',
        memory_session_id: memorySessionId,
        project,
        created_at_epoch: createdAtEpoch,
        prompt_number: promptNumber,
      },
    };

    logger.info('VECTOR_SYNC', 'Syncing user prompt', { promptId, project });

    await this.addDocuments([doc]);
  }

  /**
   * Translate a Chroma-style whereFilter ($and/$or/$eq) to Qdrant filter format.
   * Handles: simple key-value, $and compound, $or compound, $eq value wrapper.
   */
  private translateWhereFilter(filter: Record<string, any>): any {
    if ('$and' in filter) {
      return { must: (filter.$and as any[]).map(f => this.translateWhereFilter(f)) };
    }
    if ('$or' in filter) {
      return { should: (filter.$or as any[]).map(f => this.translateWhereFilter(f)) };
    }
    const conditions = Object.entries(filter).map(([key, value]) => {
      const matchValue =
        typeof value === 'object' && value !== null && '$eq' in value ? value.$eq : value;
      return { key, match: { value: matchValue } };
    });
    return conditions.length === 1 ? conditions[0] : { must: conditions };
  }

  async queryVector(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<VectorQueryResult> {
    await this.ensureCollectionExists();

    try {
      // Embed the query
      const [queryVector] = await this.embed([query]);

      // Build Qdrant filter from whereFilter (supports $and/$or Chroma-style operators)
      const filter = whereFilter ? this.translateWhereFilter(whereFilter) : undefined;

      const results = await this.qdrant.searchPoints(
        this.collectionName,
        queryVector,
        limit * 3, // fetch more to allow dedup (multiple docs per sqlite_id)
        filter
      );

      // Deduplicate by sqlite_id (same logic as ChromaSync.queryChroma)
      const ids: number[] = [];
      const distances: number[] = [];
      const metadatas: any[] = [];
      const seen = new Set<number>();

      for (const hit of results) {
        const sqliteId = hit.payload?.sqlite_id as number;
        if (sqliteId && !seen.has(sqliteId)) {
          seen.add(sqliteId);
          ids.push(sqliteId);
          distances.push(1 - hit.score); // convert score→distance for compatibility
          metadatas.push(hit.payload);

          if (ids.length >= limit) break;
        }
      }

      return { ids, distances, metadatas };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('fetch failed') ||
        errorMessage.includes('timed out');

      if (isConnectionError) {
        this.collectionCreated = false;
        logger.error('VECTOR_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Qdrant query failed - connection lost: ${errorMessage}`);
      }

      logger.error('VECTOR_SYNC', 'Query failed',
        { project: this.project, query }, error as Error);
      throw error;
    }
  }

  async ensureBackfilled(projectOverride?: string): Promise<void> {
    const targetProject = projectOverride ?? this.project;
    await this.ensureCollectionExists();

    logger.info('VECTOR_SYNC', 'Starting backfill', { project: targetProject });

    // Get existing point IDs from Qdrant
    // We scroll all points and extract sqlite_id + doc_type from payload
    const existingObs = new Set<number>();
    const existingSummaries = new Set<number>();
    const existingPrompts = new Set<number>();

    try {
      const info = await this.qdrant.getCollectionInfo(this.collectionName);
      if (info.pointsCount > 0) {
        logger.info('VECTOR_SYNC', `Collection has ${info.pointsCount} points, scanning for existing IDs`);
        // For large collections, we skip full scan and just sync missing
        // The upsert is idempotent — duplicates overwrite harmlessly
      }
    } catch {
      // Collection may not exist yet — ensureCollectionExists handles it
    }

    // Query SQLite for observations missing from Qdrant
    const { Database } = await import('bun:sqlite');
    const path = await import('path');
    const os = await import('os');
    const dbPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
    const db = new Database(dbPath, { readonly: true });

    try {
      // Backfill observations
      const observations = db.query(`
        SELECT id, memory_session_id, project, text, type, title, subtitle,
               facts, narrative, concepts, files_read, files_modified,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM observations
        WHERE project = ? AND status = 'active'
        ORDER BY created_at_epoch ASC
      `).all(targetProject) as StoredObservation[];

      logger.info('VECTOR_SYNC', `Backfilling ${observations.length} observations`, { project: targetProject });

      // Process in batches
      for (let i = 0; i < observations.length; i += BATCH_SIZE) {
        const batch = observations.slice(i, i + BATCH_SIZE);
        const allDocs: VectorDocument[] = [];
        for (const obs of batch) {
          allDocs.push(...this.formatObservationDocs(obs));
        }
        if (allDocs.length > 0) {
          await this.addDocuments(allDocs);
        }
        logger.debug('VECTOR_SYNC', `Backfill batch ${i}-${i + batch.length}`, { project: targetProject });
      }

      // Backfill summaries
      const summaries = db.query(`
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, notes, prompt_number, discovery_tokens,
               created_at, created_at_epoch
        FROM session_summaries
        WHERE project = ?
        ORDER BY created_at_epoch ASC
      `).all(targetProject) as StoredSummary[];

      logger.info('VECTOR_SYNC', `Backfilling ${summaries.length} summaries`, { project: targetProject });

      for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
        const batch = summaries.slice(i, i + BATCH_SIZE);
        const allDocs: VectorDocument[] = [];
        for (const s of batch) {
          allDocs.push(...this.formatSummaryDocs(s));
        }
        if (allDocs.length > 0) {
          await this.addDocuments(allDocs);
        }
      }

      logger.info('VECTOR_SYNC', 'Backfill complete', {
        project: targetProject,
        observations: observations.length,
        summaries: summaries.length,
      });
    } finally {
      db.close();
    }
  }

  /**
   * Backfill all projects — static method matching ChromaSync.backfillAllProjects()
   */
  static async backfillAllProjects(
    qdrant: QdrantClient,
    embedHost: string
  ): Promise<void> {
    const { Database } = await import('bun:sqlite');
    const path = await import('path');
    const os = await import('os');
    const dbPath = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
    const db = new Database(dbPath, { readonly: true });

    try {
      const projects = db.query(
        'SELECT DISTINCT project FROM observations WHERE status = "active" AND project != ""'
      ).all() as Array<{ project: string }>;

      logger.info('VECTOR_SYNC', `Backfilling ${projects.length} projects`);

      const sync = new VectorSync('claude-mem', qdrant, embedHost);

      for (const { project } of projects) {
        try {
          await sync.ensureBackfilled(project);
        } catch (error) {
          logger.error('VECTOR_SYNC', `Backfill failed for project: ${project}`,
            {}, error as Error);
        }
      }

      logger.info('VECTOR_SYNC', 'Backfill check complete for all projects');
    } finally {
      db.close();
    }
  }

  async close(): Promise<void> {
    await this.qdrant.close();
    logger.info('VECTOR_SYNC', 'Closed');
  }
}
