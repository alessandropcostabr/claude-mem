import { describe, expect, it } from 'bun:test';

import { codexAdapter } from '../../../src/cli/adapters/codex.js';

describe('Codex tool-use identity', () => {
  it('preserves tool_use_id for idempotent observation replay', () => {
    const normalized = codexAdapter.normalizeInput({
      session_id: 'session-test',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      tool_response: { stdout: '' },
      tool_use_id: 'call-123',
    });

    expect(normalized.toolUseId).toBe('call-123');
  });
});
