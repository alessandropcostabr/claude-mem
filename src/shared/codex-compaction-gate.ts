import { sessionMarkerFiles } from './session-marker-files.js';

const pendingTimelineMarkers = sessionMarkerFiles(
  'codex-compaction-pending',
  'codex-compaction-gate',
);

function threadKey(sessionId: string, agentId: string | undefined): string {
  return agentId ? JSON.stringify([sessionId, agentId]) : sessionId;
}

export function markTimelinePending(sessionId: string, agentId: string | undefined): void {
  pendingTimelineMarkers.mark(threadKey(sessionId, agentId));
}

export function clearTimelinePending(sessionId: string, agentId: string | undefined): void {
  pendingTimelineMarkers.clear(threadKey(sessionId, agentId));
}

export function takeTimelinePending(sessionId: string, agentId: string | undefined): boolean {
  return pendingTimelineMarkers.take(threadKey(sessionId, agentId));
}
