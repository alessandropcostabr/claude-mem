import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realEventSpool from '../../../src/services/hooks/server-beta-event-spool.js';

const hookSettingsSnapshot = { ...realHookSettings };
const runtimeSelectorSnapshot = { ...realRuntimeSelector };
const workerUtilsSnapshot = { ...realWorkerUtils };
const eventSpoolSnapshot = { ...realEventSpool };

interface RecordEventCall {
  event: Record<string, unknown>;
  options?: { timeoutMs?: number };
}

const recordEventCalls: RecordEventCall[] = [];
let recordEventError: Error | null = null;
const workerFallbackCalls: Array<{ options?: { timeoutMs?: number } }> = [];
const spoolCalls: Array<Record<string, unknown>> = [];
const replayCalls: Array<{ options: { timeoutMs?: number } }> = [];
let selectedRuntime: { runtime: 'worker' } | {
  runtime: 'server-beta';
  projectId: string;
  client: { recordEvent: (event: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<void> };
};

mock.module('../../../src/shared/hook-settings.js', () => ({
  ...hookSettingsSnapshot,
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SELF_AUTHOR_ENABLED: 'false',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...workerUtilsSnapshot,
  executeWithWorkerFallback: async (
    _url: string,
    _method: string,
    _body: unknown,
    options?: { timeoutMs?: number },
  ) => {
    workerFallbackCalls.push({ options });
    return { status: 'queued' };
  },
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...runtimeSelectorSnapshot,
  resolveRuntimeContext: () => selectedRuntime,
  logServerBetaFallback: () => {},
}));

mock.module('../../../src/services/hooks/server-beta-event-spool.js', () => ({
  ...eventSpoolSnapshot,
  spoolServerBetaEvent: (event: Record<string, unknown>) => {
    spoolCalls.push(event);
    return 'spool-entry-test';
  },
  replayOneServerBetaEvent: async (_client: unknown, options: { timeoutMs?: number }) => {
    replayCalls.push({ options });
    return { status: 'empty' as const };
  },
}));

import {
  buildObservationSourceEventId,
  observationHandler,
} from '../../../src/cli/handlers/observation.js';
import { ServerBetaClientError } from '../../../src/services/hooks/server-beta-client.js';

const input = (platform: 'codex' | 'claude-code') => ({
  sessionId: 'session-test',
  cwd: '/tmp',
  platform,
  toolName: 'Bash',
  toolInput: { command: 'true' },
  toolResponse: { stdout: '' },
  toolUseId: 'tool-use-test',
});

beforeEach(() => {
  recordEventCalls.length = 0;
  recordEventError = null;
  workerFallbackCalls.length = 0;
  spoolCalls.length = 0;
  replayCalls.length = 0;
  selectedRuntime = {
    runtime: 'server-beta',
    projectId: 'project-test',
    client: {
      recordEvent: async (event: Record<string, unknown>, options?: { timeoutMs?: number }) => {
        recordEventCalls.push({ event, options });
        if (recordEventError) throw recordEventError;
      },
    },
  };
});

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => hookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => workerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => runtimeSelectorSnapshot);
  mock.module('../../../src/services/hooks/server-beta-event-spool.js', () => eventSpoolSnapshot);
});

describe('observationHandler server-beta deadline', () => {
  it('scopes remote idempotency by project, session, platform, and raw tool id', () => {
    const base = {
      projectId: 'project-test',
      contentSessionId: 'session-test',
      platformSource: 'codex',
      toolUseId: 'tool-use-test',
    };
    const first = buildObservationSourceEventId(base);
    expect(first).toMatch(/^hook:[a-f0-9]{64}$/);
    expect(buildObservationSourceEventId(base)).toBe(first);
    expect(buildObservationSourceEventId({ ...base, contentSessionId: 'session-other' })).not.toBe(first);
    expect(buildObservationSourceEventId({ ...base, platformSource: 'claude-code' })).not.toBe(first);
    expect(buildObservationSourceEventId({ ...base, projectId: 'project-other' })).not.toBe(first);
    const generated = buildObservationSourceEventId({
      ...base,
      toolUseId: undefined,
      fallbackEventId: 'generated-once',
    });
    expect(generated).toMatch(/^hook:[a-f0-9]{64}$/);
    expect(buildObservationSourceEventId({
      ...base,
      toolUseId: undefined,
      fallbackEventId: 'generated-once',
    })).toBe(generated);
  });

  it('bounds only Codex event requests to two seconds', async () => {
    await observationHandler.execute(input('codex'));
    expect(recordEventCalls[0]?.options).toEqual({ timeoutMs: 2_000 });
    expect(recordEventCalls[0]?.event.sourceEventId).toBe(buildObservationSourceEventId({
      projectId: 'project-test',
      contentSessionId: 'session-test',
      platformSource: 'codex',
      toolUseId: 'tool-use-test',
    }));
    expect((recordEventCalls[0]?.event.payload as Record<string, unknown>).tool_use_id).toBe('tool-use-test');
    expect(workerFallbackCalls).toHaveLength(0);
    expect(replayCalls).toEqual([{ options: { timeoutMs: 1_000 } }]);

    recordEventCalls.length = 0;
    replayCalls.length = 0;
    await observationHandler.execute(input('claude-code'));
    expect(recordEventCalls[0]?.options).toBeUndefined();
    expect(workerFallbackCalls).toHaveLength(0);
    expect(replayCalls).toEqual([{ options: { timeoutMs: 1_000 } }]);
  });

  it('spools exactly once and never invokes the worker after a Codex timeout', async () => {
    recordEventError = new ServerBetaClientError('timeout', 'server request timed out');

    const result = await observationHandler.execute(input('codex'));

    expect(result.continue).toBe(true);
    expect(recordEventCalls[0]?.options).toEqual({ timeoutMs: 2_000 });
    expect(spoolCalls).toHaveLength(1);
    expect(spoolCalls[0]?.sourceEventId).toBe(buildObservationSourceEventId({
      projectId: 'project-test',
      contentSessionId: 'session-test',
      platformSource: 'codex',
      toolUseId: 'tool-use-test',
    }));
    expect((spoolCalls[0]?.payload as Record<string, unknown>).tool_use_id).toBe('tool-use-test');
    expect(workerFallbackCalls).toHaveLength(0);
    expect(replayCalls).toEqual([{ options: { timeoutMs: 1_000 } }]);
  });

  it.each([408, 425, 429, 503])('spools transient HTTP %s responses', async (status) => {
    recordEventError = new ServerBetaClientError('http_error', `HTTP ${status}`, { status });

    const result = await observationHandler.execute(input('codex'));

    expect(result).toMatchObject({ continue: true, exitCode: 0 });
    expect(spoolCalls).toHaveLength(1);
    expect(workerFallbackCalls).toHaveLength(0);
  });

  it('does not spool a permanent client error', async () => {
    recordEventError = new ServerBetaClientError('http_error', 'HTTP 400', { status: 400 });

    const result = await observationHandler.execute(input('codex'));

    expect(result).toMatchObject({ continue: true, exitCode: 0 });
    expect(spoolCalls).toHaveLength(0);
    expect(workerFallbackCalls).toHaveLength(0);
  });

  it('reuses one generated identity for initial send and spool when a platform has no native id', async () => {
    recordEventError = new ServerBetaClientError('timeout', 'server request timed out');
    const withoutNativeId = { ...input('claude-code'), toolUseId: undefined };

    await observationHandler.execute(withoutNativeId);

    expect(recordEventCalls).toHaveLength(1);
    expect(spoolCalls).toHaveLength(1);
    expect(recordEventCalls[0]?.event.sourceEventId).toMatch(/^hook:[a-f0-9]{64}$/);
    expect(spoolCalls[0]?.sourceEventId).toBe(recordEventCalls[0]?.event.sourceEventId);
  });

  it('stays fail-open across more than the worker fail-loud threshold', async () => {
    recordEventError = new ServerBetaClientError('transport', 'server unavailable');
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await observationHandler.execute(input('codex'));
        expect(result).toMatchObject({ continue: true, exitCode: 0 });
      }
    } finally {
      process.exit = originalExit;
    }

    expect(spoolCalls).toHaveLength(4);
    expect(workerFallbackCalls).toHaveLength(0);
  });

  it('bounds Codex worker-runtime delivery without changing Claude worker behavior', async () => {
    selectedRuntime = { runtime: 'worker' };

    await observationHandler.execute(input('codex'));
    expect(workerFallbackCalls).toEqual([{
      options: { timeoutMs: 2_000, skipEnsure: true, failOpen: true },
    }]);

    workerFallbackCalls.length = 0;
    await observationHandler.execute(input('claude-code'));
    expect(workerFallbackCalls).toEqual([{ options: undefined }]);
  });
});
