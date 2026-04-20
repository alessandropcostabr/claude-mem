/**
 * Memory Routes
 *
 * Handles manual memory/observation saving.
 * POST /api/memory/save - Save a manual memory observation
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', this.handleSaveMemory.bind(this));
    app.post('/api/memory/save-observation', this.handleSaveObservation.bind(this));
    app.get('/api/memory/observations/:id', this.handleGetObservation.bind(this));
    app.patch('/api/memory/observations/:id/confirm', this.handleConfirm.bind(this));
    app.patch('/api/memory/observations/:id/deprecate', this.handleDeprecate.bind(this));
    app.patch('/api/memory/observations/:id/flag', this.handleFlag.bind(this));
    app.get('/api/memory/stats', this.handleStats.bind(this));
  }

  /**
   * POST /api/memory/save - Save a manual memory/observation
   * Body: { text: string, title?: string, project?: string }
   */
  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project, type, concepts, facts, subtitle, files_read, files_modified } = req.body;
    const targetProject = project || this.defaultProject;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      this.badRequest(res, 'text is required and must be non-empty');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Get or create manual session for project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 2. Build observation — accept payload fields, fallback to defaults
    const observation = {
      type: type || 'discovery',
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: subtitle || 'Manual memory',
      facts: Array.isArray(facts) ? facts : [],
      narrative: text,
      concepts: Array.isArray(concepts) ? concepts : [],
      files_read: Array.isArray(files_read) ? files_read : [],
      files_modified: Array.isArray(files_modified) ? files_modified : []
    };

    // 3. Store to SQLite
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   // discoveryTokens
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    // 4. Sync to vector backend (async, fire-and-forget)
    chromaSync?.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('VECTOR', 'Vector sync failed', { id: result.id }, err as Error);
    });

    // 5. Return success
    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });

  // --- GOV-7.1: GET observation by ID ---

  private handleGetObservation = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const db = this.dbManager.getSessionStore().db;
    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!obs) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json(obs);
  });

  // --- GOV-7.2: PATCH confirm/deprecate/flag ---

  private handleConfirm = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const db = this.dbManager.getSessionStore().db;
    const obs = db.prepare('SELECT id, status, correctness FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!obs) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }
    if (obs.status === 'deprecated') {
      this.badRequest(res, `Observation #${id} is deprecated`);
      return;
    }

    db.prepare(`
      UPDATE observations SET correctness = 'confirmed', correctness_at = datetime('now')
      WHERE id = ?
    `).run(id);

    logger.info('MEMORY', 'Observation confirmed', { id });
    res.json({ success: true, id, correctness: 'confirmed' });
  });

  private handleDeprecate = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const db = this.dbManager.getSessionStore().db;
    const obs = db.prepare('SELECT id, status FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!obs) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }
    if (obs.status === 'deprecated') {
      this.badRequest(res, `Observation #${id} is already deprecated`);
      return;
    }

    db.prepare("UPDATE observations SET status = 'deprecated' WHERE id = ?").run(id);

    logger.info('MEMORY', 'Observation deprecated', { id });
    res.json({ success: true, id, status: 'deprecated' });
  });

  private handleFlag = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const db = this.dbManager.getSessionStore().db;
    const obs = db.prepare('SELECT id, status FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!obs) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }
    if (obs.status === 'deprecated') {
      this.badRequest(res, `Observation #${id} is deprecated`);
      return;
    }

    db.prepare('UPDATE observations SET conflict_flag = 1 WHERE id = ?').run(id);

    logger.info('MEMORY', 'Observation flagged', { id });
    res.json({ success: true, id, conflict_flag: 1 });
  });

  // --- GOV-7.3: GET /api/memory/stats ---

  private handleStats = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const db = this.dbManager.getSessionStore().db;

    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'deprecated' THEN 1 ELSE 0 END) as deprecated,
        SUM(CASE WHEN correctness = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN correctness = 'unverified' THEN 1 ELSE 0 END) as unverified,
        SUM(CASE WHEN conflict_flag = 1 THEN 1 ELSE 0 END) as flagged,
        SUM(CASE WHEN created_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as last_7d
      FROM observations
    `).get() as Record<string, number>;

    const topProjects = db.prepare(`
      SELECT project, COUNT(*) as count
      FROM observations
      WHERE created_at >= date('now', '-7 days') AND status = 'active'
      GROUP BY project
      ORDER BY count DESC
      LIMIT 5
    `).all() as Array<{ project: string; count: number }>;

    const feedback = db.prepare('SELECT COUNT(*) as total FROM observation_feedback').get() as { total: number };

    res.json({
      observations: counts,
      top_projects_7d: topProjects,
      feedback_total: feedback.total
    });
  });

  // --- Save structured observation (Phase 7) ---

  private static readonly VALID_OBS_TYPES = [
    'discovery', 'decision', 'feature', 'bugfix', 'change', 'pattern', 'architecture'
  ];

  private static coerceStringArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  private handleSaveObservation = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      type, title, subtitle, narrative, text: bodyText,
      facts, concepts, files_read, files_modified,
      project, generated_by_model
    } = req.body;

    if (!type || !MemoryRoutes.VALID_OBS_TYPES.includes(type)) {
      this.badRequest(res, `type is required and must be one of: ${MemoryRoutes.VALID_OBS_TYPES.join(', ')}`);
      return;
    }

    const narrativeText = narrative || bodyText;
    if (!narrativeText || typeof narrativeText !== 'string' || narrativeText.trim().length === 0) {
      this.badRequest(res, 'narrative (or text) is required and must be non-empty');
      return;
    }

    const targetProject = project || this.defaultProject;
    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    const observation = {
      type,
      title: title || narrativeText.substring(0, 60).trim() + (narrativeText.length > 60 ? '...' : ''),
      subtitle: subtitle || null,
      facts: MemoryRoutes.coerceStringArray(facts),
      narrative: narrativeText,
      concepts: MemoryRoutes.coerceStringArray(concepts),
      files_read: MemoryRoutes.coerceStringArray(files_read),
      files_modified: MemoryRoutes.coerceStringArray(files_modified)
    };

    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,
      0,
      undefined,
      generated_by_model || undefined
    );

    logger.info('HTTP', 'Structured observation saved', {
      id: result.id,
      type,
      project: targetProject,
      generated_by_model: generated_by_model || 'not specified'
    });

    chromaSync?.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('VECTOR', 'Vector sync failed', { id: result.id }, err as Error);
    });

    res.json({
      success: true,
      id: result.id,
      type,
      title: observation.title,
      project: targetProject,
      generated_by_model: generated_by_model || null,
      message: `Structured observation #${result.id} saved`
    });
  });
}
