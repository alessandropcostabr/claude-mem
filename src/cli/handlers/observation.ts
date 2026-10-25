// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import { createHash, randomUUID } from 'crypto';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getSelfAuthorConfig, isSubstantiveTool, recordSubstantiveEvent } from '../../shared/self-author.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';
import {
  replayOneServerBetaEvent,
  spoolServerBetaEvent,
} from '../../services/hooks/server-beta-event-spool.js';

// Derived from the 5 s Codex PostToolUse wire timeout in codex-hooks.json.
// A 2 s server attempt leaves room for hook startup and one durable local
// spool write before Codex terminates the synchronous hook.
const SERVER_OBSERVATION_TIMEOUT_MS = 2_000;
const SERVER_SPOOL_REPLAY_TIMEOUT_MS = 1_000;

export function buildObservationSourceEventId(input: {
  projectId: string;
  contentSessionId: string;
  platformSource: string;
  toolUseId?: string;
  fallbackEventId?: string;
}): string {
  const eventId = input.toolUseId ?? input.fallbackEventId ?? randomUUID();
  return `hook:${createHash('sha256')
    .update(input.projectId)
    .update('\0')
    .update(input.contentSessionId)
    .update('\0')
    .update(input.platformSource)
    .update('\0')
    .update(eventId)
    .digest('hex')}`;
}

async function dispatchToWorker(
  input: NormalizedHookInput,
  platformSource: string,
): Promise<HookResult> {
  const boundedCodexOptions = input.platform === 'codex'
    ? { timeoutMs: SERVER_OBSERVATION_TIMEOUT_MS, skipEnsure: true, failOpen: true }
    : undefined;
  const result = await executeWithWorkerFallback<{ status?: string }>(
    '/api/sessions/observations',
    'POST',
    {
      contentSessionId: input.sessionId,
      platformSource,
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      toolUseId: input.toolUseId,
      cwd: input.cwd,
      agentId: input.agentId,
      agentType: input.agentType,
    },
    boundedCodexOptions,
  );

  if (isWorkerFallback(result)) {
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  }

  logger.debug('HOOK', 'Observation sent successfully via worker', { toolName: input.toolName });
  return { continue: true, suppressOutput: true };
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Self-authoring: count substantive activity so the Stop hook can decide
    // whether to ask the running session to write its own observations.
    try {
      const s = loadFromFileOnce();
      const saCfg = getSelfAuthorConfig({
        CLAUDE_MEM_SELF_AUTHOR_ENABLED: s.CLAUDE_MEM_SELF_AUTHOR_ENABLED,
        CLAUDE_MEM_SELF_AUTHOR_THRESHOLD: s.CLAUDE_MEM_SELF_AUTHOR_THRESHOLD,
        CLAUDE_MEM_DATA_DIR: s.CLAUDE_MEM_DATA_DIR,
      });
      if (saCfg.enabled && sessionId && isSubstantiveTool(toolName)) {
        recordSubstantiveEvent(sessionId, saCfg.stateDir);
      }
    } catch (err) {
      logger.debug('HOOK', 'self-author counter increment failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      // Platforms without a native tool-use id still need one stable identity
      // shared by the initial request and its persisted replay.
      const sourceEventId = buildObservationSourceEventId({
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        platformSource,
        toolUseId: input.toolUseId,
        fallbackEventId: input.toolUseId ? undefined : randomUUID(),
      });
      const event = {
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        sourceEventId,
        platformSource,
        sourceType: 'hook' as const,
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
          tool_use_id: input.toolUseId,
        },
      };
      // Drain one older event before the current write so recovery preserves
      // hook order without letting an unbounded backlog consume this hook.
      try {
        await replayOneServerBetaEvent(runtime.client, { timeoutMs: SERVER_SPOOL_REPLAY_TIMEOUT_MS });
      } catch (error: unknown) {
        logger.debug('HOOK', 'Server-beta event spool replay skipped', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await runtime.client.recordEvent(
          event,
          input.platform === 'codex' ? { timeoutMs: SERVER_OBSERVATION_TIMEOUT_MS } : undefined,
        );
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          try {
            spoolServerBetaEvent(event);
          } catch (spoolError: unknown) {
            logger.error('HOOK', 'Could not persist server-beta event spool entry', {
              error: spoolError instanceof Error ? spoolError.message : String(spoolError),
            });
          }
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        } else {
          logger.error('HOOK', 'Server beta event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }

      logger.debug('HOOK', 'Observation sent successfully via server-beta', { toolName });
      return { continue: true, suppressOutput: true };
    }

    return dispatchToWorker(input, platformSource);
  },
};
