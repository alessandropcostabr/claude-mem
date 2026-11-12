import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BanditEngine } from '../../../src/services/bandit/BanditEngine.js';
import type { Experiment } from '../../../src/services/bandit/types.js';

const EXPERIMENT: Experiment = {
  id: 'exp-1',
  description: 'fresh database regression',
  rewardSignals: ['accepted'],
  createdAt: 1_700_000_000_000,
};

describe('BanditEngine on a FRESH database (no bandit tables)', () => {
  it('init does not throw: a missing optional table must not abort the worker', () => {
    const db = new Database(':memory:');
    const engine = new BanditEngine();
    expect(() => engine.init(db)).not.toThrow();
  });

  it('keeps working in memory (register, select, reward) without persisting anything', () => {
    const db = new Database(':memory:');
    const engine = new BanditEngine();
    engine.init(db);

    expect(() => engine.registerExperiment(EXPERIMENT)).not.toThrow();
    const picked = engine.selectArm(EXPERIMENT.id, ['a', 'b']);
    expect(['a', 'b']).toContain(picked);
    expect(() => engine.recordReward(EXPERIMENT.id, picked, 1)).not.toThrow();

    // nothing was created or written behind the caller's back
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bandit_%'").all();
    expect(tables).toEqual([]);
  });
});

describe('BanditEngine on a database that already has the bandit tables', () => {
  function dbWithTables(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE bandit_experiments (
      id TEXT PRIMARY KEY, description TEXT, reward_signals TEXT, created_at_epoch INTEGER)`);
    db.run(`CREATE TABLE bandit_arms (
      experiment_id TEXT, arm_id TEXT, alpha REAL, beta REAL, pulls INTEGER, total_reward REAL,
      updated_at_epoch INTEGER, PRIMARY KEY (experiment_id, arm_id))`);
    return db;
  }

  it('still persists selections and rewards (the existing behavior is unchanged)', () => {
    const db = dbWithTables();
    const engine = new BanditEngine();
    engine.init(db);
    engine.registerExperiment(EXPERIMENT);
    const picked = engine.selectArm(EXPERIMENT.id, ['a', 'b']);
    engine.recordReward(EXPERIMENT.id, picked, 1);

    const exp = db.query('SELECT id FROM bandit_experiments').all() as Array<{ id: string }>;
    expect(exp.map(r => r.id)).toEqual([EXPERIMENT.id]);
    const arm = db.query('SELECT pulls, alpha FROM bandit_arms WHERE arm_id = ?').get(picked) as { pulls: number; alpha: number };
    expect(arm.pulls).toBe(1);
    expect(arm.alpha).toBeGreaterThan(1);
  });

  it('reloads persisted state on init', () => {
    const db = dbWithTables();
    const first = new BanditEngine();
    first.init(db);
    first.registerExperiment(EXPERIMENT);
    first.selectArm(EXPERIMENT.id, ['a']);

    const second = new BanditEngine();
    second.init(db);
    // the persisted experiment is known again: selecting must not throw "not registered"
    expect(() => second.selectArm(EXPERIMENT.id, ['a'])).not.toThrow();
  });
});
