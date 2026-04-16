/**
 * SearchOrchestrator - Coordinates search strategies and handles fallback logic
 *
 * This is the main entry point for search operations. It:
 * 1. Normalizes input parameters
 * 2. Selects the appropriate strategy
 * 3. Executes the search
 * 4. Handles fallbacks on failure
 * 5. Delegates to formatters for output
 */

import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
import { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';

import { ResultFormatter } from './ResultFormatter.js';
import { TimelineBuilder } from './TimelineBuilder.js';
import type { TimelineItem, TimelineData } from './TimelineBuilder.js';

import {
  SEARCH_CONSTANTS,
} from './types.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  SearchResults,
  ObservationSearchResult
} from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Normalized parameters from URL-friendly format
 */
interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private chromaStrategy: ChromaSearchStrategy | null = null;
  private sqliteStrategy: SQLiteSearchStrategy;
  private hybridStrategy: HybridSearchStrategy | null = null;
  private resultFormatter: ResultFormatter;
  private timelineBuilder: TimelineBuilder;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null
  ) {
    // Initialize strategies
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }

    this.resultFormatter = new ResultFormatter();
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    // Decision tree for strategy selection
    return await this.executeWithFallback(options);
  }

  /** Confidence thresholds for adaptive depth routing (C3) */
  private static readonly CONFIDENCE_HIGH = 0.45;
  private static readonly CONFIDENCE_LOW = 0.25;

  /**
   * Execute search with fallback logic and adaptive depth routing.
   *
   * C3 pattern from CrewAI recall_flow.py:286-356:
   * - High confidence (>= 0.45): return immediately
   * - Low confidence (< 0.25): broaden search (remove project filter, increase limit)
   * - Medium: return as-is
   */
  private async executeWithFallback(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    // PATH 1: FILTER-ONLY (no query text) - Use SQLite
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    // PATH 2: CHROMA SEMANTIC SEARCH (query text + Chroma available)
    if (this.chromaStrategy) {
      logger.debug('SEARCH', 'Orchestrator: Using Chroma semantic search', {});
      const result = await this.chromaStrategy.search(options);

      // If Chroma failed entirely, fall back to SQLite
      if (!result.usedChroma) {
        logger.debug('SEARCH', 'Orchestrator: Chroma failed, falling back to SQLite', {});
        const fallbackResult = await this.sqliteStrategy.search({
          ...options,
          query: undefined
        });
        return { ...fallbackResult, fellBack: true };
      }

      // Adaptive depth routing based on confidence (topScore)
      const confidence = result.topScore ?? 0;

      if (confidence >= SearchOrchestrator.CONFIDENCE_HIGH) {
        // High confidence: return immediately
        logger.debug('SEARCH', 'Orchestrator: High confidence, returning', {
          confidence: confidence.toFixed(3)
        });
        return result;
      }

      if (confidence < SearchOrchestrator.CONFIDENCE_LOW && options.project) {
        // Low confidence + project-scoped: retry without project filter
        logger.debug('SEARCH', 'Orchestrator: Low confidence, broadening search', {
          confidence: confidence.toFixed(3),
          removingProjectFilter: options.project
        });
        const broadResult = await this.chromaStrategy.search({
          ...options,
          project: undefined,
          limit: Math.min((options.limit || SEARCH_CONSTANTS.DEFAULT_LIMIT) * 2, 50)
        });

        if (broadResult.usedChroma) {
          const broadConfidence = broadResult.topScore ?? 0;
          // Use broader results if they're better
          if (broadConfidence > confidence) {
            return { ...broadResult, fellBack: true };
          }
        }
      }

      // Medium confidence or broadening didn't help: return original
      return result;
    }

    // PATH 3: No Chroma available
    logger.debug('SEARCH', 'Orchestrator: Chroma not available', {});
    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by concept with hybrid search
   */
  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByConcept(concept, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by type with hybrid search
   */
  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByType(type, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by file with hybrid search
   */
  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByFile(filePath, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByFile(filePath, options);
    return { ...results, usedChroma: false };
  }

  /**
   * Get timeline around anchor
   */
  getTimeline(
    timelineData: TimelineData,
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    const items = this.timelineBuilder.buildTimeline(timelineData);
    return this.timelineBuilder.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);
  }

  /**
   * Format timeline for display
   */
  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: {
      query?: string;
      depthBefore?: number;
      depthAfter?: number;
    } = {}
  ): string {
    return this.timelineBuilder.formatTimeline(items, anchorId, options);
  }

  /**
   * Format search results for display
   */
  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, chromaFailed);
  }

  /**
   * Get result formatter for direct access
   */
  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  /**
   * Get timeline builder for direct access
   */
  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Map 'type' param to 'searchType' for API consistency
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }

  /**
   * Check if Chroma is available
   */
  isChromaAvailable(): boolean {
    return !!this.chromaSync;
  }
}
