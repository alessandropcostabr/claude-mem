/**
 * Self-authoring: instead of a separate LLM re-distilling raw events, the
 * running Claude session writes its own observations at Stop time. This module
 * holds the pure decision logic (no IO) so it is fully unit-testable.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
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
   * A real-time Checkpoint Rider was emitted for this exact Stop interval.
   * When true, the Stop must NOT block (no "Stop hook error"); a configured
   * realtime mode without an emitted marker remains eligible for fallback.
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
 * rider was emitted for this interval, the Stop stays transparent.
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

function counterAckFile(sessionId: string, dir: string): string {
  return `${counterFile(sessionId, dir)}.ack`;
}

const COUNTER_ACK_LOCK_STALE_MS = 30_000;

interface CounterAckLock {
  path: string;
  owner: string;
}

/**
 * Read the monotonically acknowledged line offset. Missing state is the legacy
 * format (offset zero); malformed state is fail-open and returns null so callers
 * count every event rather than silently hiding activity.
 */
function readCounterAckOffset(sessionId: string, dir: string): number | null {
  const file = counterAckFile(sessionId, dir);
  if (!existsSync(file)) return 0;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(raw)) return null;
    const offset = Number(raw);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

function countSubstantiveLogLines(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function acquireCounterAckLock(sessionId: string, dir: string): CounterAckLock | null {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${counterAckFile(sessionId, dir)}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const create = (): CounterAckLock | null => {
    try {
      writeFileSync(path, owner, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path, owner };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
  };

  const acquired = create();
  if (acquired) return acquired;

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (Date.now() - stat.mtimeMs <= COUNTER_ACK_LOCK_STALE_MS) return null;
    const staleClaim = `${path}.${process.pid}.${randomUUID()}.stale`;
    renameSync(path, staleClaim);
    try { unlinkSync(staleClaim); } catch { /* best-effort stale cleanup */ }
  } catch {
    return null;
  }
  return create();
}

function releaseCounterAckLock(lock: CounterAckLock): void {
  try {
    if (readFileSync(lock.path, 'utf8') === lock.owner) unlinkSync(lock.path);
  } catch {
    // A stale lock is recovered by the next acknowledge attempt.
  }
}

export function getSubstantiveCount(sessionId: string, dir: string): number {
  const file = counterFile(sessionId, dir);
  const total = countSubstantiveLogLines(file);
  const acknowledged = readCounterAckOffset(sessionId, dir);
  // Corrupt acknowledgement state is fail-open: expose the entire monotonic
  // log so Stop may request a duplicate checkpoint instead of losing work.
  if (acknowledged === null) return total;
  if (acknowledged > total) {
    // A reset interrupted between removing the log and its offset can leave an
    // impossible but syntactically valid value. Forget it permanently; merely
    // ignoring it for this read could hide future events once the log regrows.
    try { unlinkSync(counterAckFile(sessionId, dir)); } catch { /* duplicate counting is safer */ }
    return total;
  }
  return total - acknowledged;
}

export function recordSubstantiveEvent(sessionId: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Append a marker line rather than read-modify-write: appends are atomic for
  // small writes, so concurrent hook processes can't clobber each other's count.
  appendFileSync(counterFile(sessionId, dir), '1\n');
}

export function resetSubstantiveCount(sessionId: string, dir: string): void {
  const file = counterFile(sessionId, dir);
  if (existsSync(file)) rmSync(file, { force: true });
  const ack = counterAckFile(sessionId, dir);
  if (existsSync(ack)) rmSync(ack, { force: true });
  const ackTemp = `${ack}.tmp`;
  if (existsSync(ackTemp)) rmSync(ackTemp, { force: true });
}

/**
 * Acknowledge only the activity covered by an emitted checkpoint rider while
 * preserving events appended after that rider. The event log itself remains
 * append-only. A separate monotonic offset is replaced atomically, so writers
 * that already hold the log fd cannot race with a rename/unlink of that log.
 *
 * Any failure is fail-open: the prior offset and the complete event log remain
 * readable, so a later Stop may ask for a duplicate checkpoint rather than
 * silently lose work.
 */
export function acknowledgeSubstantiveBaseline(
  sessionId: string,
  dir: string,
  baseline: number,
): boolean {
  if (!Number.isSafeInteger(baseline) || baseline < 0) return false;
  if (baseline === 0) return true;

  let lock: CounterAckLock | null;
  try {
    lock = acquireCounterAckLock(sessionId, dir);
  } catch {
    return false;
  }
  if (!lock) return false;

  const ack = counterAckFile(sessionId, dir);
  // The per-session lock makes a fixed temp name safe. If a process dies after
  // writing it, the next lock owner can discard it while the canonical offset
  // remains either wholly old or wholly new.
  const temp = `${ack}.tmp`;
  try {
    const previous = readCounterAckOffset(sessionId, dir);
    if (previous === null) return false;
    const total = countSubstantiveLogLines(counterFile(sessionId, dir));
    if (total - previous < baseline) return false;
    const next = previous + baseline;
    try { if (existsSync(temp)) unlinkSync(temp); } catch { return false; }
    writeFileSync(temp, `${next}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, ack);
    chmodSync(ack, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* stale temp is harmless */ }
    releaseCounterAckLock(lock);
  }
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

// --- Emitted rider marker (per session/turn) ------------------------------
// UserPromptSubmit and Stop execute in separate processes. A realtime setting
// alone therefore cannot prove that the model actually received a checkpoint
// rider. Record that fact only on the return path which carries the rider, then
// atomically consume it at the next Stop. This keeps Stop self-authoring as the
// fallback when session-init failed or no rider fired for this interval.

const RIDER_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
const RIDER_MARKER_MAX_ENTRIES = 256;
const RIDER_MARKER_LOCK_STALE_MS = 30_000;
const RIDER_MARKER_LOCK_NAME = '.rider-marker.lock';

interface RiderMarkerLock {
  path: string;
  owner: string;
}

function riderMarkerDirectory(stateDir: string): string {
  return join(stateDir, 'rider-emitted');
}

function riderMarkerName(sessionId: string): string {
  // Session ids can contain path separators or other user-controlled bytes.
  // A fixed digest prevents traversal and avoids exposing the raw id on disk.
  return `${createHash('sha256').update(sessionId).digest('hex')}.marker`;
}

function prepareRiderMarkerDirectory(stateDir: string, create: boolean): string | null {
  const dir = riderMarkerDirectory(stateDir);
  if (!existsSync(dir)) {
    if (!create) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe checkpoint rider marker directory: ${dir}`);
  }
  chmodSync(dir, 0o700);
  return dir;
}

function isRiderMarkerArtifact(name: string): boolean {
  return name.endsWith('.marker') || name.endsWith('.claim') || name.endsWith('.tmp');
}

function maintainRiderMarkers(dir: string): number {
  const now = Date.now();
  const entries = readdirSync(dir).filter(isRiderMarkerArtifact);
  // The directory is private and writers refuse to grow past this bound. The
  // +1 lets a caller detect a pre-existing over-cap directory without walking
  // an attacker-controlled number of files.
  for (const name of entries.slice(0, RIDER_MARKER_MAX_ENTRIES + 1)) {
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || now - stat.mtimeMs > RIDER_MARKER_TTL_MS) {
        unlinkSync(file);
      }
    } catch {
      // A concurrent Stop may have consumed the marker between readdir/lstat.
    }
  }
  return readdirSync(dir).filter(isRiderMarkerArtifact).length;
}

/**
 * Try once to take the cross-process marker-directory lock. Contention fails
 * open immediately: the caller leaves the substantive counter intact so Stop
 * can still self-author instead of delaying the UserPromptSubmit hook.
 */
function acquireRiderMarkerLock(dir: string): RiderMarkerLock | null {
  const path = join(dir, RIDER_MARKER_LOCK_NAME);
  const owner = `${process.pid}:${randomUUID()}`;
  const create = (): RiderMarkerLock | null => {
    try {
      writeFileSync(path, owner, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path, owner };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
  };

  const acquired = create();
  if (acquired) return acquired;

  // Recover an interrupted writer once. Rename is the atomic stale-lock claim:
  // only one breaker can move the old lock, and no breaker ever unlinks a
  // freshly acquired replacement at the canonical path.
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (Date.now() - stat.mtimeMs <= RIDER_MARKER_LOCK_STALE_MS) return null;
    const staleClaim = join(dir, `.${process.pid}.${randomUUID()}.claim`);
    renameSync(path, staleClaim);
    try { unlinkSync(staleClaim); } catch { /* marker maintenance reclaims it */ }
  } catch {
    return null;
  }
  return create();
}

function releaseRiderMarkerLock(lock: RiderMarkerLock): void {
  try {
    if (readFileSync(lock.path, 'utf8') === lock.owner) unlinkSync(lock.path);
  } catch {
    // A failed release is fail-open; the stale-lock path self-heals it.
  }
}

interface CheckpointRiderMarkerV1 {
  version: 1;
  baseline: number;
}

function parseCheckpointRiderMarker(raw: string): CheckpointRiderMarkerV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CheckpointRiderMarkerV1>;
    if (parsed.version !== 1) return null;
    if (!Number.isSafeInteger(parsed.baseline) || (parsed.baseline ?? -1) < 0) return null;
    return { version: 1, baseline: parsed.baseline! };
  } catch {
    // Legacy/corrupt markers cannot prove which activity the rider covered.
    return null;
  }
}

/** Mark that a checkpoint rider is present in the UserPromptSubmit output. */
export function markCheckpointRiderEmitted(
  sessionId: string,
  stateDir: string,
  baseline = 0,
): boolean {
  if (!Number.isSafeInteger(baseline) || baseline < 0) return false;
  const dir = prepareRiderMarkerDirectory(stateDir, true)!;
  let lock: RiderMarkerLock | null;
  try {
    lock = acquireRiderMarkerLock(dir);
  } catch {
    return false;
  }
  if (!lock) return false;

  try {
    const marker = join(dir, riderMarkerName(sessionId));
    const count = maintainRiderMarkers(dir);
    if (existsSync(marker)) return true;
    if (count >= RIDER_MARKER_MAX_ENTRIES) return false;

    const temp = join(dir, `.${process.pid}.${randomUUID()}.tmp`);
    try {
      const payload: CheckpointRiderMarkerV1 = { version: 1, baseline };
      writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, marker);
      chmodSync(marker, 0o600);
      return true;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  } catch {
    return false;
  } finally {
    releaseRiderMarkerLock(lock);
  }
}

/** Atomically consume and return the baseline covered by the next Stop. */
export function consumeCheckpointRiderBaseline(sessionId: string, stateDir: string): number | null {
  const dir = prepareRiderMarkerDirectory(stateDir, false);
  if (!dir) return null;
  maintainRiderMarkers(dir);
  const marker = join(dir, riderMarkerName(sessionId));
  const claim = join(dir, `.${process.pid}.${randomUUID()}.claim`);
  try {
    renameSync(marker, claim);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let baseline: number | null = null;
  try {
    baseline = parseCheckpointRiderMarker(readFileSync(claim, 'utf8'))?.baseline ?? null;
    // A successful rename is the atomic consume. Cleanup is best-effort; stale
    // claims are bounded and removed by maintainRiderMarkers().
    unlinkSync(claim);
  } catch {
    // Already consumed even if cleanup races or the process is interrupted.
  }
  return baseline;
}

/** Compatibility helper for callers that only need to invalidate evidence. */
export function consumeCheckpointRiderEmission(sessionId: string, stateDir: string): boolean {
  return consumeCheckpointRiderBaseline(sessionId, stateDir) !== null;
}
