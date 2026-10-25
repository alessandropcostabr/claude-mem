import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import {
  buildCodexSessionStartOutput,
  buildStatusOutput,
  prepareWorkerForHook,
  shouldEnsureWorkerBeforeHook,
  StatusOutput,
} from '../../src/services/worker-service.js';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');

function runWorkerStart(codex = false): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bun', [WORKER_SCRIPT, 'start'], {
    encoding: 'utf-8',
    timeout: 60000,
    env: codex ? { ...process.env, CLAUDE_MEM_CODEX_HOOK: '1' } : process.env,
  });
  return {
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || '',
    exitCode: result.status || 0,
  };
}

describe('worker-json-status', () => {
  describe('hook worker pre-start policy', () => {
    it('skips worker startup for every server-beta hook', () => {
      expect(shouldEnsureWorkerBeforeHook('claude-code', 'observation', 'server-beta')).toBe(false);
      expect(shouldEnsureWorkerBeforeHook('codex', 'context', 'server-beta')).toBe(false);
    });

    it('bounds Codex observation while preserving legacy worker recovery', async () => {
      expect(shouldEnsureWorkerBeforeHook('codex', 'observation', 'worker')).toBe(false);
      expect(shouldEnsureWorkerBeforeHook('claude-code', 'observation', 'worker')).toBe(true);
      expect(shouldEnsureWorkerBeforeHook('codex', 'context', 'worker')).toBe(true);

      const starts: number[] = [];
      const startWorker = async (port: number) => {
        starts.push(port);
        return 'ready' as const;
      };
      expect(await prepareWorkerForHook('codex', 'observation', 'worker', 39001, startWorker)).toBeNull();
      expect(await prepareWorkerForHook('claude-code', 'observation', 'worker', 39002, startWorker)).toBe('ready');
      expect(starts).toEqual([39002]);
    });
  });

  describe('buildStatusOutput', () => {
    it('preserves the Claude worker status contract', () => {
      const result: StatusOutput = buildStatusOutput('ready');

      expect(result).toEqual({ continue: true, status: 'ready', suppressOutput: true });
    });

    it('preserves Claude readiness details', () => {
      expect(buildStatusOutput('ready', 'Worker started; still warming up')).toEqual({
        continue: true,
        status: 'ready',
        message: 'Worker started; still warming up',
        suppressOutput: true,
      });
    });

    it('serializes the Claude status response', () => {
      const parsed = JSON.parse(JSON.stringify(buildStatusOutput('ready')));
      expect(parsed).toEqual({ continue: true, status: 'ready', suppressOutput: true });
    });
  });

  describe('Codex SessionStart compatibility', () => {
    it('returns only supported fields when ready', () => {
      expect(buildCodexSessionStartOutput('ready')).toEqual({ continue: true });
    });

    it('maps warming state to a fixed systemMessage', () => {
      const result = buildCodexSessionStartOutput('ready', 'raw warming diagnostic');
      expect(result).toEqual({
        continue: true,
        systemMessage: 'claude-mem worker is still warming up.',
      });
      expect(result.systemMessage).not.toContain('raw warming diagnostic');
    });

    it('maps failures to a fixed systemMessage without private fields', () => {
      const result = buildCodexSessionStartOutput('error', 'raw boot failure diagnostic');
      expect(result).toEqual({
        continue: true,
        systemMessage: 'claude-mem worker failed to start. Run npx claude-mem doctor.',
      });
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('message');
      expect(result).not.toHaveProperty('suppressOutput');
    });
  });

  describe('start command JSON output', () => {
    describe('when worker already healthy', () => {
      it('should output valid SessionStart JSON', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout, exitCode } = runWorkerStart(true);

        expect(exitCode).toBe(0);

        expect(() => JSON.parse(stdout)).not.toThrow();

        const parsed = JSON.parse(stdout);

        expect(parsed).toEqual({ continue: true });
      });

      it('should use only standard hook response fields', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout } = runWorkerStart(true);
        const parsed = JSON.parse(stdout);

        expect(parsed.continue).toBe(true);
        expect(Object.keys(parsed).every((key) =>
          ['continue', 'systemMessage'].includes(key)
        )).toBe(true);
      });
    });

    describe('error scenarios', () => {
      it.skip('should output JSON with status: error when port in use but not responding', () => {
        // Would require: start a non-worker server on the port, then call start
      });

      it.skip('should output JSON with status: error on spawn failure', () => {
        // Would require: mock spawnDaemon to fail
      });

      it.skip('should output JSON with status: error on health check timeout', () => {
        // Would require: start worker that never becomes healthy
      });
    });
  });

  describe('Claude Code hook compatibility', () => {
    it('should always exit with code 0', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { exitCode } = runWorkerStart();

      expect(exitCode).toBe(0);
    });

    it('should output JSON on stdout (not stderr)', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout, stderr } = runWorkerStart();

      expect(() => JSON.parse(stdout)).not.toThrow();

      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('continue');
      expect(parsed).toHaveProperty('status', 'ready');

      if (stderr) {
        try {
          const stderrParsed = JSON.parse(stderr);
          expect(stderrParsed).not.toHaveProperty('suppressOutput');
        } catch {
          // stderr is not JSON, which is expected (logs, etc.)
        }
      }
    });

    it('should be parseable as valid JSON', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();

      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(stdout);
      }).not.toThrow();

      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    });

    it('should always include continue: true (required for Claude Code to proceed)', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed.continue).toBe(true);

      expect(parsed.continue).toStrictEqual(true);
    });

    it('should include suppressOutput: true to hide from transcript mode', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed.suppressOutput).toBe(true);
    });

    it('Codex mode should not include private status fields', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart(true);
      const parsed = JSON.parse(stdout);

      expect(parsed).not.toHaveProperty('status');
      expect(parsed).not.toHaveProperty('message');
    });
  });
});
