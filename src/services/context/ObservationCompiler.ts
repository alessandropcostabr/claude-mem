
import { SessionStore } from '../sqlite/SessionStore.js';
import type {
  ContextConfig,
  Observation,
  SessionSummary,
} from './types.js';
import { SUMMARY_LOOKAHEAD } from './types.js';

// SessionStore-backed query functions live here. The SessionStore-free timeline
// assembly (buildTimeline, getPriorSessionMessages, assembleContext, ...) lives
// in timeline-assembly.ts and is re-exported below for backward compatibility.
export {
  buildTimeline,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  getFullObservationIds,
  extractPriorMessages,
  assembleContext,
  renderEmptyState,
} from './timeline-assembly.js';

export function queryObservations(
  db: SessionStore,
  project: string,
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    project,
    project,
    ...typeArray,
    ...conceptArray,
    config.totalObservationCount
  ) as Observation[];
}

export function querySummaries(
  db: SessionStore,
  project: string,
  config: ContextConfig
): SessionSummary[] {
  return db.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project = ? OR ss.merged_into_project = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(project, project, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}

export function queryObservationsMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${projectPlaceholders})
           OR o.merged_into_project IN (${projectPlaceholders}))
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    ...projects,
    ...projects,
    ...typeArray,
    ...conceptArray,
    config.totalObservationCount
  ) as Observation[];
}

export function countObservationsByProjects(db: SessionStore, projects: string[]): number {
  if (projects.length === 0) return 0;
  const projectPlaceholders = projects.map(() => '?').join(',');
  const row = db.db.prepare(`
    SELECT COUNT(*) as count FROM observations
    WHERE project IN (${projectPlaceholders})
       OR merged_into_project IN (${projectPlaceholders})
  `).get(...projects, ...projects) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function querySummariesMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): SessionSummary[] {
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${projectPlaceholders})
           OR ss.merged_into_project IN (${projectPlaceholders}))
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...projects, ...projects, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}
