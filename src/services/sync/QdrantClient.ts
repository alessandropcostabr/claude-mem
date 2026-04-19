/**
 * QdrantClient — lightweight HTTP client for Qdrant vector database.
 *
 * Uses fetch (Bun/Node native) — zero npm dependencies.
 * Designed to replace ChromaMcpManager's subprocess model with stable HTTP.
 *
 * Qdrant REST API reference: https://api.qdrant.tech/api-reference
 */

import { logger } from '../../utils/logger.js';

export interface QdrantPoint {
  id: number;
  vector: number[];
  payload: Record<string, any>;
}

export interface QdrantSearchResult {
  id: number;
  score: number;
  payload: Record<string, any>;
}

export interface QdrantFilter {
  must?: Array<{ key: string; match: { value: string | number } }>;
}

const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

export class QdrantClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(host: string, port: string | number, apiKey: string = '') {
    this.baseUrl = `http://${host}:${port}`;
    this.apiKey = apiKey;
  }

  /**
   * HTTP request helper with timeout and error handling
   */
  private async request(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['api-key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Qdrant ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`);
      }

      return text ? JSON.parse(text) : {};
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Qdrant ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Check if Qdrant is reachable
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.request('GET', '/healthz');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a collection exists
   */
  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', `/collections/${name}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a collection (idempotent — skips if already exists)
   */
  async createCollection(name: string, vectorSize: number): Promise<void> {
    if (await this.collectionExists(name)) {
      return;
    }

    await this.request('PUT', `/collections/${name}`, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
        on_disk: true,
      },
    });

    logger.info('QDRANT', `Collection created: ${name} (${vectorSize} dims)`);
  }

  /**
   * Upsert points in batches
   */
  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      await this.request('PUT', `/collections/${collection}/points`, {
        points: batch,
      });
    }
  }

  /**
   * Delete points by IDs
   */
  async deletePoints(collection: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    await this.request('POST', `/collections/${collection}/points/delete`, {
      points: ids,
    });
  }

  /**
   * Search by vector, return scored results with payload
   */
  async searchPoints(
    collection: string,
    vector: number[],
    limit: number,
    filter?: QdrantFilter
  ): Promise<QdrantSearchResult[]> {
    const body: Record<string, any> = {
      vector,
      limit,
      with_payload: true,
    };

    if (filter) {
      body.filter = filter;
    }

    const response = await this.request('POST', `/collections/${collection}/points/search`, body);
    return response.result || [];
  }

  /**
   * Get all point IDs in a collection (paginated scroll)
   */
  async getAllPointIds(collection: string): Promise<number[]> {
    const ids: number[] = [];
    let offset: number | null = null;

    while (true) {
      const body: Record<string, any> = {
        limit: 1000,
        with_payload: false,
        with_vector: false,
      };
      if (offset !== null) {
        body.offset = offset;
      }

      const response = await this.request('POST', `/collections/${collection}/points/scroll`, body);
      const points = response.result?.points || [];

      if (points.length === 0) break;

      for (const p of points) {
        ids.push(p.id);
      }

      offset = response.result?.next_page_offset;
      if (offset === null || offset === undefined) break;
    }

    return ids;
  }

  /**
   * Get collection info (point count, etc.)
   */
  async getCollectionInfo(collection: string): Promise<{
    pointsCount: number;
    status: string;
  }> {
    const response = await this.request('GET', `/collections/${collection}`);
    const result = response.result || {};
    return {
      pointsCount: result.points_count || 0,
      status: result.status || 'unknown',
    };
  }

  /**
   * No-op for HTTP client — no subprocess to stop
   */
  async close(): Promise<void> {
    // HTTP connections are stateless — nothing to close
    logger.debug('QDRANT', 'Client closed (no-op for HTTP)');
  }
}
