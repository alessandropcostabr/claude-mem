import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildStatusOutput } from '../../src/services/worker-service.js';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');
const WORKER_SOURCE = path.join(__dirname, '../../src/services/worker-service.ts');

let dataDir: string | null = null;

function runStart(extraArgs: string[] = []): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [WORKER_SCRIPT, 'start', ...extraArgs], {
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir!,
        CLAUDE_CONFIG_DIR: path.join(dataDir!, 'claude-config'),
        CLAUDE_MEM_CODEX_HOOK: '',
        // a port nothing listens on: if the command tried to start a worker it would spawn one
        CLAUDE_MEM_WORKER_PORT: '39733',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 8000);
    child.once('close', code => { clearTimeout(timeout); resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }); });
  });
}

beforeAll(() => {
  if (!existsSync(WORKER_SCRIPT)) return;
  dataDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-start-sb-'));
  mkdirSync(path.join(dataDir, 'claude-config'), { recursive: true });
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_RUNTIME: 'server-beta' }));
});

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('worker-service `start` in server-beta runtime', () => {
  it('reports ready without starting a local worker (no pid file, no SQLite database)', async () => {
    if (!dataDir) return; // bundle not built
    const result = await runStart();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(buildStatusOutput('ready'));
    expect(existsSync(path.join(dataDir, 'worker.pid'))).toBe(false);
    const created = readdirSync(dataDir).filter(name => name.startsWith('claude-mem.db'));
    expect(created).toEqual([]);
  });

  it('keeps an explicit override: `start --force` is not short-circuited by the runtime check', async () => {
    const src = await Bun.file(WORKER_SOURCE).text();
    const startCase = src.slice(src.indexOf("case 'start': {"), src.indexOf("case 'stop': {"));
    expect(startCase).toContain("selectRuntime() === 'server-beta'");
    expect(startCase).toContain("!commandArgs.includes('--force')");
    // the worker-starting call must come AFTER the server-beta short circuit
    expect(startCase.indexOf('ensureWorkerStarted(port)')).toBeGreaterThan(startCase.indexOf("exitWithStatus('ready')"));
  });
});
