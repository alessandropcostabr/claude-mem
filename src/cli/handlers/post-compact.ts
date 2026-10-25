import type { EventHandler } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { markTimelinePending } from '../../shared/codex-compaction-gate.js';

/** Mark a Codex thread so its next context-capable hook restores memory. */
export const postCompactHandler: EventHandler = {
  async execute(input) {
    markTimelinePending(input.sessionId, input.agentId);
    return { continue: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
