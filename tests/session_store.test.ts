import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should correctly count user prompts', () => {
    const claudeId = 'claude-session-1';
    store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(0);

    store.saveUserPrompt(claudeId, 1, 'First prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(1);

    store.saveUserPrompt(claudeId, 2, 'Second prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);

    store.createSDKSession('claude-session-2', 'test-project', 'initial prompt');
    store.saveUserPrompt('claude-session-2', 1, 'Other prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);
  });

  it('should store observation with timestamp override', () => {
    const claudeId = 'claude-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Test Obs',
      subtitle: null,
      facts: [],
      narrative: 'Testing',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const pastTimestamp = 1600000000000; 

    const result = store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  // --- generated_by_model propagation tests ---

  it('should persist generatedByModel in storeObservation', () => {
    const claudeId = 'claude-gbm-single';
    const memoryId = 'memory-gbm-single';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Model tracking test',
      subtitle: null,
      facts: [],
      narrative: 'Test generated_by_model propagation via storeObservation',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const modelId = 'claude-opus-4-5-20251101';
    const result = store.storeObservation(
      memoryId,
      'test-project',
      obs,
      1,
      0,
      undefined,
      modelId
    );

    const stored = store.getObservationById(result.id) as any;
    expect(stored).not.toBeNull();
    expect(stored.generated_by_model).toBe(modelId);
  });

  it('should persist generatedByModel in storeObservations (bulk path)', () => {
    const claudeId = 'claude-gbm-bulk';
    const memoryId = 'memory-gbm-bulk';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    store.updateMemorySessionId(sdkId, memoryId);

    const observations = [
      {
        type: 'discovery' as const,
        title: 'Bulk obs 1',
        subtitle: null,
        facts: [],
        narrative: 'First bulk observation',
        concepts: [],
        files_read: [],
        files_modified: []
      },
      {
        type: 'bugfix' as const,
        title: 'Bulk obs 2',
        subtitle: null,
        facts: [],
        narrative: 'Second bulk observation with different content',
        concepts: [],
        files_read: [],
        files_modified: []
      }
    ];

    const modelId = 'claude-sonnet-4-6-20250514';
    const result = store.storeObservations(
      memoryId,
      'test-project',
      observations,
      null,
      2,
      0,
      undefined,
      modelId
    );

    expect(result.observationIds).toHaveLength(2);

    for (const obsId of result.observationIds) {
      const stored = store.getObservationById(obsId) as any;
      expect(stored).not.toBeNull();
      expect(stored.generated_by_model).toBe(modelId);
    }
  });

  it('should store null generated_by_model when not provided', () => {
    const claudeId = 'claude-gbm-null';
    const memoryId = 'memory-gbm-null';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery' as const,
      title: 'Null model test',
      subtitle: null,
      facts: [],
      narrative: 'Observation without model info',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const result = store.storeObservation(memoryId, 'test-project', obs);
    const stored = store.getObservationById(result.id) as any;

    expect(stored).not.toBeNull();
    // No modelId supplied: column must be NULL, not undefined, not empty string
    expect(stored.generated_by_model).toBeNull();
  });

  it('should store summary with timestamp override', () => {
    const claudeId = 'claude-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });
});
