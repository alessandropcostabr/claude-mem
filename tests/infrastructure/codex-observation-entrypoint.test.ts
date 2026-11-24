// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dataDirectory = '';

afterEach(() => {
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
  dataDirectory = '';
});

describe('Codex PostToolUse worker-service entrypoint', () => {
  it('reaches the durable spool in under five seconds when no worker or server is available', () => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-codex-entrypoint-'));
    const workerSource = join(process.cwd(), 'src/services/worker-service.ts');
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [workerSource, 'hook', 'codex', 'observation'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'entrypoint-session',
        cwd: process.cwd(),
        tool_name: 'Bash',
        tool_input: { command: 'true' },
        tool_response: { stdout: '' },
        tool_use_id: 'entrypoint-tool-use',
      }),
      // Running the TypeScript source includes Bun transpilation overhead;
      // the production gate repeats this against the generated CJS bundle.
      timeout: 5_200,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDirectory,
        CLAUDE_MEM_RUNTIME: 'server-beta',
        CLAUDE_MEM_SERVER_BETA_URL: 'http://127.0.0.1:1',
        CLAUDE_MEM_SERVER_BETA_API_KEY: 'test-only-key',
        CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'entrypoint-project',
        CLAUDE_MEM_WORKER_PORT: '65530',
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ continue: true });
    const spoolDirectory = join(dataDirectory, 'state', 'server-beta-event-spool');
    expect(readdirSync(spoolDirectory).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });

  it.each([
    ['worker runtime', { CLAUDE_MEM_RUNTIME: 'worker' }],
    ['incomplete server-beta configuration', {
      CLAUDE_MEM_RUNTIME: 'server-beta',
      CLAUDE_MEM_SERVER_BETA_URL: 'http://127.0.0.1:1',
      CLAUDE_MEM_SERVER_BETA_API_KEY: '',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'entrypoint-project',
    }],
  ])('fails open in under five seconds with no worker for %s', (_name, runtimeEnv) => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-codex-worker-entrypoint-'));
    const workerSource = join(process.cwd(), 'src/services/worker-service.ts');
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [workerSource, 'hook', 'codex', 'observation'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 'worker-entrypoint-session',
        cwd: process.cwd(),
        tool_name: 'Bash',
        tool_input: { command: 'true' },
        tool_response: { stdout: '' },
        tool_use_id: 'worker-entrypoint-tool-use',
      }),
      timeout: 5_200,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDirectory,
        CLAUDE_MEM_WORKER_PORT: '65530',
        ...runtimeEnv,
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ continue: true });
  });
});
