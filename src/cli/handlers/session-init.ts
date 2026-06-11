// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
import { resolveRuntimeContext, logServerBetaFallback } from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';
import {
  getSelfAuthorConfig,
  getCheckpointConfig,
  getSubstantiveCount,
  resetSubstantiveCount,
  readCheckpointState,
  writeCheckpointState,
  advanceCheckpoint,
} from '../../shared/self-author.js';
import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';

/**
 * Checkpoint Rider (real-time self-author): when CLAUDE_MEM_SELF_AUTHOR_REALTIME
 * is on, ride this UserPromptSubmit with a checkpoint reminder so the session
 * self-authors at the turn tail. Returns the rider text to append to the
 * injected context, or '' when no checkpoint fires. Off by default → no-op.
 */
function computeCheckpointRider(sessionId: string, settings: SettingsDefaults): string {
  const env: Record<string, string | undefined> = {
    CLAUDE_MEM_SELF_AUTHOR_REALTIME: settings.CLAUDE_MEM_SELF_AUTHOR_REALTIME,
    CLAUDE_MEM_SELF_AUTHOR_COOLDOWN_PROMPTS: settings.CLAUDE_MEM_SELF_AUTHOR_COOLDOWN_PROMPTS,
    CLAUDE_MEM_SELF_AUTHOR_MAX_OBS_PER_CHECKPOINT: settings.CLAUDE_MEM_SELF_AUTHOR_MAX_OBS_PER_CHECKPOINT,
    CLAUDE_MEM_SELF_AUTHOR_FALLBACK_DELAY_MS: settings.CLAUDE_MEM_SELF_AUTHOR_FALLBACK_DELAY_MS,
    CLAUDE_MEM_SELF_AUTHOR_ENABLED: settings.CLAUDE_MEM_SELF_AUTHOR_ENABLED,
    CLAUDE_MEM_SELF_AUTHOR_THRESHOLD: settings.CLAUDE_MEM_SELF_AUTHOR_THRESHOLD,
    CLAUDE_MEM_DATA_DIR: settings.CLAUDE_MEM_DATA_DIR,
  };
  const cpCfg = getCheckpointConfig(env);
  if (!cpCfg.realtimeEnabled) return '';
  const saCfg = getSelfAuthorConfig(env);
  const prev = readCheckpointState(sessionId, saCfg.stateDir);
  const { state, rider } = advanceCheckpoint(prev, {
    sessionId,
    substantiveCount: getSubstantiveCount(sessionId, saCfg.stateDir),
    threshold: saCfg.threshold,
    realtimeEnabled: true,
    cooldownPrompts: cpCfg.cooldownPrompts,
    // The claude-mem MCP server provides save_observation whenever the plugin
    // is loaded, so it is available by construction in a tracked session.
    saveObservationAvailable: true,
  });
  writeCheckpointState(sessionId, saCfg.stateDir, state);
  if (!rider) return '';
  // Optimistic reset: the checkpoint claims the substantive window now; if the
  // rider is ignored, the delayed Loop-A fallback covers it (design §2.3/§3).
  resetSubstantiveCount(sessionId, saCfg.stateDir);
  return rider;
}

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      try {
        await runtime.client.startSession({
          projectId: runtime.projectId,
          externalSessionId: sessionId,
          contentSessionId: sessionId,
          agentId: input.agentId ?? null,
          agentType: input.agentType ?? null,
          platformSource,
          metadata: { project, prompt },
        });
        logger.info('HOOK', 'session-init: server-beta session started', {
          contentSessionId: sessionId,
          project,
        });

        // Semantic injection ← PG via /v1/context (FTS over the prompt). Gated
        // by CLAUDE_MEM_SEMANTIC_INJECT and a minimum prompt length, same as
        // the worker path. Best-effort: any failure just skips injection — the
        // session already started, so we never fall back to the worker here.
        const sbSettings = loadFromFileOnce();
        const riderContext = computeCheckpointRider(sessionId, sbSettings);
        const sbSemanticInject =
          String(sbSettings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
        if (sbSemanticInject && prompt.length >= 20 && prompt !== '[media prompt]') {
          const sbLimit = parseInt(String(sbSettings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5'), 10) || 5;
          try {
            const semantic = await runtime.client.contextObservations({
              projectId: runtime.projectId,
              query: prompt,
              limit: sbLimit,
            });
            const semanticContext = (semantic.context ?? '').trim();
            if (semanticContext) {
              logger.info('HOOK', 'session-init: server-beta semantic injection', {
                contentSessionId: sessionId,
                count: semantic.observations?.length ?? 0,
              });
              return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: riderContext
                    ? `## Relevant Past Work (semantic match)\n\n${semanticContext}\n\n${riderContext}`
                    : `## Relevant Past Work (semantic match)\n\n${semanticContext}`,
                },
              };
            }
          } catch (semanticError: unknown) {
            logger.warn('HOOK', 'session-init: server-beta semantic injection failed', {
              error: semanticError instanceof Error ? semanticError.message : String(semanticError),
            });
          }
        }
        if (riderContext) {
          return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: riderContext },
          };
        }
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerBetaClientError(error) && error.isFallbackEligible()) {
          logServerBetaFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/start',
          });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server beta session-start failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    const initResult = await executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
      },
    );

    if (isWorkerFallback(initResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    const settings = loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticResult = await executeWithWorkerFallback<SemanticContextResponse>(
        '/api/context/semantic',
        'POST',
        { q: prompt, project, limit },
      );
      if (!isWorkerFallback(semanticResult) && semanticResult?.context) {
        logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
        additionalContext = semanticResult.context;
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};
