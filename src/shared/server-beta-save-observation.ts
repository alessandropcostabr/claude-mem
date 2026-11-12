/**
 * Shared builder for a structured `save_observation` write to server-beta.
 *
 * Single source of truth for how a typed observation is mapped onto the
 * `/v1/memories` request (`kind`, `metadata`, regime tags, `content_session_id`).
 * Used by BOTH:
 *   - the worker route `POST /api/memory/save-observation` (worker as proxy), and
 *   - the MCP `save_observation` tool when CLAUDE_MEM_RUNTIME=server-beta, which
 *     now writes straight to server-beta so it keeps working with no local
 *     worker/SQLite (the fleet runs PG-only on .253).
 *
 * Keeping one builder guarantees the two paths stay byte-identical: the Stop
 * self-author (`selfauthor:<sid>:stop`) and the Checkpoint Rider keep their
 * regime tags and session attribution regardless of which path wrote them.
 */
import { hostname } from 'os';
import type { ServerBetaAddObservationRequest } from '../services/hooks/server-beta-client.js';
import { selfAuthorTags, parseCheckpointSessionId } from './self-author.js';

/** Body accepted by save_observation (MCP args / worker request body). */
export interface SaveObservationArgs {
  type?: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  /** Legacy alias for `narrative`. */
  text?: string;
  facts?: unknown;
  concepts?: unknown;
  files_read?: unknown;
  files_modified?: unknown;
  project?: string;
  generated_by_model?: string;
  checkpoint_key?: string;
}

export interface BuiltServerBetaObservation {
  request: ServerBetaAddObservationRequest;
  /** Title actually stored (explicit title, or the first 60 chars of the narrative). */
  title: string;
  /** Content session id recovered from the checkpoint key, if any. */
  contentSessionId: string | null;
}

/** Accepts an array or a comma-separated string; anything else becomes []. */
export function coerceStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export function buildServerBetaObservationRequest(
  args: SaveObservationArgs,
  projectId: string,
  host: string = hostname(),
): BuiltServerBetaObservation {
  const narrativeText = args.narrative || args.text;
  if (typeof narrativeText !== 'string' || narrativeText.trim().length === 0) {
    throw new Error('save_observation: "narrative" is required');
  }

  const title = args.title
    || narrativeText.substring(0, 60).trim() + (narrativeText.length > 60 ? '...' : '');
  // The CC session id travels inside the checkpoint key so the observation is
  // attributable to its session (server_session_id is unknown on this path).
  const contentSessionId = parseCheckpointSessionId(args.checkpoint_key);

  const metadata: Record<string, unknown> = {
    type: args.type,
    title,
    ...(args.subtitle ? { subtitle: args.subtitle } : {}),
    facts: coerceStringArray(args.facts),
    concepts: coerceStringArray(args.concepts),
    files_read: coerceStringArray(args.files_read),
    files_modified: coerceStringArray(args.files_modified),
    ...(args.generated_by_model ? { generated_by_model: args.generated_by_model } : {}),
    // Case-study v2 regime tags (design §10.3): C (Stop) vs C-prime (Checkpoint
    // Rider), plus origin/host, separable in PG without parsing generation_key.
    ...selfAuthorTags(args.checkpoint_key, host),
    ...(contentSessionId ? { content_session_id: contentSessionId } : {}),
  };

  return {
    title,
    contentSessionId,
    request: {
      projectId,
      content: narrativeText,
      kind: args.type,
      metadata,
      // Lets the server attribute server_session_id when it maps a content
      // session id; harmless if it ignores the field.
      ...(contentSessionId ? { contentSessionId } : {}),
    },
  };
}
