/**
 * ContextBuilder - Main orchestrator for context generation
 *
 * Coordinates all context generation components to build the final output.
 * This is the primary entry point for context generation.
 */

import path from 'path';
import { homedir } from 'os';
import { unlinkSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { getProjectName } from '../../utils/project-name.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary, SplitContext, WakeUpStats } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import { formatDate } from '../../shared/timeline-formatting.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
  querySummariesMulti,
  queryWakeUpStats,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderAgentEmptyState } from './formatters/AgentFormatter.js';
import { renderHumanEmptyState } from './formatters/HumanFormatter.js';

// Version marker path for native module error handling
const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

/**
 * Initialize database connection with error handling
 */
function initializeDatabase(): SessionStore | null {
  try {
    return new SessionStore();
  } catch (error: any) {
    if (error.code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        logger.debug('SYSTEM', 'Marker file cleanup failed (may not exist)', {}, unlinkError as Error);
      }
      logger.error('SYSTEM', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

/**
 * Render empty state when no data exists
 */
function renderEmptyState(project: string, forHuman: boolean): string {
  return forHuman ? renderHumanEmptyState(project) : renderAgentEmptyState(project);
}

/**
 * Render L0+L1 progressive wake-up prefix for semantic priming.
 *
 * L0 (~50 tokens): project identity, memory span, cross-session awareness.
 * L1 (~120 tokens): recent decisions, most-observed files.
 *
 * Placed at the very start of staticPrefix so it lands at the beginning
 * of the prompt (exploiting U-shaped attention from "Lost in the Middle").
 */
function renderWakeUpPrefix(project: string, stats: WakeUpStats): string[] {
  const lines: string[] = [];

  // L0 — Identity
  const dateRange = stats.firstDate && stats.lastDate
    ? `Memory spans ${formatDate(stats.firstDate)} to ${formatDate(stats.lastDate)}.`
    : '';
  lines.push(
    `${project} — ${stats.totalObservations} observations across ${stats.totalSessions} sessions. ${dateRange}`.trim()
  );
  lines.push('You have persistent cross-session memory. Check the Context Index below before reading files.');
  lines.push('');

  // L1 — Critical Facts (only if data exists)
  const hasDecisions = stats.recentDecisions.length > 0;
  const hasFiles = stats.topFiles.length > 0;

  if (hasDecisions) {
    lines.push('Recent decisions:');
    for (const d of stats.recentDecisions) {
      lines.push(`- ${d.title} (${d.date})`);
    }
  }

  if (hasFiles) {
    const shortFiles = stats.topFiles.map(f => {
      const parts = f.split('/');
      return parts[parts.length - 1];
    });
    lines.push(`Top files: ${shortFiles.join(', ')}`);
  }

  if (hasDecisions || hasFiles) {
    lines.push('');
  }

  return lines;
}

/**
 * Build context output from loaded data, split into static prefix and dynamic context.
 *
 * Static prefix: L0+L1 wake-up + legend, column key, instructions — cacheable.
 * Dynamic context: timeline, summaries, token economics, timestamps.
 */
function buildSplitContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  forHuman: boolean,
  wakeUpStats?: WakeUpStats
): SplitContext {
  // === STATIC PREFIX ===
  const staticLines: string[] = [];
  if (wakeUpStats && wakeUpStats.totalObservations > 0) {
    staticLines.push(...renderWakeUpPrefix(project, wakeUpStats));
  }
  staticLines.push(...renderHeader(project, calculateTokenEconomics(observations), config, forHuman));

  // === DYNAMIC CONTEXT ===
  const dynamicLines: string[] = [];
  const economics = calculateTokenEconomics(observations);

  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  dynamicLines.push(...renderTimeline(timeline, fullObservationIds, config, cwd, forHuman));

  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    dynamicLines.push(...renderSummaryFields(mostRecentSummary, forHuman));
  }

  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  dynamicLines.push(...renderPreviouslySection(priorMessages, forHuman));

  dynamicLines.push(...renderFooter(economics, config, forHuman));

  return {
    staticPrefix: staticLines.join('\n').trimEnd(),
    dynamicContext: dynamicLines.join('\n').trimEnd(),
  };
}

/**
 * Generate context for a project
 *
 * Main entry point for context generation. Backward-compatible wrapper
 * that concatenates static + dynamic context.
 */
export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<string> {
  const split = await generateSplitContext(input, forHuman);
  if (!split.dynamicContext) {
    return split.staticPrefix;
  }
  return `${split.staticPrefix}\n${split.dynamicContext}`;
}

/**
 * Generate split context for a project (cache-optimized)
 *
 * Returns { staticPrefix, dynamicContext } so callers can insert a
 * cache boundary marker between them.
 */
export async function generateSplitContext(
  input?: ContextInput,
  forHuman: boolean = false
): Promise<SplitContext> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);
  const platformSource = input?.platform_source;

  const projects = input?.projects || [project];

  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  const db = initializeDatabase();
  if (!db) {
    return { staticPrefix: '', dynamicContext: '' };
  }

  try {
    const observations = projects.length > 1
      ? queryObservationsMulti(db, projects, config, platformSource)
      : queryObservations(db, project, config, platformSource);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config, platformSource)
      : querySummaries(db, project, config, platformSource);

    if (observations.length === 0 && summaries.length === 0) {
      return { staticPrefix: renderEmptyState(project, forHuman), dynamicContext: '' };
    }

    // Query L0+L1 wake-up stats (lightweight aggregates, no full scan)
    const wakeUpStats = queryWakeUpStats(db, projects);

    return buildSplitContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      forHuman,
      wakeUpStats
    );
  } finally {
    db.close();
  }
}
