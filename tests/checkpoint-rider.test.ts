import { describe, it, expect } from 'bun:test';
import {
  decideCheckpoint,
  checkpointKey,
  observationGenerationKey,
  buildCheckpointRider,
  getCheckpointConfig,
  advanceCheckpoint,
  EMPTY_CHECKPOINT_STATE,
  readCheckpointState,
  writeCheckpointState,
  selfAuthorTags,
} from '../src/shared/self-author';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('decideCheckpoint', () => {
  it('injects a rider when realtime on, threshold met, cooldown satisfied, tool available', () => {
    const decision = decideCheckpoint({
      realtimeEnabled: true,
      substantiveCount: 4,
      threshold: 4,
      promptsSinceLastRider: 2,
      cooldownPrompts: 2,
      saveObservationAvailable: true,
    });
    expect(decision.injectRider).toBe(true);
  });

  const base = {
    realtimeEnabled: true,
    substantiveCount: 4,
    threshold: 4,
    promptsSinceLastRider: 2,
    cooldownPrompts: 2,
    saveObservationAvailable: true,
  };

  it('does not inject when realtime is disabled', () => {
    expect(decideCheckpoint({ ...base, realtimeEnabled: false }).injectRider).toBe(false);
  });

  it('does not inject below the substantive threshold', () => {
    expect(decideCheckpoint({ ...base, substantiveCount: 3 }).injectRider).toBe(false);
  });

  it('does not inject while in cooldown (too few prompts since last rider)', () => {
    expect(decideCheckpoint({ ...base, promptsSinceLastRider: 1 }).injectRider).toBe(false);
  });

  it('does not inject when save_observation is unavailable', () => {
    expect(decideCheckpoint({ ...base, saveObservationAvailable: false }).injectRider).toBe(false);
  });
});

describe('checkpoint generation keys (deterministic, idempotent)', () => {
  it('builds a checkpoint key from session id and sequence', () => {
    expect(checkpointKey('sess-abc', 3)).toBe('selfauthor:sess-abc:3');
  });

  it('builds a per-observation generation key by appending the index', () => {
    expect(observationGenerationKey('selfauthor:sess-abc:3', 0)).toBe('selfauthor:sess-abc:3:0');
  });
});

describe('getCheckpointConfig', () => {
  it('is off by default (realtime disabled when the flag is absent)', () => {
    expect(getCheckpointConfig({}).realtimeEnabled).toBe(false);
  });

  it('enables realtime only on the explicit "true" flag', () => {
    expect(getCheckpointConfig({ CLAUDE_MEM_SELF_AUTHOR_REALTIME: 'true' }).realtimeEnabled).toBe(true);
  });

  it('defaults cooldown to 2 prompts and max observations to 3', () => {
    const cfg = getCheckpointConfig({});
    expect(cfg.cooldownPrompts).toBe(2);
    expect(cfg.maxObsPerCheckpoint).toBe(3);
  });

  it('parses a custom cooldown', () => {
    expect(getCheckpointConfig({ CLAUDE_MEM_SELF_AUTHOR_COOLDOWN_PROMPTS: '5' }).cooldownPrompts).toBe(5);
  });
});

describe('advanceCheckpoint (per-prompt state transition)', () => {
  const open = {
    sessionId: 'sess-abc',
    substantiveCount: 4,
    threshold: 4,
    realtimeEnabled: true,
    cooldownPrompts: 2,
    saveObservationAvailable: true,
  };

  it('bumps the prompt counter and emits no rider when the gate is closed', () => {
    const r = advanceCheckpoint(EMPTY_CHECKPOINT_STATE, { ...open, realtimeEnabled: false });
    expect(r.rider).toBeNull();
    expect(r.state.promptsSinceLastRider).toBe(1);
    expect(r.state.lastCheckpointSeq).toBe(0);
  });

  it('emits a rider, advances the sequence, resets cooldown, and sets the pending key', () => {
    const r = advanceCheckpoint({ lastCheckpointSeq: 0, promptsSinceLastRider: 1, pendingCheckpointKey: null }, open);
    expect(r.rider).toContain('selfauthor:sess-abc:1');
    expect(r.state.lastCheckpointSeq).toBe(1);
    expect(r.state.promptsSinceLastRider).toBe(0);
    expect(r.state.pendingCheckpointKey).toBe('selfauthor:sess-abc:1');
  });

  it('increments the sequence on the next checkpoint', () => {
    const r = advanceCheckpoint({ lastCheckpointSeq: 1, promptsSinceLastRider: 1, pendingCheckpointKey: 'selfauthor:sess-abc:1' }, open);
    expect(r.state.lastCheckpointSeq).toBe(2);
    expect(r.rider).toContain('selfauthor:sess-abc:2');
  });
});

describe('selfAuthorTags (regime discriminator for §10)', () => {
  it('tags a checkpoint observation as regime C-prime with origin, key and host', () => {
    expect(selfAuthorTags('selfauthor:s:1', 'hyper')).toEqual({
      regime: 'C-prime',
      origin: 'self_author',
      checkpoint_key: 'selfauthor:s:1',
      host: 'hyper',
    });
  });

  it('tags a non-checkpoint (Stop) observation as regime C with host', () => {
    expect(selfAuthorTags(undefined, 'darkstar')).toEqual({ regime: 'C', host: 'darkstar' });
  });
});

describe('checkpoint sidecar state (per session, on disk)', () => {
  it('returns the empty state when no sidecar exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-state-'));
    try {
      expect(readCheckpointState('missing', dir)).toEqual(EMPTY_CHECKPOINT_STATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips written state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-state-'));
    try {
      const state = { lastCheckpointSeq: 2, promptsSinceLastRider: 0, pendingCheckpointKey: 'selfauthor:s:2' };
      writeCheckpointState('s', dir, state);
      expect(readCheckpointState('s', dir)).toEqual(state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCheckpointRider', () => {
  it('wraps a system-reminder carrying the checkpoint key and the save instruction', () => {
    const rider = buildCheckpointRider('selfauthor:sess-abc:3', 3);
    expect(rider).toContain('<system-reminder>');
    expect(rider).toContain('</system-reminder>');
    expect(rider).toContain('selfauthor:sess-abc:3');
    expect(rider).toContain('save_observation');
  });
});
