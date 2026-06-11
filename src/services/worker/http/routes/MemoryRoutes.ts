
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { resolveRuntimeContext } from '../../../hooks/runtime-selector.js';
import { selfAuthorTags } from '../../../../shared/self-author.js';
import { hostname } from 'os';

const saveMemorySchema = z.object({
  text: z.string().trim().min(1),
  title: z.string().optional(),
  project: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const VALID_OBS_TYPES = [
  'discovery', 'decision', 'feature', 'bugfix', 'change', 'pattern', 'architecture'
] as const;

const saveObservationSchema = z.object({
  type: z.enum(VALID_OBS_TYPES),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  narrative: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  facts: z.union([z.array(z.string()), z.string()]).optional(),
  concepts: z.union([z.array(z.string()), z.string()]).optional(),
  files_read: z.union([z.array(z.string()), z.string()]).optional(),
  files_modified: z.union([z.array(z.string()), z.string()]).optional(),
  project: z.string().optional(),
  generated_by_model: z.string().optional(),
  checkpoint_key: z.string().optional(),
}).refine(data => !!(data.narrative || data.text), {
  message: 'narrative (or text) is required and must be non-empty',
});

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', validateBody(saveMemorySchema), this.handleSaveMemory.bind(this));
    app.post('/api/memory/save-observation', validateBody(saveObservationSchema), this.handleSaveObservation.bind(this));
    app.patch('/api/memory/observations/:id/confirm', this.handleConfirm.bind(this));
    app.patch('/api/memory/observations/:id/deprecate', this.handleDeprecate.bind(this));
    app.patch('/api/memory/observations/:id/flag', this.handleFlag.bind(this));
    app.get('/api/memory/stats', this.handleStats.bind(this));
  }

  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project, metadata } = req.body as z.infer<typeof saveMemorySchema>;
    const explicitProject = typeof project === 'string' && project.trim()
      ? project.trim()
      : undefined;
    const metadataProject = typeof metadata?.project === 'string' && metadata.project.trim()
      ? metadata.project.trim()
      : undefined;
    const targetProject = explicitProject || metadataProject || this.defaultProject;

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    const observation = {
      type: 'discovery',  // Use existing valid type
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[],
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    if (!chromaSync) {
      logger.debug('CHROMA', 'ChromaDB sync skipped (chromaSync not available)', { id: result.id });
      res.json({
        success: true,
        id: result.id,
        title: observation.title,
        project: targetProject,
        message: `Memory saved as observation #${result.id}`
      });
      return;
    }
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

    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });

  // --- Governance: PATCH confirm/deprecate/flag ---

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

  // --- GET /api/memory/stats ---

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

  // --- POST /api/memory/save-observation (structured) ---

  private static coerceStringArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  private handleSaveObservation = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      type, title, subtitle, narrative, text: bodyText,
      facts, concepts, files_read, files_modified,
      project, generated_by_model, checkpoint_key
    } = req.body;

    const narrativeText = narrative || bodyText;

    // Server-beta routing: in server-beta runtime the canonical write path is
    // the remote PG via `/v1/memories` (same path as MCP `observation_add`),
    // NOT the worker-local SQLite store. Without this, self-authored
    // observations land in a local island — invisible to inject/search and the
    // fleet PG (.253). See feedback_observation-add-content-undefined / project_self_author.
    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server-beta') {
      const computedTitle = title
        || narrativeText.substring(0, 60).trim() + (narrativeText.length > 60 ? '...' : '');
      const metadata: Record<string, unknown> = {
        type,
        title: computedTitle,
        ...(subtitle ? { subtitle } : {}),
        facts: MemoryRoutes.coerceStringArray(facts),
        concepts: MemoryRoutes.coerceStringArray(concepts),
        files_read: MemoryRoutes.coerceStringArray(files_read),
        files_modified: MemoryRoutes.coerceStringArray(files_modified),
        ...(generated_by_model ? { generated_by_model } : {}),
        // Case-study v2 regime tags (design §10.3): regime/origin/host so C
        // (Stop) and C-prime (Checkpoint Rider) are separable in PG without
        // depending on the generation_key format.
        ...selfAuthorTags(checkpoint_key, hostname()),
      };
      try {
        const resp = await runtime.client.addObservation({
          projectId: runtime.projectId,
          content: narrativeText,
          kind: type,
          metadata,
        });
        logger.info('HTTP', 'Structured observation saved via server-beta', {
          id: resp.memory.id,
          type,
          projectId: runtime.projectId,
          generated_by_model: generated_by_model || 'not specified',
        });
        res.json({
          success: true,
          id: resp.memory.id,
          type,
          title: computedTitle,
          project: runtime.projectId,
          generated_by_model: generated_by_model || null,
          message: `Structured observation ${resp.memory.id} saved to server-beta`,
          runtime: 'server-beta',
        });
        return;
      } catch (error: unknown) {
        // Do NOT silently fall back to the local SQLite store — that would
        // recreate the "local island" bug. Surface the failure to the caller.
        logger.error('HTTP', 'server-beta save-observation failed', {
          type,
          projectId: runtime.projectId,
        }, error as Error);
        res.status(502).json({
          success: false,
          error: 'ServerBetaSaveFailed',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    // Worker runtime: original local SQLite store path (unchanged).
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
      logger.error('CHROMA', 'Vector sync failed', { id: result.id }, err as Error);
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
