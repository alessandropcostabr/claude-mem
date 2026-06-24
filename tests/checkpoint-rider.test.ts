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
  riderArm,
  parseCheckpointSessionId,
  decideSelfAuthor,
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

describe('decideSelfAuthor — Stop is transparent (non-blocking) when realtime is on', () => {
  const ready = { enabled: true, stopHookActive: false, substantiveCount: 10, threshold: 4 };

  it('blocks at Stop when realtime is OFF (classic C, threshold met)', () => {
    expect(decideSelfAuthor({ ...ready, realtimeEnabled: false }).block).toBe(true);
  });

  it('does NOT block at Stop when realtime is ON (the rider handles it — no red error)', () => {
    expect(decideSelfAuthor({ ...ready, realtimeEnabled: true }).block).toBe(false);
  });
});

describe('parseCheckpointSessionId (recover the content session id from a checkpoint key)', () => {
  it('extracts the session id from selfauthor:<sid>:<seq>', () => {
    expect(parseCheckpointSessionId('selfauthor:c1e6326c-449a-4005-81f3-4408d9bf2d34:1'))
      .toBe('c1e6326c-449a-4005-81f3-4408d9bf2d34');
  });

  it('returns null for a non-checkpoint or malformed key', () => {
    expect(parseCheckpointSessionId(undefined)).toBeNull();
    expect(parseCheckpointSessionId('garbage')).toBeNull();
  });
});

describe('selfAuthorTags (regime discriminator for §10)', () => {
  it('tags a checkpoint observation with the session arm, plus origin, key and host', () => {
    const expectedRegime = riderArm('s') === 'arc' ? 'C-prime-arc' : 'C-prime';
    expect(selfAuthorTags('selfauthor:s:1', 'hyper')).toEqual({
      regime: expectedRegime,
      origin: 'self_author',
      checkpoint_key: 'selfauthor:s:1',
      host: 'hyper',
    });
  });

  it('tags an arc-arm checkpoint as C-prime-arc and an incremental-arm one as C-prime', () => {
    // pick concrete session ids landing on each arm
    const incrementalSid = ['a', 'b', 'c', 'd', 'e', 'f'].find((s) => riderArm(s) === 'incremental')!;
    const arcSid = ['a', 'b', 'c', 'd', 'e', 'f'].find((s) => riderArm(s) === 'arc')!;
    expect(selfAuthorTags(`selfauthor:${incrementalSid}:1`, 'h').regime).toBe('C-prime');
    expect(selfAuthorTags(`selfauthor:${arcSid}:1`, 'h').regime).toBe('C-prime-arc');
  });

  it('tags a non-checkpoint (Stop) observation as regime C with host', () => {
    expect(selfAuthorTags(undefined, 'darkstar')).toEqual({ regime: 'C', host: 'darkstar' });
  });
});

describe('riderArm (between-subjects A/B split, keyed by session id)', () => {
  it('is deterministic per session id', () => {
    expect(riderArm('session-xyz')).toBe(riderArm('session-xyz'));
  });

  it('assigns sessions to both arms (non-degenerate split)', () => {
    const arms = new Set(Array.from({ length: 60 }, (_, i) => riderArm(`sess-${i}`)));
    expect(arms).toEqual(new Set(['incremental', 'arc']));
  });

  it('the rider prompt and the regime tag always agree on the arm for a given session', () => {
    for (const sid of ['a', 'b', 'sess-1', 'xyz', 'session-abc-123', 'darkstar-9', 'q']) {
      const key = checkpointKey(sid, 1);
      const riderIsArc = buildCheckpointRider(key, 1).includes('ARCO');
      const tagIsArc = selfAuthorTags(key, 'h').regime === 'C-prime-arc';
      expect(riderIsArc).toBe(tagIsArc);
    }
  });

  it('the arc rider asks to abstract pattern/architecture; the incremental one rides the delta', () => {
    const arcSid = ['a', 'b', 'c', 'd', 'e', 'f'].find((s) => riderArm(s) === 'arc')!;
    const incSid = ['a', 'b', 'c', 'd', 'e', 'f'].find((s) => riderArm(s) === 'incremental')!;
    expect(buildCheckpointRider(checkpointKey(arcSid, 1), 1)).toContain('arquitetura');
    expect(buildCheckpointRider(checkpointKey(incSid, 1), 1)).toContain('desde o último checkpoint');
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
