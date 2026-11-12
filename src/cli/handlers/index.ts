
import type { EventHandler } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { contextHandler } from './context.js';
import { sessionInitHandler } from './session-init.js';
import { observationHandler } from './observation.js';
import { summarizeHandler } from './summarize.js';
import { userMessageHandler } from './user-message.js';
import { fileEditHandler } from './file-edit.js';
import { fileContextHandler } from './file-context.js';
import { postCompactHandler } from './post-compact.js';
import { takeTimelinePending } from '../../shared/codex-compaction-gate.js';

export type EventType =
  | 'context'           
  | 'session-init'      
  | 'observation'       
  | 'summarize'         
  | 'user-message'      
  | 'file-edit'         
  | 'file-context'
  | 'post-compact';

export const observationWithPendingTimelineHandler: EventHandler = {
  async execute(input) {
    const observationResult = await observationHandler.execute(input);
    if (input.platform !== 'codex' || !takeTimelinePending(input.sessionId, input.agentId)) {
      return observationResult;
    }

    const contextResult = await contextHandler.execute(input);
    const outageNotice = contextResult.systemMessage
      ? { systemMessage: contextResult.systemMessage }
      : {};
    const timeline = contextResult.hookSpecificOutput?.additionalContext;
    if (!timeline) return { ...observationResult, ...outageNotice };

    return {
      ...observationResult,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: timeline },
      ...outageNotice,
    };
  },
};

const handlers: Record<EventType, EventHandler> = {
  'context': contextHandler,
  'session-init': sessionInitHandler,
  'observation': observationWithPendingTimelineHandler,
  'summarize': summarizeHandler,
  'user-message': userMessageHandler,
  'file-edit': fileEditHandler,
  'file-context': fileContextHandler,
  'post-compact': postCompactHandler,
};

export function getEventHandler(eventType: string): EventHandler {
  const handler = handlers[eventType as EventType];
  if (!handler) {
    logger.warn('HOOK', `Unknown event type: ${eventType}, returning no-op`);
    return {
      async execute() {
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    };
  }
  return handler;
}

export { contextHandler } from './context.js';
export { sessionInitHandler } from './session-init.js';
export { observationHandler } from './observation.js';
export { summarizeHandler } from './summarize.js';
export { userMessageHandler } from './user-message.js';
export { fileEditHandler } from './file-edit.js';
export { fileContextHandler } from './file-context.js';
export { postCompactHandler } from './post-compact.js';
