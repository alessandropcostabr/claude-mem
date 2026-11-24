import { describe, it, expect, afterAll, beforeAll, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Capture the REAL modules BEFORE mocking (bun's mock.module is process-global and
// sticky; mock.restore() does not undo it), then re-register them in afterAll so
// this file cannot leak into later test files.
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

let runtimeSetting = 'server-beta';
const executeSpy = mock(async () => ({ observations: [], count: 0 }));

mock.module('../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => ({ CLAUDE_MEM_RUNTIME: runtimeSetting }),
}));
mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: executeSpy,
}));

import { fileContextHandler } from '../../src/cli/handlers/file-context.js';

let tmpDir: string;
let bigFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-sb-'));
  bigFile = join(tmpDir, 'big.ts');
  writeFileSync(bigFile, 'x'.repeat(4_000)); // above FILE_READ_GATE_MIN_BYTES
});

afterEach(() => {
  executeSpy.mockClear();
  runtimeSetting = 'server-beta';
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

function input(extra: Record<string, unknown> = {}): any {
  return { sessionId: 'sid', cwd: tmpDir, toolInput: { file_path: bigFile }, ...extra };
}

describe('fileContextHandler — server-beta runtime', () => {
  it('returns a quiet no-op and NEVER touches the local worker', async () => {
    runtimeSetting = 'server-beta';
    const result: any = await fileContextHandler.execute(input());
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('does not block or inject context even for a Codex filePaths array', async () => {
    runtimeSetting = 'server-beta';
    const result: any = await fileContextHandler.execute(input({ toolInput: { filePaths: [bigFile] } }));
    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('still consults the worker in worker runtime (the skip is runtime-specific)', async () => {
    runtimeSetting = 'worker';
    await fileContextHandler.execute(input());
    expect(executeSpy).toHaveBeenCalled();
  });
});
