import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { buildStatusOutput, StatusOutput } from '../../src/services/worker-service.js';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');

function runWorkerStart(): { stdout: string; exitCode: number } {
  const result = spawnSync('bun', [WORKER_SCRIPT, 'start'], {
    encoding: 'utf-8',
    timeout: 60000
  });
  return { stdout: result.stdout?.trim() || '', exitCode: result.status || 0 };
}

describe('worker-json-status', () => {
  describe('buildStatusOutput', () => {
    it('returns only Codex-supported SessionStart fields when ready', () => {
      const result: StatusOutput = buildStatusOutput('ready');

      expect(result).toEqual({ continue: true, suppressOutput: true });
      expect('status' in result).toBe(false);
      expect('message' in result).toBe(false);
    });

    it('routes readiness details through systemMessage', () => {
      expect(buildStatusOutput('ready', 'Worker started; still warming up')).toEqual({
        continue: true,
        suppressOutput: true,
        systemMessage: 'Worker started; still warming up'
      });
    });

    it('routes failures through systemMessage without custom fields', () => {
      expect(buildStatusOutput('error', 'Port in use but worker not responding')).toEqual({
        continue: true,
        suppressOutput: true,
        systemMessage: 'Port in use but worker not responding'
      });
      expect(buildStatusOutput('error').systemMessage).toBe('Failed to start claude-mem worker');
    });

    it('serializes to a valid hook response', () => {
      const parsed = JSON.parse(JSON.stringify(buildStatusOutput('ready')));
      expect(parsed).toEqual({ continue: true, suppressOutput: true });
    });
  });

  describe('start command JSON output', () => {
    describe('when worker already healthy', () => {
      it('should output valid SessionStart JSON', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout, exitCode } = runWorkerStart();

        expect(exitCode).toBe(0);

        expect(() => JSON.parse(stdout)).not.toThrow();

        const parsed = JSON.parse(stdout);

        expect(parsed.continue).toBe(true);
        expect(parsed.suppressOutput).toBe(true);
        expect('status' in parsed).toBe(false);
        expect('message' in parsed).toBe(false);
      });

      it('should use only standard hook response fields', () => {
        if (!existsSync(WORKER_SCRIPT)) {
          console.log('Skipping CLI test - worker script not built');
          return;
        }

        const { stdout } = runWorkerStart();
        const parsed = JSON.parse(stdout);

        expect(parsed.continue).toBe(true);
        expect(parsed.suppressOutput).toBe(true);
        expect(Object.keys(parsed).every((key) =>
          ['continue', 'suppressOutput', 'systemMessage'].includes(key)
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

  describe('Claude Code and Codex hook framework compatibility', () => {
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

      const result = spawnSync('bun', [WORKER_SCRIPT, 'start'], {
        encoding: 'utf-8',
        timeout: 60000
      });

      const stdout = result.stdout?.trim() || '';
      const stderr = result.stderr?.trim() || '';

      expect(() => JSON.parse(stdout)).not.toThrow();

      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('continue');
      expect(parsed).not.toHaveProperty('status');
      expect(parsed).not.toHaveProperty('message');

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

    it('should not include custom status fields rejected by Codex', () => {
      if (!existsSync(WORKER_SCRIPT)) {
        console.log('Skipping CLI test - worker script not built');
        return;
      }

      const { stdout } = runWorkerStart();
      const parsed = JSON.parse(stdout);

      expect(parsed).not.toHaveProperty('status');
      expect(parsed).not.toHaveProperty('message');
    });
  });
});
