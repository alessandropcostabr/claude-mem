/**
 * HybridScorer — Phase 8: Multi-dimensional observation scoring
 *
 * Combines 4 normalized dimensions [0,1] into a single score:
 *   semantic × W_sem + recency × W_rec + authority × W_auth + coherence × W_coh
 *
 * Used by HybridSearchStrategy (search ranking) and file-context (injection ranking).
 */

import { logger } from '../../utils/logger.js';

export interface ScoringWeights {
  semantic: number;
  recency: number;
  authority: number;
  coherence: number;
}

export interface ScoringDimensions {
  /** Chroma distance (0 = perfect match, higher = worse). Normalized internally. */
  chromaDistance?: number;
  /** FTS5 rank (lower = better). Used when Chroma unavailable. */
  ftsRank?: number;
  /** Observation created_at_epoch (ms) */
  createdAtEpoch: number;
  /** relevance_count from observation_feedback hits */
  relevanceCount: number;
  /** correctness field: 'confirmed' | 'unverified' */
  correctness: string;
  /** Project of the observation */
  observationProject: string;
  /** Current project being queried */
  queryProject: string;
}

export interface ScoredResult {
  id: number;
  score: number;
  dimensions: {
    semantic: number;
    recency: number;
    authority: number;
    coherence: number;
  };
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  semantic: 0.4,
  recency: 0.3,
  authority: 0.2,
  coherence: 0.1,
};

/** Recency half-life in days */
const RECENCY_HALF_LIFE_DAYS = 14;

/** Max relevance_count for normalization */
const AUTHORITY_MAX_RELEVANCE = 10;

/** Bonus for confirmed observations */
const CONFIRMED_BONUS = 0.2;

export class HybridScorer {
  private weights: ScoringWeights;

  constructor(weights?: Partial<ScoringWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    const sum = this.weights.semantic + this.weights.recency + this.weights.authority + this.weights.coherence;
    if (!Number.isFinite(sum) || sum <= 0) {
      logger.warn('SCORING', `Invalid weight sum (${sum}), falling back to defaults`);
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }
    if (Math.abs(sum - 1.0) > 0.01) {
      logger.warn('SCORING', `Weights sum to ${sum.toFixed(2)}, normalizing to 1.0`);
      this.weights.semantic /= sum;
      this.weights.recency /= sum;
      this.weights.authority /= sum;
      this.weights.coherence /= sum;
    }
  }

  /**
   * Normalize vector distance to [0,1] similarity score.
   * Qdrant (via VectorSync): cosine distance = 1 - score, range 0→1
   * Chroma: L2 distance, range 0→~2
   * We divide by MAX_DISTANCE to normalize both to [0,1].
   */
  static normalizeSemantic(chromaDistance?: number, ftsRank?: number): number {
    if (chromaDistance !== undefined) {
      // Qdrant distances are 0→1, Chroma L2 are 0→2.
      // For Qdrant (<=1): divides by 1, full range preserved.
      // For Chroma (>1): divides by 2, backward compatible.
      const maxDist = chromaDistance > 1 ? 2 : 1;
      return Math.max(0, 1 - Math.min(chromaDistance / maxDist, 1));
    }
    if (ftsRank !== undefined) {
      // FTS5 rank is negative (closer to 0 = better match)
      return Math.max(0, Math.min(1, 1 + ftsRank / 20));
    }
    return 0.5; // neutral fallback
  }

  /**
   * Exponential decay: exp(-age_days / half_life)
   */
  static normalizeRecency(createdAtEpoch: number): number {
    const ageDays = Math.max(0, (Date.now() - createdAtEpoch) / (1000 * 60 * 60 * 24));
    return Math.max(0, Math.min(1, Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)));
  }

  /**
   * Authority = min(relevance/max, 1.0) + confirmed bonus, capped at 1.0
   */
  static normalizeAuthority(relevanceCount: number, correctness: string): number {
    const base = Math.max(0, Math.min(relevanceCount / AUTHORITY_MAX_RELEVANCE, 1.0));
    const bonus = correctness === 'confirmed' ? CONFIRMED_BONUS : 0;
    return Math.min(base + bonus, 1.0);
  }

  /**
   * Same project = 1.0, different project = 0.7
   */
  static normalizeCoherence(obsProject: string, queryProject: string): number {
    return obsProject === queryProject ? 1.0 : 0.7;
  }

  /**
   * Compute hybrid score for a single observation.
   */
  computeScore(dims: ScoringDimensions): ScoredResult['dimensions'] & { final: number } {
    const semantic = HybridScorer.normalizeSemantic(dims.chromaDistance, dims.ftsRank);
    const recency = HybridScorer.normalizeRecency(dims.createdAtEpoch);
    const authority = HybridScorer.normalizeAuthority(dims.relevanceCount, dims.correctness);
    const coherence = HybridScorer.normalizeCoherence(dims.observationProject, dims.queryProject);

    const final =
      semantic * this.weights.semantic +
      recency * this.weights.recency +
      authority * this.weights.authority +
      coherence * this.weights.coherence;

    return { semantic, recency, authority, coherence, final };
  }

  /**
   * Score and rank a batch of observations.
   * Returns IDs sorted by hybrid score descending.
   */
  scoreAndRank(
    observations: Array<{
      id: number;
      created_at_epoch: number;
      relevance_count: number;
      correctness: string;
      project: string;
    }>,
    queryProject: string,
    chromaDistanceMap?: Map<number, number>
  ): ScoredResult[] {
    const scored: ScoredResult[] = observations.map(obs => {
      const dims: ScoringDimensions = {
        chromaDistance: chromaDistanceMap?.get(obs.id),
        createdAtEpoch: obs.created_at_epoch,
        relevanceCount: obs.relevance_count ?? 0,
        correctness: obs.correctness ?? 'unverified',
        observationProject: obs.project,
        queryProject,
      };

      const result = this.computeScore(dims);

      return {
        id: obs.id,
        score: result.final,
        dimensions: {
          semantic: result.semantic,
          recency: result.recency,
          authority: result.authority,
          coherence: result.coherence,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Log scoring decision for a ranked set.
   */
  static logScoring(scored: ScoredResult[], context: string, limit?: number): void {
    const display = limit === undefined ? scored : scored.slice(0, Math.max(0, limit));
    for (let i = 0; i < display.length; i++) {
      const s = display[i];
      logger.info('SCORING', `${context} obs=#${s.id} sem=${s.dimensions.semantic.toFixed(2)} rec=${s.dimensions.recency.toFixed(2)} auth=${s.dimensions.authority.toFixed(2)} coh=${s.dimensions.coherence.toFixed(2)} final=${s.score.toFixed(3)} rank=${i + 1}/${scored.length}`);
    }
  }
}
