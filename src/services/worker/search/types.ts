/**
 * Search Types - Type definitions for the search module
 * Centralizes all search-related types, options, and result interfaces
 */

import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange } from '../../sqlite/types.js';

// Re-export base types for convenience
export type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange };

/**
 * Constants used across search strategies
 */
export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_DAYS: 90,
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,
  DEFAULT_LIMIT: 20,
  CHROMA_BATCH_SIZE: 100,
  /** Composite scoring weights (inspired by CrewAI memory/types.py:352-387) */
  SEMANTIC_WEIGHT: 0.5,
  RECENCY_WEIGHT: 0.3,
  IMPORTANCE_WEIGHT: 0.2,
  /** Half-life in days for recency decay: score halves every N days */
  RECENCY_HALF_LIFE_DAYS: 30,
  /** Minimum composite score to include in results (C2: score threshold) */
  SCORE_THRESHOLD: 0.15
} as const;

/**
 * Document types stored in Chroma
 */
export type ChromaDocType = 'observation' | 'session_summary' | 'user_prompt';

/**
 * Chroma query result with typed metadata
 */
export interface ChromaQueryResult {
  ids: number[];
  distances: number[];
  metadatas: ChromaMetadata[];
}

/**
 * Metadata stored with each Chroma document
 */
export interface ChromaMetadata {
  sqlite_id: number;
  doc_type: ChromaDocType;
  memory_session_id: string;
  project: string;
  created_at_epoch: number;
  type?: string;
  title?: string;
  subtitle?: string;
  concepts?: string;
  files_read?: string;
  files_modified?: string;
  field_type?: string;
  prompt_number?: number;
}

/**
 * Unified search result type for all document types
 */
export type SearchResult = ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;

/**
 * Search results container with categorized results
 */
export interface SearchResults {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: UserPromptSearchResult[];
}

/**
 * Extended search options for the search module
 */
export interface ExtendedSearchOptions extends SearchOptions {
  /** Type filter for search API (observations, sessions, prompts) */
  searchType?: 'observations' | 'sessions' | 'prompts' | 'all';
  /** Observation type filter (decision, bugfix, feature, etc.) */
  obsType?: string | string[];
  /** Concept tags to filter by */
  concepts?: string | string[];
  /** File paths to filter by */
  files?: string | string[];
  /** Output format */
  format?: 'text' | 'json';
}

/**
 * Search strategy selection hint
 */
export type SearchStrategyHint = 'chroma' | 'sqlite' | 'hybrid' | 'auto';

/**
 * Options passed to search strategies
 */
export interface StrategySearchOptions extends ExtendedSearchOptions {
  /** Query text for semantic search (optional for filter-only queries) */
  query?: string;
  /** Force a specific strategy */
  strategyHint?: SearchStrategyHint;
}

/**
 * Result from a search strategy
 */
export interface StrategySearchResult {
  results: SearchResults;
  /** Whether Chroma was used successfully */
  usedChroma: boolean;
  /** Whether fallback was triggered */
  fellBack: boolean;
  /** Strategy that produced the results */
  strategy: SearchStrategyHint;
  /** Top composite score from results (0-1), used for confidence routing (C3) */
  topScore?: number;
}

/**
 * Combined result type for timeline items
 */
export interface CombinedResult {
  type: 'observation' | 'session' | 'prompt';
  data: SearchResult;
  epoch: number;
  created_at: string;
}
