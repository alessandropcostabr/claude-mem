/**
 * ChromaSearchStrategy - Vector-based semantic search via Chroma
 *
 * This strategy handles semantic search queries using ChromaDB:
 * 1. Query Chroma for semantically similar documents
 * 2. Filter by recency (90-day window)
 * 3. Categorize by document type
 * 4. Hydrate from SQLite
 *
 * Used when: Query text is provided and Chroma is available
 */

import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ChromaMetadata,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { logger } from '../../../../utils/logger.js';

export class ChromaSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'chroma';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    // Can handle when query text is provided and Chroma is available
    return !!options.query && !!this.chromaSync;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      query,
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      project,
      orderBy = 'date_desc'
    } = options;

    if (!query) {
      return this.emptyResult('chroma');
    }

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    try {
      // Build Chroma where filter for doc_type and project
      const whereFilter = this.buildWhereFilter(searchType, project);

      // Step 1: Chroma semantic search
      logger.debug('SEARCH', 'ChromaSearchStrategy: Querying Chroma', { query, searchType });
      const chromaResults = await this.chromaSync.queryChroma(
        query,
        SEARCH_CONSTANTS.CHROMA_BATCH_SIZE,
        whereFilter
      );

      logger.debug('SEARCH', 'ChromaSearchStrategy: Chroma returned matches', {
        matchCount: chromaResults.ids.length
      });

      if (chromaResults.ids.length === 0) {
        // No matches - this is the correct answer
        return {
          results: { observations: [], sessions: [], prompts: [] },
          usedChroma: true,
          fellBack: false,
          strategy: 'chroma'
        };
      }

      // Step 2: Composite scoring (semantic + recency decay + threshold)
      // Pattern C1+C2 from competitive analysis: CrewAI memory/types.py:352-387
      const scoredItems = this.scoreAndFilter(chromaResults);
      logger.debug('SEARCH', 'ChromaSearchStrategy: Scored and filtered', {
        count: scoredItems.length
      });

      // Step 3: Categorize by document type
      const categorized = this.categorizeByDocType(scoredItems, {
        searchObservations,
        searchSessions,
        searchPrompts
      });

      // Step 4: Hydrate from SQLite with additional filters
      if (categorized.obsIds.length > 0) {
        const obsOptions = { type: obsType, concepts, files, orderBy, limit, project };
        observations = this.sessionStore.getObservationsByIds(categorized.obsIds, obsOptions);
      }

      if (categorized.sessionIds.length > 0) {
        sessions = this.sessionStore.getSessionSummariesByIds(categorized.sessionIds, {
          orderBy,
          limit,
          project
        });
      }

      if (categorized.promptIds.length > 0) {
        prompts = this.sessionStore.getUserPromptsByIds(categorized.promptIds, {
          orderBy,
          limit,
          project
        });
      }

      logger.debug('SEARCH', 'ChromaSearchStrategy: Hydrated results', {
        observations: observations.length,
        sessions: sessions.length,
        prompts: prompts.length
      });

      return {
        results: { observations, sessions, prompts },
        usedChroma: true,
        fellBack: false,
        strategy: 'chroma'
      };

    } catch (error) {
      logger.error('SEARCH', 'ChromaSearchStrategy: Search failed', {}, error as Error);
      // Return empty result - caller may try fallback strategy
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: false,
        strategy: 'chroma'
      };
    }
  }

  /**
   * Build Chroma where filter for document type and project
   *
   * When a project is specified, includes it in the ChromaDB where clause
   * so that vector search is scoped to the target project. Without this,
   * larger projects dominate the top-N results and smaller projects get
   * crowded out before the post-hoc SQLite project filter can take effect.
   */
  private buildWhereFilter(searchType: string, project?: string): Record<string, any> | undefined {
    let docTypeFilter: Record<string, any> | undefined;
    switch (searchType) {
      case 'observations':
        docTypeFilter = { doc_type: 'observation' };
        break;
      case 'sessions':
        docTypeFilter = { doc_type: 'session_summary' };
        break;
      case 'prompts':
        docTypeFilter = { doc_type: 'user_prompt' };
        break;
      default:
        docTypeFilter = undefined;
    }

    if (project) {
      const projectFilter = { project };
      if (docTypeFilter) {
        return { $and: [docTypeFilter, projectFilter] };
      }
      return projectFilter;
    }

    return docTypeFilter;
  }

  /**
   * Composite scoring: semantic similarity + recency decay + score threshold.
   *
   * Replaces the old hard 90-day cutoff with a graduated decay model.
   * Pattern from CrewAI memory/types.py:352-387 (competitive analysis 2026-04-16).
   *
   * composite = semantic_weight * similarity + recency_weight * decay
   * where: similarity = 1 - distance (Chroma returns L2 distances)
   *        decay = 0.5 ^ (age_days / half_life_days)
   *
   * IMPORTANT: ChromaSync.queryChroma() returns deduplicated `ids` (unique sqlite_ids)
   * but the `metadatas` array may contain multiple entries per sqlite_id.
   * This method uses the deduplicated `ids` and maps to first metadata per ID.
   */
  private scoreAndFilter(chromaResults: {
    ids: number[];
    distances: number[];
    metadatas: ChromaMetadata[];
  }): Array<{ id: number; meta: ChromaMetadata; compositeScore: number }> {
    const {
      SEMANTIC_WEIGHT,
      RECENCY_WEIGHT,
      RECENCY_HALF_LIFE_DAYS,
      SCORE_THRESHOLD
    } = SEARCH_CONSTANTS;

    const now = Date.now();

    // Build maps from sqlite_id to first metadata and best distance
    const metadataByIdMap = new Map<number, ChromaMetadata>();
    const distanceByIdMap = new Map<number, number>();

    for (const meta of chromaResults.metadatas) {
      if (meta?.sqlite_id !== undefined && !metadataByIdMap.has(meta.sqlite_id)) {
        metadataByIdMap.set(meta.sqlite_id, meta);
      }
    }

    // distances array is aligned with ids (both deduplicated by queryChroma)
    for (let i = 0; i < chromaResults.ids.length; i++) {
      distanceByIdMap.set(chromaResults.ids[i], chromaResults.distances[i] ?? 0);
    }

    return chromaResults.ids
      .map(id => {
        const meta = metadataByIdMap.get(id) as ChromaMetadata;
        const distance = distanceByIdMap.get(id) ?? 0;

        // Chroma L2 distance → similarity [0,1] (clamped)
        const similarity = Math.max(0, Math.min(1, 1 - distance));

        // Exponential recency decay: halves every HALF_LIFE days
        const ageDays = meta
          ? Math.max(0, (now - meta.created_at_epoch) / 86_400_000)
          : 999;
        const decay = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

        const compositeScore =
          SEMANTIC_WEIGHT * similarity +
          RECENCY_WEIGHT * decay;

        return { id, meta, compositeScore };
      })
      .filter(item => item.meta && item.compositeScore >= SCORE_THRESHOLD)
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * Categorize IDs by document type
   */
  private categorizeByDocType(
    items: Array<{ id: number; meta: ChromaMetadata }>,
    options: {
      searchObservations: boolean;
      searchSessions: boolean;
      searchPrompts: boolean;
    }
  ): { obsIds: number[]; sessionIds: number[]; promptIds: number[] } {
    const obsIds: number[] = [];
    const sessionIds: number[] = [];
    const promptIds: number[] = [];

    for (const item of items) {
      const docType = item.meta?.doc_type;
      if (docType === 'observation' && options.searchObservations) {
        obsIds.push(item.id);
      } else if (docType === 'session_summary' && options.searchSessions) {
        sessionIds.push(item.id);
      } else if (docType === 'user_prompt' && options.searchPrompts) {
        promptIds.push(item.id);
      }
    }

    return { obsIds, sessionIds, promptIds };
  }
}
