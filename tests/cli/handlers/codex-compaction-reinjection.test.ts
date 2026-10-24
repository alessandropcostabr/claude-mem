import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';
import { observationHandler } from '../../../src/cli/handlers/observation.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

const input = (agentId?: string): NormalizedHookInput => ({
  sessionId: 'session-1',
  cwd: process.cwd(),
  platform: 'codex',
  agentId,
  toolName: 'exec_command',
  toolInput: { cmd: 'true' },
  toolResponse: '',
});

describe('Codex compaction reinjection', () => {
  let dataDir: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-compaction-reinjection-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns a compact-safe acknowledgement', async () => {
    const result = await getEventHandler('post-compact').execute(input('agent-a'));
    expect(codexAdapter.formatOutput(result)).toEqual({ continue: true });
  });

  it('records the next tool and reinjects memory once into that thread', async () => {
    const observationSpy = spyOn(observationHandler, 'execute')
      .mockImplementation(async () => ({ continue: true, suppressOutput: true }));
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory timeline' },
    }));
    try {
      await getEventHandler('post-compact').execute(input('agent-a'));
      expect(codexAdapter.formatOutput(await getEventHandler('observation').execute(input('agent-a')))).toEqual({
        continue: true,
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'memory timeline' },
      });
      await getEventHandler('observation').execute(input('agent-a'));
      expect(observationSpy).toHaveBeenCalledTimes(2);
      expect(contextSpy).toHaveBeenCalledTimes(1);
    } finally {
      observationSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });

  it('does not leak the marker across sibling threads', async () => {
    const observationSpy = spyOn(observationHandler, 'execute')
      .mockImplementation(async () => ({ continue: true }));
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory timeline' },
    }));
    try {
      await getEventHandler('post-compact').execute(input('agent-a'));
      await getEventHandler('observation').execute(input('agent-b'));
      expect(contextSpy).not.toHaveBeenCalled();
      await getEventHandler('observation').execute(input('agent-a'));
      expect(contextSpy).toHaveBeenCalledTimes(1);
    } finally {
      observationSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });
});
