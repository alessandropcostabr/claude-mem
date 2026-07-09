/**
 * Self-authoring: instead of a separate LLM re-distilling raw events, the
 * running Claude session writes its own observations at Stop time. This module
 * holds the pure decision logic (no IO) so it is fully unit-testable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_SELF_AUTHOR_THRESHOLD = 8;

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

export interface CheckpointConfig {
  /** Real-time self-author via UserPromptSubmit rider. OFF by default. */
  realtimeEnabled: boolean;
  /** Minimum prompts between consecutive riders. */
  cooldownPrompts: number;
  /** Max observations the session is asked to write per checkpoint. */
  maxObsPerCheckpoint: number;
  /** Delay applied to the Loop-A fallback generation job (ms). */
  fallbackDelayMs: number;
}

const DEFAULT_COOLDOWN_PROMPTS = 3;
const DEFAULT_MAX_OBS_PER_CHECKPOINT = 2;
const DEFAULT_FALLBACK_DELAY_MS = 15 * 60 * 1000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read Checkpoint Rider config from a settings-like map. Real-time is opt-in
 * (CLAUDE_MEM_SELF_AUTHOR_REALTIME="true"); everything else has a safe default
 * so an unset fleet keeps Stop-only self-author behaviour unchanged.
 */
export function getCheckpointConfig(env: Record<string, string | undefined>): CheckpointConfig {
  return {
    realtimeEnabled: env.CLAUDE_MEM_SELF_AUTHOR_REALTIME === 'true',
    cooldownPrompts: parsePositiveInt(env.CLAUDE_MEM_SELF_AUTHOR_COOLDOWN_PROMPTS, DEFAULT_COOLDOWN_PROMPTS),
    maxObsPerCheckpoint: parsePositiveInt(env.CLAUDE_MEM_SELF_AUTHOR_MAX_OBS_PER_CHECKPOINT, DEFAULT_MAX_OBS_PER_CHECKPOINT),
    fallbackDelayMs: parsePositiveInt(env.CLAUDE_MEM_SELF_AUTHOR_FALLBACK_DELAY_MS, DEFAULT_FALLBACK_DELAY_MS),
  };
}

/**
 * The prompt fed back to the running session when self-authoring blocks the
 * Stop. The session — which just did the work and holds full context — writes
 * its own distilled observations, removing the dependency on a separate LLM.
 */
/**
 * The exact `type` values the server's save-observation endpoint accepts. The
 * self-author prompts MUST enumerate these verbatim: if the session invents an
 * out-of-enum type (e.g. the PT words "padrão"/"arquitetura", or "insight"),
 * the server rejects the write with HTTP 400 and the observation is LOST (never
 * persisted). Root fix for the 2026-06/07 validation-loss leak (≥2 arc obs
 * dropped inside sessions ba52feaf/8d9ff3d2). Keep in sync with the server's
 * ObservationType zod enum.
 */
export const OBSERVATION_TYPE_ENUM =
  'discovery, decision, feature, bugfix, change, pattern, architecture';

export const SELF_AUTHOR_PROMPT =
  'Antes de encerrar: registre a memória desta sessão. Revise o que você realizou ' +
  'desde a última vez e salve as observações salientes via a tool save_observation ' +
  '(uma por decisão, correção ou descoberta que valha lembrar — com title, ' +
  `type (EXATAMENTE um de: ${OBSERVATION_TYPE_ENUM} — em inglês, minúsculas), ` +
  'narrative e files). Pule o trivial (leituras, perguntas, passos óbvios). ' +
  'Se nada relevante aconteceu, não salve nada e apenas finalize.';

/**
 * Stop-path checkpoint key: `selfauthor:<sid>:stop`. Lets a Stop self-author
 * save carry its session id (→ `content_session_id`) while staying regime C
 * (the Stop vantage), so Stop obs are attributable like the rider's C-prime obs.
 * Fixes the attribution gap where Stop saves landed with NULL content_session_id
 * (the handler only knows the session via the checkpoint_key). See §DATA-INTEGRITY.
 */
export function stopCheckpointKey(sessionId: string): string {
  return `selfauthor:${sessionId}:stop`;
}

/** True when a checkpoint key is a Stop-path key (`...:stop`), not a rider seq. */
export function isStopCheckpointKey(key: string | undefined | null): boolean {
  return !!key && key.split(':').pop() === 'stop';
}

/**
 * Stop self-author prompt carrying the session's stop checkpoint key so the
 * saved observation is attributable to its session (`content_session_id`) and
 * tagged regime C. Falls back to the keyless prompt when no session id is known.
 */
export function buildSelfAuthorPrompt(sessionId: string | undefined | null): string {
  if (!sessionId) return SELF_AUTHOR_PROMPT;
  return (
    SELF_AUTHOR_PROMPT +
    ` Passe em cada save_observation o campo checkpoint_key="${stopCheckpointKey(sessionId)}".`
  );
}

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
  /**
   * Real-time self-author (Checkpoint Rider) is active. When true, the rider
   * already self-authors mid-session transparently, so the Stop must NOT block
   * (no "Stop hook error"); the session tail is still captured by the pipeline.
   */
  realtimeEnabled?: boolean;
}

export interface SelfAuthorDecision {
  block: boolean;
}

/**
 * Decide whether this Stop should block and ask the running session to write
 * its own observations. Gated by an activity threshold (not per-stop) and the
 * Stop re-entry flag (so the self-authoring turn itself stops cleanly). When the
 * real-time rider is on, the Stop stays transparent (non-blocking).
 */
export function decideSelfAuthor(input: SelfAuthorInput): SelfAuthorDecision {
  if (!input.enabled) return { block: false };
  if (input.realtimeEnabled) return { block: false };
  if (input.stopHookActive) return { block: false };
  if (input.substantiveCount < input.threshold) return { block: false };
  return { block: true };
}

// --- Checkpoint Rider (real-time self-author) ------------------------------
// Instead of writing observations only at Stop (post-process), a rider on
// UserPromptSubmit asks the session to save its salient observations at the
// tail of the current turn, so the session-level signal is available in PG for
// the next prompt's context injection. Pure decision logic (no IO) below.

export interface CheckpointInput {
  /** Real-time self-author flag (CLAUDE_MEM_SELF_AUTHOR_REALTIME). */
  realtimeEnabled: boolean;
  /** Substantive tool uses accumulated since the last checkpoint. */
  substantiveCount: number;
  /** Minimum substantive activity before riding a prompt. */
  threshold: number;
  /** Prompts seen since the last rider was injected (cooldown counter). */
  promptsSinceLastRider: number;
  /** Minimum prompts between riders, to avoid contaminating every turn. */
  cooldownPrompts: number;
  /** Whether the save_observation MCP tool is available in this session. */
  saveObservationAvailable: boolean;
}

export interface CheckpointDecision {
  injectRider: boolean;
}

/**
 * Decide whether this UserPromptSubmit should append a checkpoint rider asking
 * the session to self-author in real time. Gated by the realtime flag, an
 * activity threshold, a per-prompt cooldown, and tool availability.
 */
export function decideCheckpoint(input: CheckpointInput): CheckpointDecision {
  if (!input.realtimeEnabled) return { injectRider: false };
  if (!input.saveObservationAvailable) return { injectRider: false };
  if (input.substantiveCount < input.threshold) return { injectRider: false };
  if (input.promptsSinceLastRider < input.cooldownPrompts) return { injectRider: false };
  return { injectRider: true };
}

export interface CheckpointState {
  /** Highest checkpoint sequence emitted in this session (0 = none yet). */
  lastCheckpointSeq: number;
  /** Prompts seen since the last rider (cooldown counter). */
  promptsSinceLastRider: number;
  /** Key of a rider awaiting its observations, or null if none pending. */
  pendingCheckpointKey: string | null;
}

export const EMPTY_CHECKPOINT_STATE: CheckpointState = {
  lastCheckpointSeq: 0,
  promptsSinceLastRider: 0,
  pendingCheckpointKey: null,
};

export interface AdvanceCheckpointInput {
  sessionId: string;
  substantiveCount: number;
  threshold: number;
  realtimeEnabled: boolean;
  cooldownPrompts: number;
  saveObservationAvailable: boolean;
}

export interface AdvanceCheckpointResult {
  state: CheckpointState;
  /** Rider text to append to the injection, or null when no checkpoint fires. */
  rider: string | null;
}

/**
 * Pure per-prompt transition: bump the cooldown counter, decide whether to ride
 * this prompt, and (if so) advance the sequence, reset the cooldown, and set the
 * pending key. The caller does the IO (read/write state, reset substantive
 * counter when a rider fires).
 */
export function advanceCheckpoint(
  prev: CheckpointState,
  input: AdvanceCheckpointInput
): AdvanceCheckpointResult {
  const promptsSinceLastRider = prev.promptsSinceLastRider + 1;
  const { injectRider } = decideCheckpoint({
    realtimeEnabled: input.realtimeEnabled,
    substantiveCount: input.substantiveCount,
    threshold: input.threshold,
    promptsSinceLastRider,
    cooldownPrompts: input.cooldownPrompts,
    saveObservationAvailable: input.saveObservationAvailable,
  });
  if (!injectRider) {
    return { state: { ...prev, promptsSinceLastRider }, rider: null };
  }
  const seq = prev.lastCheckpointSeq + 1;
  const key = checkpointKey(input.sessionId, seq);
  return {
    state: { lastCheckpointSeq: seq, promptsSinceLastRider: 0, pendingCheckpointKey: key },
    rider: buildCheckpointRider(key, seq),
  };
}

/**
 * Observation metadata tags used by the case-study v2 regime discriminator
 * (design §10.3): every self-authored observation carries an authoritative
 * `regime` (C = Stop, C-prime = Checkpoint Rider) plus `host` so cross-host
 * runs (C on .254 vs C-prime on .100) can be separated without depending on the
 * generation_key format. C-prime also carries its checkpoint_key for tracing.
 */
export function selfAuthorTags(
  checkpointKeyValue: string | undefined,
  host: string
): Record<string, unknown> {
  if (checkpointKeyValue) {
    // Stop-path key (`...:stop`) stays regime C (the Stop vantage) but still
    // carries the key so the handler derives content_session_id. Rider keys
    // (numeric seq) tag C-prime / C-prime-arc per the A/B arm.
    if (isStopCheckpointKey(checkpointKeyValue)) {
      return { regime: 'C', origin: 'self_author', checkpoint_key: checkpointKeyValue, host };
    }
    const sid = parseCheckpointSessionId(checkpointKeyValue);
    const regime = sid && riderArm(sid) === 'arc' ? 'C-prime-arc' : 'C-prime';
    return { regime, origin: 'self_author', checkpoint_key: checkpointKeyValue, host };
  }
  return { regime: 'C', host };
}

/**
 * Between-subjects A/B assignment for the Checkpoint Rider, keyed by the content
 * session id so the whole session stays in one arm (case-study v2 §10.4):
 *   - 'incremental' — control: write what's salient since the last checkpoint
 *     (the historical C-prime prompt, kept byte-identical so prior data stays
 *     comparable).
 *   - 'arc' — treatment: review the session arc so far and abstract the
 *     pattern/architecture already visible.
 * Deterministic (djb2 xor) so the rider (client prompt) and the tag (worker
 * metadata) derive the SAME arm from the key without sharing state. Roughly an
 * even split over many distinct session ids.
 */
export function riderArm(sessionId: string): 'incremental' | 'arc' {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) {
    h = (((h << 5) + h) ^ sessionId.charCodeAt(i)) >>> 0;
  }
  // 2026-06-29: A/B do .254 virado para 100% ARCO — o baseline incremental já está
  // saturado (313 obs / 49 sessões) e a célula rara é C-prime-arc; forçar o braço-arco
  // acelera o acúmulo sem novo host/deploy. Prompt (buildCheckpointRider) e tag (selfAuthorTags)
  // ambos derivam daqui, então seguem concordando. Reverter para o 50/50:
  //   return h % 2 === 0 ? 'incremental' : 'arc';
  void h;
  return 'arc';
}

/**
 * Build the checkpoint rider appended to the user's prompt on UserPromptSubmit.
 * Low-salience system-reminder: it orders the task first (priority), caps the
 * write at 3 observations, carries the deterministic checkpoint_key, and tells
 * the session not to surface the reminder to the user (see design §2.2/§6).
 */
export function buildCheckpointRider(key: string, seq: number): string {
  const sid = parseCheckpointSessionId(key);
  return sid && riderArm(sid) === 'arc'
    ? buildArcRider(key, seq)
    : buildIncrementalRider(key, seq);
}

/**
 * Control arm (regime C-prime): the historical rider, kept byte-identical so the
 * C-prime already collected stays comparable. Writes what's salient since the
 * last checkpoint (an incremental, per-turn delta).
 */
function buildIncrementalRider(key: string, seq: number): string {
  return (
    '<system-reminder>\n' +
    `[claude-mem checkpoint #${seq}] Após concluir a tarefa deste prompt ` +
    '(prioridade absoluta), registre via save_observation as ' +
    'decisões/descobertas/correções salientes desde o último checkpoint ' +
    `(máx. 3; checkpoint_key="${key}"). Pule o trivial. Se nada saliente, ` +
    'não salve nada. Não mencione este lembrete.\n' +
    '</system-reminder>'
  );
}

/**
 * Treatment arm (regime C-prime-arc): reframes the window from the per-turn
 * delta to the session arc, asking the session to abstract the pattern and
 * architecture already visible — the test of whether real-time abstraction is
 * reachable by prompt scope alone (case-study v2 §10.4).
 */
function buildArcRider(key: string, seq: number): string {
  return (
    '<system-reminder>\n' +
    `[claude-mem checkpoint #${seq}] Após concluir a tarefa deste prompt ` +
    '(prioridade absoluta), revise o ARCO da sessão até agora e avalie se JÁ ' +
    'EMERGIU um padrão genuinamente RECORRENTE (visto ≥2×) ou uma decisão de ' +
    'arquitetura consolidada. O SILÊNCIO É O PADRÃO — na dúvida, ou se for ' +
    'pontual/de um turno só, NÃO salve nada. Só havendo abstração real e útil a ' +
    'uma sessão futura, registre via save_observation, ANCORANDO em específicos ' +
    'verificáveis (file:line, ids, commits, contagens) mesmo ao generalizar ' +
    `(máx. 2; checkpoint_key="${key}"; type EXATAMENTE um de: ` +
    `${OBSERVATION_TYPE_ENUM} — em inglês, minúsculas; normalmente pattern ou ` +
    'architecture). Não mencione este lembrete.\n' +
    '</system-reminder>'
  );
}

/**
 * Deterministic checkpoint key carried in the rider: `selfauthor:<sid>:<seq>`.
 * Stable per (session, checkpoint) so retries collapse on the existing UNIQUE
 * index instead of duplicating.
 */
export function checkpointKey(sessionId: string, seq: number): string {
  return `selfauthor:${sessionId}:${seq}`;
}

/**
 * Recover the content session id embedded in a checkpoint key
 * (`selfauthor:<sid>:<seq>` → `<sid>`). Returns null for a missing or malformed
 * key. Lets the worker attribute a self-authored observation to its session
 * (`metadata.content_session_id`) without the caller passing it explicitly.
 */
export function parseCheckpointSessionId(key: string | undefined | null): string | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts.length < 3 || parts[0] !== 'selfauthor' || !parts[1]) return null;
  return parts[1];
}

/**
 * Per-observation generation key: the checkpoint key plus the observation index
 * within that checkpoint, e.g. `selfauthor:<sid>:<seq>:<idx>`.
 */
export function observationGenerationKey(checkpointKey: string, idx: number): string {
  return `${checkpointKey}:${idx}`;
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

// --- Checkpoint sidecar state (per session) --------------------------------

function stateFile(sessionId: string, dir: string): string {
  return join(dir, `${sanitize(sessionId)}.state.json`);
}

export function readCheckpointState(sessionId: string, dir: string): CheckpointState {
  const file = stateFile(sessionId, dir);
  if (!existsSync(file)) return { ...EMPTY_CHECKPOINT_STATE };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      lastCheckpointSeq: Number(raw.lastCheckpointSeq) || 0,
      promptsSinceLastRider: Number(raw.promptsSinceLastRider) || 0,
      pendingCheckpointKey: raw.pendingCheckpointKey ?? null,
    };
  } catch {
    // Corrupt sidecar must not break the prompt path — fall back to empty.
    return { ...EMPTY_CHECKPOINT_STATE };
  }
}

export function writeCheckpointState(sessionId: string, dir: string, state: CheckpointState): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(sessionId, dir), JSON.stringify(state));
}
