// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerBetaEventSpool } from '../../src/services/hooks/server-beta-event-spool.js';
import {
  ServerBetaClientError,
  type ServerBetaRecordEventRequest,
} from '../../src/services/hooks/server-beta-client.js';

let directory = '';

const event = (): ServerBetaRecordEventRequest => ({
  projectId: 'project-test',
  contentSessionId: 'session-test',
  sourceEventId: 'tool-use-test',
  platformSource: 'codex',
  sourceType: 'hook',
  eventType: 'tool_use',
  occurredAtEpoch: 1234,
  payload: {
    tool_name: 'Bash',
    tool_use_id: 'tool-use-test',
  },
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'claude-mem-server-beta-spool-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('ServerBetaEventSpool', () => {
  it('deduplicates one local entry by sourceEventId and writes it privately', () => {
    const spool = new ServerBetaEventSpool(directory);
    const first = spool.enqueue(event());
    const second = spool.enqueue(event());

    expect(second).toBe(first);
    expect(spool.pendingCount()).toBe(1);
    const filenames = readdirSync(directory).filter(name => name.endsWith('.json'));
    expect(filenames).toHaveLength(1);
    const entryPath = join(directory, filenames[0]!);
    expect(statSync(entryPath).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(entryPath, 'utf8')) as {
      event: ServerBetaRecordEventRequest;
    };
    expect(stored.event.sourceEventId).toBe('tool-use-test');
    expect((stored.event.payload as Record<string, unknown>).tool_use_id).toBe('tool-use-test');
  });

  it('scopes a repeated tool id by session and platform', () => {
    const spool = new ServerBetaEventSpool(directory);
    spool.enqueue(event());
    spool.enqueue({ ...event(), contentSessionId: 'session-other' });

    expect(spool.pendingCount()).toBe(2);
  });

  it('deduplicates while the same entry has an active replay claim', async () => {
    const spool = new ServerBetaEventSpool(directory);
    const id = spool.enqueue(event());
    let releaseSend!: () => void;
    const sendBlocked = new Promise<void>((resolve) => { releaseSend = resolve; });

    const replay = spool.replayOne(async () => sendBlocked, { timeoutMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(readdirSync(directory).some(name => name.includes(`${id}.json.sending-`))).toBe(true);

    expect(spool.enqueue(event())).toBe(id);
    expect(spool.pendingCount()).toBe(1);
    releaseSend();
    expect((await replay).status).toBe('replayed');
    expect(spool.pendingCount()).toBe(0);
  });

  it('restores a failed claim and removes it only after a successful replay', async () => {
    const spool = new ServerBetaEventSpool(directory);
    spool.enqueue(event());
    const replayed: ServerBetaRecordEventRequest[] = [];

    const deferred = await spool.replayOne(async () => {
      throw new Error('server unavailable');
    }, { timeoutMs: 1_000 });
    expect(deferred.status).toBe('deferred');
    expect(spool.pendingCount()).toBe(1);

    const success = await spool.replayOne(async (queued, options) => {
      replayed.push(queued);
      expect(options).toEqual({ timeoutMs: 1_000 });
    }, { timeoutMs: 1_000 });

    expect(success.status).toBe('replayed');
    expect(spool.pendingCount()).toBe(0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.sourceEventId).toBe('tool-use-test');
  });

  it('processes at most one corrupt or permanently rejected entry per hook', async () => {
    const spool = new ServerBetaEventSpool(directory);
    spool.enqueue(event());
    const corrupt = readdirSync(directory).find(name => name.endsWith('.json'))!;
    writeFileSync(join(directory, corrupt), '{not-json', { mode: 0o600 });
    const old = new Date(Date.now() - 2_000);
    utimesSync(join(directory, corrupt), old, old);

    const valid = { ...event(), contentSessionId: 'session-valid', sourceEventId: 'tool-valid' };
    spool.enqueue(valid);
    const replayed: string[] = [];
    const quarantined = await spool.replayOne(async queued => {
      replayed.push(queued.sourceEventId!);
    }, { timeoutMs: 1_000 });

    expect(quarantined).toEqual(expect.objectContaining({ status: 'quarantined' }));
    expect(replayed).toEqual([]);
    expect(readdirSync(join(directory, 'quarantine'))).toHaveLength(1);
    expect((await spool.replayOne(async queued => {
      replayed.push(queued.sourceEventId!);
    }, { timeoutMs: 1_000 })).status).toBe('replayed');
    expect(replayed).toEqual(['tool-valid']);

    const rejected = { ...event(), contentSessionId: 'session-rejected', sourceEventId: 'tool-rejected' };
    const after = { ...event(), contentSessionId: 'session-after', sourceEventId: 'tool-after' };
    const rejectedId = spool.enqueue(rejected);
    spool.enqueue(after);
    utimesSync(join(directory, `${rejectedId}.json`), old, old);
    const delivered: string[] = [];
    const permanent = await spool.replayOne(async queued => {
      if (queued.sourceEventId === 'tool-rejected') {
        throw new ServerBetaClientError('http_error', 'bad request', { status: 400 });
      }
      delivered.push(queued.sourceEventId!);
    }, { timeoutMs: 1_000 });

    expect(permanent.status).toBe('quarantined');
    expect(delivered).toEqual([]);
    expect(readdirSync(join(directory, 'quarantine'))).toHaveLength(2);
    expect((await spool.replayOne(async queued => {
      delivered.push(queued.sourceEventId!);
    }, { timeoutMs: 1_000 })).status).toBe('replayed');
    expect(delivered).toEqual(['tool-after']);
  });

  it('refreshes an old pending timestamp when claiming so active sends are not recovered', async () => {
    const spool = new ServerBetaEventSpool(directory);
    const id = spool.enqueue(event());
    const pending = join(directory, `${id}.json`);
    const old = new Date(Date.now() - 31_000);
    utimesSync(pending, old, old);

    let releaseSend!: () => void;
    const sendBlocked = new Promise<void>((resolve) => { releaseSend = resolve; });
    const replay = spool.replayOne(async () => sendBlocked, { timeoutMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 10));

    const claim = readdirSync(directory).find(name => name.includes(`${id}.json.sending-`));
    expect(claim).toBeDefined();
    expect(Date.now() - statSync(join(directory, claim!)).mtimeMs).toBeLessThan(5_000);
    expect(spool.pendingCount()).toBe(1);
    expect(readdirSync(directory).some(name => name === `${id}.json`)).toBe(false);

    releaseSend();
    expect((await replay).status).toBe('replayed');
  });

  it('bounds poison processing to one entry even with a backlog', async () => {
    const spool = new ServerBetaEventSpool(directory, { maxPendingEntries: 8 });
    const corruptId = spool.enqueue(event());
    writeFileSync(join(directory, `${corruptId}.json`), '{broken', { mode: 0o600 });
    const old = new Date(Date.now() - 2_000);
    utimesSync(join(directory, `${corruptId}.json`), old, old);
    for (let index = 0; index < 5; index += 1) {
      spool.enqueue({
        ...event(),
        contentSessionId: `session-${index}`,
        sourceEventId: `tool-${index}`,
      });
    }

    let sends = 0;
    const started = performance.now();
    const result = await spool.replayOne(async () => { sends += 1; }, { timeoutMs: 1_000 });

    expect(result.status).toBe('quarantined');
    expect(sends).toBe(0);
    expect(spool.pendingCount()).toBe(5);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('recovers stale claims and enforces private directory permissions', async () => {
    chmodSync(directory, 0o755);
    const spool = new ServerBetaEventSpool(directory);
    const id = spool.enqueue(event());
    expect(statSync(directory).mode & 0o777).toBe(0o700);

    const pending = join(directory, `${id}.json`);
    const claim = `${pending}.sending-999-aabb`;
    renameSync(pending, claim);
    const old = new Date(Date.now() - 31_000);
    utimesSync(claim, old, old);

    const sent: string[] = [];
    const result = await spool.replayOne(async queued => {
      sent.push(queued.sourceEventId!);
    }, { timeoutMs: 1_000 });
    expect(result.status).toBe('replayed');
    expect(sent).toEqual(['tool-use-test']);
  });

  it('rejects a symlink spool directory', () => {
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    const spool = new ServerBetaEventSpool(link);
    expect(() => spool.enqueue(event())).toThrow('not a real directory');
  });

  it('moves expired entries aside and refuses bounded-capacity overflow without deleting entries', () => {
    const spool = new ServerBetaEventSpool(directory, {
      retryWindowMs: 1_000,
      maxPendingEntries: 1,
      maxPendingBytes: 1024 * 1024,
    });
    const first = spool.enqueue(event());
    expect(() => spool.enqueue({
      ...event(),
      contentSessionId: 'session-overflow',
      sourceEventId: 'tool-overflow',
    })).toThrow('capacity exceeded');
    expect(spool.pendingCount()).toBe(1);

    const pending = join(directory, `${first}.json`);
    const old = new Date(Date.now() - 2_000);
    utimesSync(pending, old, old);
    expect(spool.pendingCount()).toBe(0);
    expect(readdirSync(join(directory, 'expired'))).toHaveLength(1);
  });

  it('expires quarantine and expired payload archives instead of retaining them indefinitely', async () => {
    let now = Date.now();
    const spool = new ServerBetaEventSpool(directory, {
      now: () => now,
      retryWindowMs: 1_000,
      archiveRetentionMs: 10_000,
    });

    const corruptId = spool.enqueue(event());
    writeFileSync(join(directory, `${corruptId}.json`), '{broken', { mode: 0o600 });
    expect((await spool.replayOne(async () => {}, { timeoutMs: 1_000 })).status).toBe('quarantined');
    const quarantine = join(directory, 'quarantine');
    expect(readdirSync(quarantine)).toHaveLength(1);

    const expiring = {
      ...event(),
      contentSessionId: 'session-expiring',
      sourceEventId: 'tool-expiring',
    };
    const expiringId = spool.enqueue(expiring);
    const old = new Date(now - 2_000);
    utimesSync(join(directory, `${expiringId}.json`), old, old);
    expect(spool.pendingCount()).toBe(0);
    const expired = join(directory, 'expired');
    expect(readdirSync(expired)).toHaveLength(1);

    now += 20_000;
    for (const archived of readdirSync(quarantine)) utimesSync(join(quarantine, archived), old, old);
    for (const archived of readdirSync(expired)) utimesSync(join(expired, archived), old, old);
    spool.enqueue({ ...event(), contentSessionId: 'session-trigger', sourceEventId: 'tool-trigger' });

    expect(readdirSync(quarantine)).toHaveLength(0);
    expect(readdirSync(expired)).toHaveLength(0);
  });

  it('serializes capacity checks across processes so a one-item queue cannot overflow', async () => {
    const moduleUrl = new URL('../../src/services/hooks/server-beta-event-spool.ts', import.meta.url).href;
    const script = `
      import { ServerBetaEventSpool } from ${JSON.stringify(moduleUrl)};
      const spool = new ServerBetaEventSpool(process.env.SPOOL_DIR, { maxPendingEntries: 1 });
      try {
        spool.enqueue({
          projectId: 'project-test', contentSessionId: process.env.EVENT_ID,
          sourceEventId: process.env.EVENT_ID, platformSource: 'codex',
          sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: 1234,
          payload: { tool_name: 'Bash', tool_use_id: process.env.EVENT_ID },
        });
        console.log('queued');
      } catch { console.log('rejected'); }
    `;
    const children = ['race-a', 'race-b'].map(eventId => Bun.spawn(
      [process.execPath, '-e', script],
      {
        env: { ...process.env, SPOOL_DIR: directory, EVENT_ID: eventId },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ));
    await Promise.all(children.map(child => child.exited));
    const outputs = await Promise.all(children.map(child => new Response(child.stdout).text()));

    expect(outputs.filter(output => output.trim() === 'queued')).toHaveLength(1);
    expect(outputs.filter(output => output.trim() === 'rejected')).toHaveLength(1);
    expect(new ServerBetaEventSpool(directory, { maxPendingEntries: 1 }).pendingCount()).toBe(1);
  });

  it('bounds quarantine retention by entry count', async () => {
    const spool = new ServerBetaEventSpool(directory, { maxArchiveEntries: 1 });
    for (let index = 0; index < 2; index += 1) {
      const queued = {
        ...event(),
        contentSessionId: `session-corrupt-${index}`,
        sourceEventId: `tool-corrupt-${index}`,
      };
      const id = spool.enqueue(queued);
      writeFileSync(join(directory, `${id}.json`), '{broken', { mode: 0o600 });
      expect((await spool.replayOne(async () => {}, { timeoutMs: 1_000 })).status).toBe('quarantined');
    }

    expect(readdirSync(join(directory, 'quarantine'))).toHaveLength(1);
  });

  it('refuses an entry that would exceed the byte budget', () => {
    const spool = new ServerBetaEventSpool(directory, { maxPendingBytes: 1 });
    expect(() => spool.enqueue(event())).toThrow('capacity exceeded');
    expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toHaveLength(0);
  });

  it('counts interrupted temporary writes against queue capacity', () => {
    const temporary = join(directory, `.${'a'.repeat(64)}.999.aabb.tmp`);
    writeFileSync(temporary, 'interrupted payload', { mode: 0o600 });
    const spool = new ServerBetaEventSpool(directory, { maxPendingEntries: 1 });

    expect(() => spool.enqueue(event())).toThrow('capacity exceeded');
    expect(readdirSync(directory)).toContain(`.${'a'.repeat(64)}.999.aabb.tmp`);
  });

  it('removes stale interrupted temporary writes before accepting new work', () => {
    const temporaryName = `.${'b'.repeat(64)}.999.aabb.tmp`;
    const temporary = join(directory, temporaryName);
    writeFileSync(temporary, 'interrupted payload', { mode: 0o600 });
    const old = new Date(Date.now() - 31_000);
    utimesSync(temporary, old, old);
    const spool = new ServerBetaEventSpool(directory, { maxPendingEntries: 1 });

    spool.enqueue(event());

    expect(readdirSync(directory)).not.toContain(temporaryName);
    expect(spool.pendingCount()).toBe(1);
  });

  it('rejects an invalid event before writing it', () => {
    const spool = new ServerBetaEventSpool(directory);
    expect(() => spool.enqueue({ ...event(), projectId: '' })).toThrow('invalid server-beta event');
    expect(spool.pendingCount()).toBe(0);
  });
});
