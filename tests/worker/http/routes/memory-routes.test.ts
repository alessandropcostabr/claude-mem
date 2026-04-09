/**
 * MemoryRoutes Tests
 *
 * Tests save_memory and save_observation endpoints including:
 * - generated_by_model passthrough
 * - null Chroma guard
 * - structured observation validation
 * - array coercion for facts/concepts/files
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
  DATA_DIR: '/tmp/test-data',
  DB_PATH: '/tmp/test-data/test.db',
  ensureDir: () => {},
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function createMockDbManager(chromaSyncNull = false) {
  const storeObservationMock = mock(() => ({ id: 9999, createdAtEpoch: Date.now() }));
  const getOrCreateManualSessionMock = mock(() => 'test-session-id');
  const syncObservationMock = mock(() => Promise.resolve());

  return {
    dbManager: {
      getSessionStore: () => ({
        storeObservation: storeObservationMock,
        getOrCreateManualSession: getOrCreateManualSessionMock,
      }),
      getChromaSync: () => chromaSyncNull ? null : {
        syncObservation: syncObservationMock,
      },
    },
    storeObservationMock,
    getOrCreateManualSessionMock,
    syncObservationMock,
  };
}

describe('MemoryRoutes', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
  });

  describe('POST /api/memory/save', () => {
    it('passes generated_by_model to storeObservation', async () => {
      const { dbManager, storeObservationMock } = createMockDbManager();
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, jsonSpy } = createMockReqRes({
        text: 'Test memory',
        generated_by_model: 'gpt-5.4',
      });

      // Access the handler via route setup
      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);

      // Call the save handler directly
      const saveHandler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save');
      expect(saveHandler).toBeDefined();
      await saveHandler![1](req, res);

      // Verify generated_by_model was passed (7th arg)
      expect(storeObservationMock).toHaveBeenCalledTimes(1);
      const args = storeObservationMock.mock.calls[0];
      expect(args[6]).toBe('gpt-5.4');  // generatedByModel parameter

      // Verify response includes generated_by_model
      expect(jsonSpy).toHaveBeenCalledTimes(1);
      const response = jsonSpy.mock.calls[0][0];
      expect(response.generated_by_model).toBe('gpt-5.4');
    });

    it('handles null Chroma without crash', async () => {
      const { dbManager } = createMockDbManager(true);  // chromaSync = null
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, jsonSpy } = createMockReqRes({
        text: 'Test with no Chroma',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const saveHandler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save');
      await saveHandler![1](req, res);

      expect(jsonSpy).toHaveBeenCalledTimes(1);
      expect(jsonSpy.mock.calls[0][0].success).toBe(true);
    });
  });

  describe('POST /api/memory/save-observation', () => {
    it('saves structured observation with generated_by_model', async () => {
      const { dbManager, storeObservationMock } = createMockDbManager();
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, jsonSpy } = createMockReqRes({
        type: 'feature',
        narrative: 'Implemented new write path',
        title: 'Write path',
        facts: ['fact1', 'fact2'],
        generated_by_model: 'codex-gpt-5.4',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const handler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save-observation');
      expect(handler).toBeDefined();
      await handler![1](req, res);

      expect(storeObservationMock).toHaveBeenCalledTimes(1);
      const args = storeObservationMock.mock.calls[0];
      expect(args[6]).toBe('codex-gpt-5.4');

      expect(jsonSpy.mock.calls[0][0].success).toBe(true);
      expect(jsonSpy.mock.calls[0][0].type).toBe('feature');
      expect(jsonSpy.mock.calls[0][0].generated_by_model).toBe('codex-gpt-5.4');
    });

    it('rejects invalid observation type', async () => {
      const { dbManager } = createMockDbManager();
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, statusSpy } = createMockReqRes({
        type: 'invalid_type',
        narrative: 'test',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const handler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save-observation');
      await handler![1](req, res);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('rejects missing narrative', async () => {
      const { dbManager } = createMockDbManager();
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, statusSpy } = createMockReqRes({
        type: 'discovery',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const handler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save-observation');
      await handler![1](req, res);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('coerces string arrays from comma-separated strings', async () => {
      const { dbManager, storeObservationMock } = createMockDbManager();
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res } = createMockReqRes({
        type: 'discovery',
        narrative: 'Test coercion',
        facts: 'fact1, fact2, fact3',  // string instead of array
        concepts: 'how-it-works',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const handler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save-observation');
      await handler![1](req, res);

      const observation = storeObservationMock.mock.calls[0][2];
      expect(observation.facts).toEqual(['fact1', 'fact2', 'fact3']);
      expect(observation.concepts).toEqual(['how-it-works']);
    });

    it('handles null Chroma on structured save', async () => {
      const { dbManager } = createMockDbManager(true);
      const routes = new MemoryRoutes(dbManager as any, 'test-project');
      const { req, res, jsonSpy } = createMockReqRes({
        type: 'bugfix',
        narrative: 'Fixed null chroma',
      });

      const app = { post: mock(() => {}), get: mock(() => {}) };
      routes.setupRoutes(app as any);
      const handler = app.post.mock.calls.find((c: any) => c[0] === '/api/memory/save-observation');
      await handler![1](req, res);

      expect(jsonSpy.mock.calls[0][0].success).toBe(true);
    });
  });
});
