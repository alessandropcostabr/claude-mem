
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  getWorkerPort,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import {
  resolveRuntimeContext,
  logServerBetaFallback,
  type ServerBetaRuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { isServerBetaClientError } from '../../services/hooks/server-beta-client.js';

function buildSystemMessage(displayContent: string, showTerminalOutput: boolean, port: number): string | undefined {
  return showTerminalOutput && displayContent
    ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
    : undefined;
}

// Server-beta SessionStart injection: fetch the timeline string from PG over
// HTTP instead of the local worker/SQLite. On ANY failure we inject empty
// rather than block the session start (acceptance criterion: server offline →
// start must not hang). No worker fallback here — the point of server-beta is
// a stateless client.
async function injectFromServerBeta(
  runtime: ServerBetaRuntimeContext,
  input: NormalizedHookInput,
  project: string,
  cwd: string,
  showTerminalOutput: boolean,
  port: number,
): Promise<HookResult> {
  const emptyResult: HookResult = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    exitCode: HOOK_EXIT_CODES.SUCCESS,
  };

  let additionalContext = '';
  try {
    const result = await runtime.client.injectContext({
      projectId: runtime.projectId,
      project,
      cwd,
      forHuman: false,
    });
    additionalContext = (result.context ?? '').trim();
  } catch (error: unknown) {
    if (isServerBetaClientError(error)) {
      logServerBetaFallback(error.kind, {
        status: error.status,
        message: error.message,
        route: '/v1/context/inject',
      });
    } else {
      logger.warn('HOOK', 'server-beta context inject failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return emptyResult;
  }

  let coloredTimeline = '';
  if (showTerminalOutput) {
    try {
      const colored = await runtime.client.injectContext({
        projectId: runtime.projectId,
        project,
        cwd,
        forHuman: true,
      });
      coloredTimeline = (colored.context ?? '').trim();
    } catch {
      // Terminal-only colored output is best-effort; never let it affect the
      // injected context or block the start.
    }
  }

  const platform = input.platform;
  const displayContent = coloredTimeline || (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
    systemMessage: buildSystemMessage(displayContent, showTerminalOutput, port),
  };
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    const settings = loadFromFileOnce();
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      return injectFromServerBeta(runtime, input, context.primary, cwd, showTerminalOutput, port);
    }

    const projectsParam = context.allProjects.join(',');
    const apiPath = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    const contextResult = await executeWithWorkerFallback<string>(apiPath, 'GET');
    if (isWorkerFallback(contextResult)) {
      return emptyResult;
    }

    let additionalContext: string;
    if (typeof contextResult === 'string') {
      additionalContext = contextResult.trim();
    } else if (contextResult === undefined) {
      additionalContext = '';
    } else {
      logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
      return emptyResult;
    }

    // Issue #2215: surface stale OAuth token marker as a session-start hint.
    // Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
    // a previous worker spawn detected an expired keychain entry.
    const staleReason = readStaleMarker();
    if (staleReason) {
      const hint = `[claude-mem] Claude Desktop OAuth token is stale: ${staleReason}\nPlease re-login via Claude Desktop to refresh the token.`;
      additionalContext = additionalContext
        ? `${hint}\n\n${additionalContext}`
        : hint;
    }

    let coloredTimeline = '';
    if (showTerminalOutput) {
      const colorResult = await executeWithWorkerFallback<string>(colorApiPath, 'GET');
      if (!isWorkerFallback(colorResult) && typeof colorResult === 'string') {
        coloredTimeline = colorResult.trim();
      }
    }

    const platform = input.platform;

    const displayContent = coloredTimeline || (platform === 'gemini-cli' || platform === 'gemini' ? additionalContext : '');

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage: buildSystemMessage(displayContent, showTerminalOutput, port)
    };
  }
};
