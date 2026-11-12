import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearTimelinePending,
  markTimelinePending,
  takeTimelinePending,
} from '../../src/shared/codex-compaction-gate.js';

describe('codex-compaction-gate', () => {
  let dataDir: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-compaction-gate-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('hands each thread marker to exactly one taker', () => {
    markTimelinePending('session', 'agent-a');
    markTimelinePending('session', 'agent-b');
    expect(takeTimelinePending('session', 'agent-a')).toBe(true);
    expect(takeTimelinePending('session', 'agent-a')).toBe(false);
    expect(takeTimelinePending('session', 'agent-b')).toBe(true);
  });

  it('lets SessionStart clear only the matching thread', () => {
    markTimelinePending('session', undefined);
    markTimelinePending('session', 'agent-a');
    clearTimelinePending('session', undefined);
    expect(takeTimelinePending('session', undefined)).toBe(false);
    expect(takeTimelinePending('session', 'agent-a')).toBe(true);
  });

  it('hashes hostile ids instead of escaping the gate directory', () => {
    markTimelinePending('../../session', '../../agent');
    const entries = readdirSync(join(dataDir, 'state', 'codex-compaction-pending'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toStartWith('sha256-');
  });
});
