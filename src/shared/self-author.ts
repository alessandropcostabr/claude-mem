/**
 * Self-authoring: instead of a separate LLM re-distilling raw events, the
 * running Claude session writes its own observations at Stop time. This module
 * holds the pure decision logic (no IO) so it is fully unit-testable.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_SELF_AUTHOR_THRESHOLD = 4;

/** Default on-disk location for per-session substantive counters. */
export function defaultStateDir(): string {
  return join(homedir(), '.claude-mem', 'self-author');
}

export interface SelfAuthorConfig {
  enabled: boolean;
  threshold: number;
  stateDir: string;
}

/**
 * Read self-authoring config from a settings-like object (opt-in by default).
 * Accepts a plain map so it can be fed either from process.env or from the
 * claude-mem SettingsDefaultsManager (which reflects settings.json) — see
 * loadFromFileOnce() in the hook handlers.
 */
export function getSelfAuthorConfig(env: Record<string, string | undefined>): SelfAuthorConfig {
  const enabled = env.CLAUDE_MEM_SELF_AUTHOR_ENABLED === 'true';
  const parsed = Number.parseInt(env.CLAUDE_MEM_SELF_AUTHOR_THRESHOLD ?? '', 10);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SELF_AUTHOR_THRESHOLD;
  const dataDir = env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  return { enabled, threshold, stateDir: join(dataDir, 'self-author') };
}

/**
 * The prompt fed back to the running session when self-authoring blocks the
 * Stop. The session — which just did the work and holds full context — writes
 * its own distilled observations, removing the dependency on a separate LLM.
 */
export const SELF_AUTHOR_PROMPT =
  'Antes de encerrar: registre a memória desta sessão. Revise o que você realizou ' +
  'desde a última vez e salve as observações salientes via a tool save_observation ' +
  '(uma por decisão, correção ou descoberta que valha lembrar — com title, type, ' +
  'narrative e files). Pule o trivial (leituras, perguntas, passos óbvios). ' +
  'Se nada relevante aconteceu, não salve nada e apenas finalize.';

const SUBSTANTIVE_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

/**
 * A tool use is "substantive" when it mutates state worth remembering.
 * Read-only exploration (Read/Grep/Glob/...) does not count toward the
 * self-authoring threshold.
 */
export function isSubstantiveTool(toolName: string): boolean {
  return SUBSTANTIVE_TOOLS.has(toolName);
}

export interface SelfAuthorInput {
  /** Feature flag (CLAUDE_MEM_SELF_AUTHOR_ENABLED). */
  enabled: boolean;
  /** Claude Code Stop-hook re-entry flag — true on the self-authoring turn. */
  stopHookActive: boolean;
  /** Substantive tool uses accumulated since the last self-author. */
  substantiveCount: number;
  /** Minimum substantive activity before asking the session to self-author. */
  threshold: number;
}

export interface SelfAuthorDecision {
  block: boolean;
}

/**
 * Decide whether this Stop should block and ask the running session to write
 * its own observations. Gated by an activity threshold (not per-stop) and the
 * Stop re-entry flag (so the self-authoring turn itself stops cleanly).
 */
export function decideSelfAuthor(input: SelfAuthorInput): SelfAuthorDecision {
  if (!input.enabled) return { block: false };
  if (input.stopHookActive) return { block: false };
  if (input.substantiveCount < input.threshold) return { block: false };
  return { block: true };
}

// --- Persistent per-session counter ---------------------------------------
// Each hook fires in its own process (observation handler increments, summarize
// handler reads/resets), so the counter must live on disk, keyed by sessionId.

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function counterFile(sessionId: string, dir: string): string {
  return join(dir, `${sanitize(sessionId)}.count`);
}

export function getSubstantiveCount(sessionId: string, dir: string): number {
  const file = counterFile(sessionId, dir);
  if (!existsSync(file)) return 0;
  // One non-empty line per event (append-only) — count the lines.
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

export function recordSubstantiveEvent(sessionId: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Append a marker line rather than read-modify-write: appends are atomic for
  // small writes, so concurrent hook processes can't clobber each other's count.
  appendFileSync(counterFile(sessionId, dir), '1\n');
}

export function resetSubstantiveCount(sessionId: string, dir: string): void {
  const file = counterFile(sessionId, dir);
  if (existsSync(file)) rmSync(file, { force: true });
}
