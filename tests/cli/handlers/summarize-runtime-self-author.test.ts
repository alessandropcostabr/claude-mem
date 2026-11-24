import { describe, expect, it } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import {
  consumeCheckpointRiderAtStopEntry,
  shouldSuppressStopSelfAuthor,
} from '../../../src/cli/handlers/summarize.js';
import { invalidatePreviousCheckpointRider } from '../../../src/cli/handlers/session-init.js';
import {
  consumeCheckpointRiderEmission,
  decideSelfAuthor,
  markCheckpointRiderEmitted,
  recordSubstantiveEvent,
  getSubstantiveCount,
} from '../../../src/shared/self-author.js';

describe('Stop self-author runtime gating', () => {
  it('keeps Stop self-authoring enabled in worker runtime', () => {
    expect(shouldSuppressStopSelfAuthor(true, 'worker', true)).toBe(false);
  });

  it('suppresses Stop self-authoring only when server-beta emitted a rider', () => {
    expect(shouldSuppressStopSelfAuthor(true, 'server-beta', true)).toBe(true);
    expect(shouldSuppressStopSelfAuthor(true, 'server-beta', false)).toBe(false);
  });

  it('does not suppress Stop self-authoring when realtime mode is off', () => {
    expect(shouldSuppressStopSelfAuthor(false, 'server-beta', true)).toBe(false);
  });
});

describe('checkpoint rider emission marker', () => {
  const markerSettings = (dataDir: string) => ({
    CLAUDE_MEM_DATA_DIR: dataDir,
    CLAUDE_MEM_SELF_AUTHOR_ENABLED: 'true',
    CLAUDE_MEM_SELF_AUTHOR_THRESHOLD: '1',
  }) as any;

  it('is private and consumed exactly once by the next Stop', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-emitted-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      expect(markCheckpointRiderEmitted('session/with traversal', stateDir)).toBe(true);
      const markerDir = join(stateDir, 'rider-emitted');
      expect(statSync(markerDir).mode & 0o777).toBe(0o700);
      const files = readdirSync(markerDir);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain('session');
      expect(statSync(join(markerDir, files[0]!)).mode & 0o777).toBe(0o600);
      expect(consumeCheckpointRiderEmission('session/with traversal', stateDir)).toBe(true);
      expect(consumeCheckpointRiderEmission('session/with traversal', stateDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('leaves Stop fallback available when session-init emitted no rider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-missing-'));
    try {
      expect(consumeCheckpointRiderEmission('session', join(dataDir, 'self-author'))).toBe(false);
      expect(shouldSuppressStopSelfAuthor(true, 'server-beta', false)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not cover activity from a later interval after the marker is consumed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-interval-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      expect(markCheckpointRiderEmitted('session', stateDir)).toBe(true);
      expect(consumeCheckpointRiderEmission('session', stateDir)).toBe(true);
      recordSubstantiveEvent('session', stateDir);
      expect(getSubstantiveCount('session', stateDir)).toBe(1);
      expect(consumeCheckpointRiderEmission('session', stateDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('acknowledges only the emitted baseline and preserves later activity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-baseline-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 3)).toBe(true);
      for (let index = 0; index < 2; index += 1) recordSubstantiveEvent('session', stateDir);

      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(true);
      expect(getSubstantiveCount('session', stateDir)).toBe(2);
      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('invalidates an unconsumed previous marker when the next prompt starts', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-next-prompt-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      // The response carrying this rider was interrupted and emitted no Stop.
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 3)).toBe(true);

      // A later prompt starts, but does not emit a replacement rider.
      expect(invalidatePreviousCheckpointRider('session', settings)).toBe(true);

      const consumedAtStop = consumeCheckpointRiderAtStopEntry('session', settings);
      expect(consumedAtStop).toBe(false);
      expect(shouldSuppressStopSelfAuthor(true, 'server-beta', consumedAtStop)).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(3);
      expect(decideSelfAuthor({
        enabled: true,
        stopHookActive: false,
        substantiveCount: 3,
        threshold: 1,
        realtimeEnabled: false,
      }).block).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails open on a corrupt or legacy marker without acknowledging activity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-corrupt-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 1)).toBe(true);
      const markerDir = join(stateDir, 'rider-emitted');
      const marker = readdirSync(markerDir).find((name) => name.endsWith('.marker'))!;
      writeFileSync(join(markerDir, marker), '1\n');

      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(1);
      expect(consumeCheckpointRiderEmission('session', stateDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails open when the persisted baseline cannot be acknowledged', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-invalid-baseline-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 2)).toBe(true);

      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves increments racing with baseline acknowledgement', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-concurrent-count-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    const laterEvents = 2_000;
    try {
      for (let index = 0; index < 50; index += 1) recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 50)).toBe(true);

      const moduleUrl = pathToFileURL(resolve('src/shared/self-author.ts')).href;
      const script = [
        `import { recordSubstantiveEvent } from ${JSON.stringify(moduleUrl)};`,
        `for (let index = 0; index < ${laterEvents}; index += 1) recordSubstantiveEvent('session', ${JSON.stringify(stateDir)});`,
      ].join('\n');
      const writer = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });

      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(true);
      const [exitCode, stderr] = await Promise.all([
        writer.exited,
        new Response(writer.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(getSubstantiveCount('session', stateDir)).toBe(laterEvents);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('preserves an append through an fd opened before baseline acknowledgement', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-open-fd-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    let fd: number | null = null;
    try {
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      expect(markCheckpointRiderEmitted('session', stateDir, 3)).toBe(true);
      fd = openSync(join(stateDir, 'session.count'), 'a');

      expect(consumeCheckpointRiderAtStopEntry('session', settings)).toBe(true);
      writeSync(fd, '1\n');
      closeSync(fd);
      fd = null;

      expect(getSubstantiveCount('session', stateDir)).toBe(1);
    } finally {
      if (fd !== null) closeSync(fd);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores an interrupted temp offset until its atomic rename commits', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-ack-crash-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      const ack = join(stateDir, 'session.count.ack');
      const temp = `${ack}.tmp`;

      // Crash after the temp write but before rename: canonical state is old.
      writeFileSync(temp, '2\n', { mode: 0o600 });
      expect(getSubstantiveCount('session', stateDir)).toBe(3);

      // A later acknowledge owns and replaces the stale temp atomically.
      expect(markCheckpointRiderEmitted('session', stateDir, 2)).toBe(true);
      expect(consumeCheckpointRiderAtStopEntry('session', markerSettings(dataDir))).toBe(true);
      expect(readFileSync(ack, 'utf8')).toBe('2\n');
      expect(existsSync(temp)).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent baseline acknowledgements without hiding extra events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-concurrent-ack-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      const moduleUrl = pathToFileURL(resolve('src/shared/self-author.ts')).href;
      const script = [
        `import { acknowledgeSubstantiveBaseline } from ${JSON.stringify(moduleUrl)};`,
        `process.stdout.write(acknowledgeSubstantiveBaseline('session', ${JSON.stringify(stateDir)}, 2) ? '1' : '0');`,
      ].join('\n');
      const writers = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      }));
      const results = await Promise.all(writers.map(async (writer) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          writer.exited,
          new Response(writer.stdout).text(),
          new Response(writer.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        return stdout;
      }));

      expect(results.filter((result) => result === '1')).toHaveLength(1);
      expect(getSubstantiveCount('session', stateDir)).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails open on a corrupt acknowledgement offset', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-corrupt-ack-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      for (let index = 0; index < 3; index += 1) recordSubstantiveEvent('session', stateDir);
      writeFileSync(join(stateDir, 'session.count.ack'), 'not-an-offset\n', { mode: 0o600 });

      expect(getSubstantiveCount('session', stateDir)).toBe(3);
      expect(markCheckpointRiderEmitted('session', stateDir, 2)).toBe(true);
      expect(consumeCheckpointRiderAtStopEntry('session', markerSettings(dataDir))).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(3);

      // A syntactically valid but impossible offset is also fail-open.
      const ack = join(stateDir, 'session.count.ack');
      writeFileSync(ack, '99\n', { mode: 0o600 });
      expect(getSubstantiveCount('session', stateDir)).toBe(3);
      expect(existsSync(ack)).toBe(false);
      recordSubstantiveEvent('session', stateDir);
      expect(getSubstantiveCount('session', stateDir)).toBe(4);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails open on an active ack lock and recovers it when stale', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-ack-lock-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      for (let index = 0; index < 2; index += 1) recordSubstantiveEvent('session', stateDir);
      const lock = join(stateDir, 'session.count.ack.lock');
      writeFileSync(lock, 'active-owner', { flag: 'wx', mode: 0o600 });

      expect(markCheckpointRiderEmitted('session', stateDir, 2)).toBe(true);
      expect(consumeCheckpointRiderAtStopEntry('session', markerSettings(dataDir))).toBe(false);
      expect(getSubstantiveCount('session', stateDir)).toBe(2);

      const stale = new Date(Date.now() - 31_000);
      utimesSync(lock, stale, stale);
      expect(markCheckpointRiderEmitted('session', stateDir, 2)).toBe(true);
      expect(consumeCheckpointRiderAtStopEntry('session', markerSettings(dataDir))).toBe(true);
      expect(getSubstantiveCount('session', stateDir)).toBe(0);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('consumes marker evidence even when runtime or realtime changed before Stop', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-config-change-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      expect(markCheckpointRiderEmitted('runtime-change', stateDir)).toBe(true);
      const runtimeChanged = consumeCheckpointRiderAtStopEntry('runtime-change', settings);
      expect(runtimeChanged).toBe(true);
      expect(shouldSuppressStopSelfAuthor(true, 'worker', runtimeChanged)).toBe(false);
      expect(consumeCheckpointRiderEmission('runtime-change', stateDir)).toBe(false);

      expect(markCheckpointRiderEmitted('realtime-off', stateDir)).toBe(true);
      const realtimeOff = consumeCheckpointRiderAtStopEntry('realtime-off', settings);
      expect(realtimeOff).toBe(true);
      expect(shouldSuppressStopSelfAuthor(false, 'server-beta', realtimeOff)).toBe(false);
      expect(consumeCheckpointRiderEmission('realtime-off', stateDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('consumes marker evidence before excluded-project and other early-return guards', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-early-return-'));
    const stateDir = join(dataDir, 'self-author');
    const settings = markerSettings(dataDir);
    try {
      expect(markCheckpointRiderEmitted('excluded', stateDir)).toBe(true);
      // summarizeHandler calls this entry helper before shouldTrackProject,
      // stopHookActive, subagent, transcript, and empty-message guards.
      expect(consumeCheckpointRiderAtStopEntry('excluded', settings)).toBe(true);
      expect(consumeCheckpointRiderEmission('excluded', stateDir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('invalidates the prior interval at the real UserPromptSubmit entry before exclusion', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-prompt-entry-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      const selfAuthorUrl = pathToFileURL(resolve('src/shared/self-author.ts')).href;
      const handlerUrl = pathToFileURL(resolve('src/cli/handlers/session-init.ts')).href;
      const script = [
        `const selfAuthor = await import(${JSON.stringify(selfAuthorUrl)});`,
        `const { sessionInitHandler } = await import(${JSON.stringify(handlerUrl)});`,
        `selfAuthor.markCheckpointRiderEmitted('session', ${JSON.stringify(stateDir)});`,
        `await sessionInitHandler.execute({ sessionId: 'session', cwd: '/tmp/cm-excluded-project', platform: 'claude-code', prompt: 'next prompt' });`,
        `process.stdout.write('RESULT:' + String(selfAuthor.consumeCheckpointRiderEmission('session', ${JSON.stringify(stateDir)})));`,
      ].join('\n');
      const child = Bun.spawn([process.execPath, '-e', script], {
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_EXCLUDED_PROJECTS: '/tmp/cm-excluded-project',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('RESULT:false');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('consumes the interval at the real Stop entry before exclusion', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-stop-entry-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      const selfAuthorUrl = pathToFileURL(resolve('src/shared/self-author.ts')).href;
      const handlerUrl = pathToFileURL(resolve('src/cli/handlers/summarize.ts')).href;
      const script = [
        `const selfAuthor = await import(${JSON.stringify(selfAuthorUrl)});`,
        `const { summarizeHandler } = await import(${JSON.stringify(handlerUrl)});`,
        `selfAuthor.markCheckpointRiderEmitted('session', ${JSON.stringify(stateDir)});`,
        `await summarizeHandler.execute({ sessionId: 'session', cwd: '/tmp/cm-excluded-project', platform: 'claude-code' });`,
        `process.stdout.write('RESULT:' + String(selfAuthor.consumeCheckpointRiderEmission('session', ${JSON.stringify(stateDir)})));`,
      ].join('\n');
      const child = Bun.spawn([process.execPath, '-e', script], {
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_EXCLUDED_PROJECTS: '/tmp/cm-excluded-project',
          CLAUDE_MEM_SELF_AUTHOR_REALTIME: 'false',
          CLAUDE_MEM_RUNTIME: 'worker',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('RESULT:false');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('fails open immediately while another writer holds the directory lock', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-lock-active-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      expect(markCheckpointRiderEmitted('seed', stateDir)).toBe(true);
      const markerDir = join(stateDir, 'rider-emitted');
      const lock = join(markerDir, '.rider-marker.lock');
      writeFileSync(lock, 'active-owner', { flag: 'wx', mode: 0o600 });

      const started = performance.now();
      expect(markCheckpointRiderEmitted('contended', stateDir)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(existsSync(lock)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('recovers a stale writer lock before creating the marker', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-lock-stale-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      expect(markCheckpointRiderEmitted('seed', stateDir)).toBe(true);
      const markerDir = join(stateDir, 'rider-emitted');
      const lock = join(markerDir, '.rider-marker.lock');
      writeFileSync(lock, 'dead-owner', { flag: 'wx', mode: 0o600 });
      const stale = new Date(Date.now() - 31_000);
      utimesSync(lock, stale, stale);

      expect(markCheckpointRiderEmitted('after-stale-lock', stateDir)).toBe(true);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the 256-marker cap under concurrent writers in separate processes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-rider-lock-cap-'));
    const stateDir = join(dataDir, 'self-author');
    try {
      for (let index = 0; index < 255; index += 1) {
        expect(markCheckpointRiderEmitted(`existing-${index}`, stateDir)).toBe(true);
      }

      const moduleUrl = pathToFileURL(resolve('src/shared/self-author.ts')).href;
      const writers = Array.from({ length: 16 }, (_, index) => {
        const script = [
          `import { markCheckpointRiderEmitted } from ${JSON.stringify(moduleUrl)};`,
          `process.stdout.write(markCheckpointRiderEmitted(${JSON.stringify(`writer-${index}`)}, ${JSON.stringify(stateDir)}) ? '1' : '0');`,
        ].join('\n');
        return Bun.spawn([process.execPath, '-e', script], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
      });

      const results = await Promise.all(writers.map(async (writer) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          writer.exited,
          new Response(writer.stdout).text(),
          new Response(writer.stderr).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        return stdout;
      }));

      const markerDir = join(stateDir, 'rider-emitted');
      const markers = readdirSync(markerDir).filter((name) => name.endsWith('.marker'));
      expect(results.filter((result) => result === '1')).toHaveLength(1);
      expect(markers).toHaveLength(256);
      expect(existsSync(join(markerDir, '.rider-marker.lock'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
});
