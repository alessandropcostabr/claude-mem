import { describe, it, expect } from 'bun:test';
import {
  buildServerBetaObservationRequest,
  coerceStringArray,
} from '../../src/shared/server-beta-save-observation.js';

const PROJECT = '2e157557-603a-4c35-9e4a-71be282f3651';
const SID = '723a641c-e40c-470f-99d2-39111baee81e';

describe('coerceStringArray', () => {
  it('passes arrays through as strings', () => {
    expect(coerceStringArray(['a', 2, 'c'])).toEqual(['a', '2', 'c']);
  });
  it('splits comma-separated strings and trims/drops empties', () => {
    expect(coerceStringArray(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for anything else', () => {
    expect(coerceStringArray(undefined)).toEqual([]);
    expect(coerceStringArray(42)).toEqual([]);
    expect(coerceStringArray({ a: 1 })).toEqual([]);
  });
});

describe('buildServerBetaObservationRequest', () => {
  it('maps type to kind and narrative to content', () => {
    const { request } = buildServerBetaObservationRequest(
      { type: 'discovery', title: 'T', narrative: 'Body text', facts: ['f1'], concepts: 'c1, c2' },
      PROJECT,
      'host-a',
    );
    expect(request.projectId).toBe(PROJECT);
    expect(request.kind).toBe('discovery');
    expect(request.content).toBe('Body text');
    expect(request.metadata).toMatchObject({
      type: 'discovery',
      title: 'T',
      facts: ['f1'],
      concepts: ['c1', 'c2'],
      files_read: [],
      files_modified: [],
    });
  });

  it('Stop checkpoint key: regime C, session attribution and checkpoint key kept', () => {
    const key = `selfauthor:${SID}:stop`;
    const built = buildServerBetaObservationRequest(
      { type: 'decision', narrative: 'n', checkpoint_key: key },
      PROJECT,
      'darkstar',
    );
    expect(built.contentSessionId).toBe(SID);
    expect(built.request.contentSessionId).toBe(SID);
    expect(built.request.metadata).toMatchObject({
      regime: 'C',
      origin: 'self_author',
      checkpoint_key: key,
      host: 'darkstar',
      content_session_id: SID,
    });
  });

  it('Checkpoint Rider key: C-prime family regime and session attribution', () => {
    const key = `selfauthor:${SID}:3`;
    const { request } = buildServerBetaObservationRequest(
      { type: 'pattern', narrative: 'n', checkpoint_key: key },
      PROJECT,
      'hyper',
    );
    expect(['C-prime', 'C-prime-arc']).toContain((request.metadata as any).regime);
    expect(request.metadata).toMatchObject({ origin: 'self_author', checkpoint_key: key, content_session_id: SID });
    expect(request.contentSessionId).toBe(SID);
  });

  it('without a checkpoint key: regime C + host only, no session fields', () => {
    const { request, contentSessionId } = buildServerBetaObservationRequest(
      { type: 'change', narrative: 'n' },
      PROJECT,
      'h',
    );
    expect(contentSessionId).toBeNull();
    expect(request).not.toHaveProperty('contentSessionId');
    expect((request.metadata as any).regime).toBe('C');
    expect((request.metadata as any).host).toBe('h');
    expect(request.metadata).not.toHaveProperty('content_session_id');
    expect(request.metadata).not.toHaveProperty('checkpoint_key');
  });

  it('ignores a malformed checkpoint key for attribution', () => {
    const { contentSessionId, request } = buildServerBetaObservationRequest(
      { type: 'change', narrative: 'n', checkpoint_key: 'not-a-selfauthor-key' },
      PROJECT,
      'h',
    );
    expect(contentSessionId).toBeNull();
    expect(request).not.toHaveProperty('contentSessionId');
  });

  describe('title', () => {
    it('explicit title wins', () => {
      expect(buildServerBetaObservationRequest({ type: 'change', title: 'Mine', narrative: 'x'.repeat(200) }, PROJECT).title).toBe('Mine');
    });
    it('falls back to the first 60 chars (trimmed) with an ellipsis when longer', () => {
      const narrative = 'a'.repeat(59) + ' ' + 'b'.repeat(40);
      const { title } = buildServerBetaObservationRequest({ type: 'change', narrative }, PROJECT);
      expect(title).toBe('a'.repeat(59) + '...');
    });
    it('short narrative becomes the title without an ellipsis', () => {
      expect(buildServerBetaObservationRequest({ type: 'change', narrative: 'short one' }, PROJECT).title).toBe('short one');
    });
  });

  it('accepts the legacy `text` alias for narrative', () => {
    const { request } = buildServerBetaObservationRequest({ type: 'change', text: 'legacy body' }, PROJECT);
    expect(request.content).toBe('legacy body');
  });

  it('only includes subtitle and generated_by_model when provided', () => {
    const bare = buildServerBetaObservationRequest({ type: 'change', narrative: 'n' }, PROJECT).request.metadata!;
    expect(bare).not.toHaveProperty('subtitle');
    expect(bare).not.toHaveProperty('generated_by_model');
    const full = buildServerBetaObservationRequest(
      { type: 'change', narrative: 'n', subtitle: 'sub', generated_by_model: 'claude-sonnet-5-5' },
      PROJECT,
    ).request.metadata!;
    expect(full).toMatchObject({ subtitle: 'sub', generated_by_model: 'claude-sonnet-5-5' });
  });

  it('throws a clear error when the narrative is missing or blank', () => {
    expect(() => buildServerBetaObservationRequest({ type: 'change' }, PROJECT)).toThrow(/narrative/);
    expect(() => buildServerBetaObservationRequest({ type: 'change', narrative: '   ' }, PROJECT)).toThrow(/narrative/);
  });
});

describe('MCP save_observation wiring (contract)', () => {
  it('delegates to handleSaveObservation, which writes server-beta directly and never falls back to the worker on failure', async () => {
    const src = await Bun.file(new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname).text();
    const toolStart = src.indexOf("name: 'save_observation'");
    const toolBlock = src.slice(toolStart, src.indexOf("name: 'mem_confirm'"));
    expect(toolBlock).toContain('handleSaveObservation(args)');
    expect(toolBlock).not.toContain("callWorkerAPIPost('/api/memory/save-observation'");

    const fnStart = src.indexOf('async function handleSaveObservation');
    const fn = src.slice(fnStart, src.indexOf('interface ObservationRecordEventArgs'));
    expect(fn).toContain('buildServerBetaObservationRequest(args, ctx.projectId)');
    expect(fn).toContain('ctx.client.addObservation(built.request)');
    // worker path only when the runtime is NOT server-beta (before the try block)
    const beforeTry = fn.slice(0, fn.indexOf('try {'));
    expect(beforeTry).toContain("callWorkerAPIPost('/api/memory/save-observation'");
    // ...and never inside the server-beta try/catch (no silent local-island fallback)
    const tryBlock = fn.slice(fn.indexOf('try {'));
    expect(tryBlock).not.toContain('callWorkerAPIPost');
  });
});
