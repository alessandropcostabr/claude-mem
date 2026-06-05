
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

async function dispatchToWorker(
  input: NormalizedHookInput,
  platformSource: string,
): Promise<HookResult> {
  const result = await executeWithWorkerFallback<{ status?: string }>(
    '/api/sessions/observations',
    'POST',
    {
      contentSessionId: input.sessionId,
      platformSource,
      tool_name: input.toolName,
      tool_input: input.toolInput,
      tool_response: input.toolResponse,
      cwd: input.cwd,
      agentId: input.agentId,
      agentType: input.agentType,
    },
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
      try {
        await runtime.client.recordEvent({
          projectId: runtime.projectId,
          contentSessionId: sessionId,
          sourceType: 'hook',
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
          },
        });
        logger.debug('HOOK', 'Observation sent successfully via server-beta', { toolName });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server beta event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    return dispatchToWorker(input, platformSource);
  },
};
