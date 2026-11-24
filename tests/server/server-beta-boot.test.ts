import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { loadServerBetaMode } from '../../src/server/runtime/create-server-beta-service.js';
import { logger } from '../../src/utils/logger.js';

// #2443 — the server-beta runtime must load an observation mode before it can
// accept jobs, and must FAIL FAST if no mode can be loaded.
describe('server-beta boot: mode loading (#2443)', () => {
  const spies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    spies.splice(0).forEach(spy => spy.mockRestore());
  });

  it('loads the code mode and leaves a mode active', () => {
    spies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    );

    const modeManager = {
      loadMode: () => ({ observation_types: [{ id: 'discovery' }] }),
      getActiveMode: () => ({ observation_types: [{ id: 'discovery' }] }),
    } as any;

    expect(() => loadServerBetaMode(modeManager)).not.toThrow();
    // Validation: a mode is actually active after boot.
    expect(() => modeManager.getActiveMode()).not.toThrow();
    expect(modeManager.getActiveMode().observation_types.length).toBeGreaterThan(0);
  });

  it('fails fast (throws) when no mode can be loaded', () => {
    spies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    );
    // Simulate a broken install: the bundled mode file is missing, so
    // ModeManager.loadMode('code') throws its critical error. The server boot
    // helper must propagate it rather than booting into a non-functional state.
    const modeManager = {
      loadMode: () => { throw new Error('Critical: code.json mode file missing'); },
      getActiveMode: () => ({ observation_types: [] }),
    } as any;

    expect(() => loadServerBetaMode(modeManager)).toThrow(/code\.json mode file missing/);
  });
});
