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
  }

  /**
   * POST /api/memory/save - Save a manual memory/observation
   * Body: { text: string, title?: string, project?: string }
   */
  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project, generated_by_model } = req.body;
    const targetProject = project || this.defaultProject;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      this.badRequest(res, 'text is required and must be non-empty');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Get or create manual session for project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 2. Build observation
    const observation = {
      type: 'discovery',
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[]
    };

    // 3. Store to SQLite (pass generated_by_model from caller)
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0,  // discoveryTokens
      undefined,  // overrideTimestampEpoch
      generated_by_model || undefined
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title,
      generated_by_model: generated_by_model || 'not specified'
    });

    // 4. Sync to ChromaDB if available (guard null Chroma)
    if (chromaSync) {
      chromaSync.syncObservation(
        result.id,
        memorySessionId,
        targetProject,
        observation,
        0,
        result.createdAtEpoch,
        0
      ).catch(err => {
        logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
      });
    }

    // 5. Return success
    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      generated_by_model: generated_by_model || null,
      message: `Memory saved as observation #${result.id}`
    });
  });

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

    // Validate type
    if (!type || !MemoryRoutes.VALID_OBS_TYPES.includes(type)) {
      this.badRequest(res, `type is required and must be one of: ${MemoryRoutes.VALID_OBS_TYPES.join(', ')}`);
      return;
    }

    // Validate narrative or text
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

    if (chromaSync) {
      chromaSync.syncObservation(
        result.id,
        memorySessionId,
        targetProject,
        observation,
        0,
        result.createdAtEpoch,
        0
      ).catch(err => {
        logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
      });
    }

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
