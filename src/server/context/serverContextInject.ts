// SPDX-License-Identifier: Apache-2.0
//
// Server-beta context injection. Turns Postgres observation rows into the SAME
// rendered timeline the worker emits at SessionStart, so a stateless client
// (no local SQLite/worker) can inject context fetched over HTTP.
//
// The structured fields the timeline needs (title/subtitle/narrative/facts/
// files_*) are persisted on observations.metadata by processGeneratedResponse,
// so we can reconstruct the worker-shaped Observation/SessionSummary objects
// and feed them straight into the shared, SessionStore-free assembler.

import type { PostgresObservation } from '../../storage/postgres/observations.js';
import type {
  ContextConfig,
  Observation,
  SessionSummary,
} from '../../services/context/types.js';
import {
  assembleContext,
  renderEmptyState,
} from '../../services/context/timeline-assembly.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
import { logger } from '../../utils/logger.js';

// How many session summaries the timeline shows. The route fetches one extra
// (SUMMARY_LOOKAHEAD) so prepareSummariesForTimeline can compute display epochs.
export const SERVER_CONTEXT_SESSION_COUNT = 10;

// Mirrors the worker's CLAUDE_MEM_CONTEXT_* defaults, with two deliberate
// server-side overrides: showLastMessage=false (the server has no local
// transcripts) and the savings flags off (discovery_tokens is not persisted
// server-side, so a "savings %" would be misleading).
const SERVER_DEFAULT_CONFIG: ContextConfig = {
  totalObservationCount: 50,
  fullObservationCount: 0,
  sessionCount: SERVER_CONTEXT_SESSION_COUNT,
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
  // Only the SQLite query path filters on these; the renderers never read them.
  observationTypes: new Set<string>(),
  observationConcepts: new Set<string>(),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
  // get_observations now routes to POST /v1/observations in server-beta mode
  // (fetch by Postgres uuid), so by-id drilldown works — expose fetchable uuids
  // in the injected timeline instead of pointing at search.
  fetchByIdSupported: true,
};

function metaRecord(obs: PostgresObservation): Record<string, unknown> {
  return obs.metadata && typeof obs.metadata === 'object'
    ? (obs.metadata as Record<string, unknown>)
    : {};
}

function metaString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// The worker stores facts/concepts/files_* as JSON-string columns and the
// renderers parse them back with parseJsonArray. PG keeps them as real arrays
// inside metadata, so re-stringify to match the renderer contract.
function metaJsonArray(value: unknown): string | null {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

export function mapPgObservationToLocal(obs: PostgresObservation): Observation {
  const meta = metaRecord(obs);
  return {
    id: obs.id,
    memory_session_id: obs.serverSessionId ?? '',
    type: obs.kind,
    title: metaString(meta.title),
    subtitle: metaString(meta.subtitle),
    narrative: metaString(meta.narrative),
    facts: metaJsonArray(meta.facts),
    concepts: metaJsonArray(meta.concepts),
    files_read: metaJsonArray(meta.files_read),
    files_modified: metaJsonArray(meta.files_modified),
    discovery_tokens: null,
    created_at: new Date(obs.createdAtEpoch).toISOString(),
    created_at_epoch: obs.createdAtEpoch,
  };
}

export function mapPgSummaryToLocal(obs: PostgresObservation): SessionSummary {
  const meta = metaRecord(obs);
  return {
    id: obs.id,
    memory_session_id: obs.serverSessionId ?? '',
    request: metaString(meta.request),
    investigated: metaString(meta.investigated),
    learned: metaString(meta.learned),
    completed: metaString(meta.completed),
    next_steps: metaString(meta.next_steps),
    created_at: new Date(obs.createdAtEpoch).toISOString(),
    created_at_epoch: obs.createdAtEpoch,
  };
}

export interface RenderServerContextInput {
  project: string;
  observations: PostgresObservation[];
  summaries: PostgresObservation[];
  limit?: number;
  forHuman?: boolean;
  // Client cwd, used only by the human (colored terminal) render to relativize
  // file paths. Fleet-wide observations from other repos stay absolute; same-repo
  // files render project-relative. Empty when the client doesn't send it.
  cwd?: string;
}

export interface RenderServerContextResult {
  context: string;
  count: number;
}

// The timeline renderers read the active mode for the type legend and per-type
// icons. Unlike the worker, the server-beta runtime does not always load a mode
// at startup (generation falls back to a hardcoded type list), so ensure one is
// active before rendering. If a custom mode is already loaded (e.g. the LATE
// build) this is a no-op; otherwise we load the vanilla 'code' mode. Failure
// (mode files absent) is tolerated — assembleContext is guarded by a fallback.
function ensureModeLoaded(): void {
  const mode = ModeManager.getInstance();
  try {
    mode.getActiveMode();
    return;
  } catch {
    // No mode loaded yet; fall through to load the default.
  }
  mode.loadMode('code');
}

// Last-resort flat rendering when the rich timeline cannot be produced (e.g.
// mode files missing on the server). Mirrors /v1/context: recent content joined
// newest-first. Guarantees /v1/context/inject never 500s on a render failure.
function renderFlatFallback(observations: PostgresObservation[]): string {
  return observations
    .map(o => o.content)
    .filter(text => typeof text === 'string' && text.length > 0)
    .join('\n\n');
}

export function renderServerContext(input: RenderServerContextInput): RenderServerContextResult {
  const forHuman = input.forHuman ?? false;
  const config: ContextConfig = {
    ...SERVER_DEFAULT_CONFIG,
    ...(typeof input.limit === 'number' && input.limit > 0
      ? { totalObservationCount: input.limit }
      : {}),
  };

  const observations = input.observations.map(mapPgObservationToLocal);
  const summaries = input.summaries.map(mapPgSummaryToLocal);

  if (observations.length === 0 && summaries.length === 0) {
    return { context: renderEmptyState(input.project, forHuman), count: 0 };
  }

  try {
    ensureModeLoaded();
    const context = assembleContext(
      input.project,
      observations,
      summaries,
      config,
      // cwd is only used by the human file-relativizer (getPriorSessionMessages
      // is gated off here). Empty when the client doesn't send one.
      input.cwd ?? '',
      undefined,
      forHuman,
    );
    return { context, count: observations.length };
  } catch (error) {
    logger.warn('SYSTEM', 'server-beta context inject: timeline render failed, using flat fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { context: renderFlatFallback(input.observations), count: observations.length };
  }
}
