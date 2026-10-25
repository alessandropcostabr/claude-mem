// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { basename, join } from 'path';
import { CreateAgentEventSchema } from '../../core/schemas/agent-event.js';
import { resolveDataDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  isServerBetaClientError,
  type ServerBetaClient,
  type ServerBetaRecordEventRequest,
  type ServerBetaRequestOptions,
} from './server-beta-client.js';

const SPOOL_VERSION = 1;
const STALE_CLAIM_MS = 30_000;
const STALE_TEMPORARY_MS = 30_000;
const QUEUE_LOCK_WAIT_MS = 100;
const QUEUE_LOCK_POLL_MS = 5;
export const SERVER_BETA_EVENT_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const SERVER_BETA_EVENT_ARCHIVE_RETENTION_MS = 24 * 60 * 60 * 1_000;
// Keep every synchronous scan small enough to fit comfortably inside the
// 5-second Codex hook budget, even while the server is unavailable.
export const SERVER_BETA_EVENT_MAX_PENDING_ENTRIES = 256;
export const SERVER_BETA_EVENT_MAX_PENDING_BYTES = 32 * 1024 * 1024;
export const SERVER_BETA_EVENT_MAX_ARCHIVE_ENTRIES = 256;
export const SERVER_BETA_EVENT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

interface ServerBetaEventSpoolEntry {
  version: typeof SPOOL_VERSION;
  id: string;
  createdAtEpoch: number;
  event: ServerBetaRecordEventRequest;
}

export interface ServerBetaEventSpoolOptions {
  now?: () => number;
  retryWindowMs?: number;
  archiveRetentionMs?: number;
  maxPendingEntries?: number;
  maxPendingBytes?: number;
  maxArchiveEntries?: number;
  maxArchiveBytes?: number;
}

export type ServerBetaEventReplayResult =
  | { status: 'empty' }
  | { status: 'replayed'; id: string }
  | { status: 'quarantined'; id?: string }
  | { status: 'deferred'; id?: string };

function defaultSpoolDirectory(): string {
  return join(resolveDataDir(), 'state', 'server-beta-event-spool');
}

function stableEntryId(event: ServerBetaRecordEventRequest): string {
  if (event.sourceEventId) {
    return createHash('sha256')
      .update(`${event.projectId}\0${event.contentSessionId ?? ''}\0${event.platformSource ?? ''}\0${event.sourceType}\0${event.sourceEventId}`)
      .digest('hex');
  }
  return randomUUID().replaceAll('-', '');
}

function isPendingFilename(filename: string): boolean {
  return /^[a-f0-9]{32,64}\.json$/.test(filename);
}

function isClaimFilename(filename: string): boolean {
  return /^[a-f0-9]{32,64}\.json\.sending-\d+-[a-f0-9]+$/.test(filename);
}

function isTemporaryFilename(filename: string): boolean {
  return /^\.[a-f0-9]{32,64}\.\d+\.[a-f0-9-]+\.tmp$/.test(filename);
}

function isLegacyEntryLockFilename(filename: string): boolean {
  return /^[a-f0-9]{32,64}\.lock$/.test(filename);
}

function entryIdFromFilename(filename: string): string | null {
  const match = filename.match(/^([a-f0-9]{32,64})\.json(?:\.sending-.*)?$/);
  return match?.[1] ?? null;
}

function isPermanentReplayError(error: unknown): boolean {
  if (!isServerBetaClientError(error) || error.kind !== 'http_error' || error.status === null) {
    return false;
  }
  return error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status);
}

function waitSynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export class ServerBetaEventSpool {
  private readonly now: () => number;
  private readonly retryWindowMs: number;
  private readonly archiveRetentionMs: number;
  private readonly maxPendingEntries: number;
  private readonly maxPendingBytes: number;
  private readonly maxArchiveEntries: number;
  private readonly maxArchiveBytes: number;

  constructor(
    private readonly directory = defaultSpoolDirectory(),
    options: ServerBetaEventSpoolOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retryWindowMs = options.retryWindowMs ?? SERVER_BETA_EVENT_RETRY_WINDOW_MS;
    this.archiveRetentionMs = options.archiveRetentionMs ?? SERVER_BETA_EVENT_ARCHIVE_RETENTION_MS;
    this.maxPendingEntries = options.maxPendingEntries ?? SERVER_BETA_EVENT_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = options.maxPendingBytes ?? SERVER_BETA_EVENT_MAX_PENDING_BYTES;
    this.maxArchiveEntries = options.maxArchiveEntries ?? SERVER_BETA_EVENT_MAX_ARCHIVE_ENTRIES;
    this.maxArchiveBytes = options.maxArchiveBytes ?? SERVER_BETA_EVENT_MAX_ARCHIVE_BYTES;
  }

  enqueue(event: ServerBetaRecordEventRequest): string {
    this.ensureDirectory();
    const validation = CreateAgentEventSchema.safeParse(event);
    if (!validation.success) {
      throw new Error(`invalid server-beta event: ${validation.error.issues[0]?.message ?? 'schema mismatch'}`);
    }

    const id = stableEntryId(event);
    const entry: ServerBetaEventSpoolEntry = {
      version: SPOOL_VERSION,
      id,
      createdAtEpoch: this.now(),
      event,
    };
    const serialized = JSON.stringify(entry);
    const serializedBytes = Buffer.byteLength(serialized);

    return this.withQueueLock(() => {
      this.maintainBounded();
      if (this.hasOutstandingEntry(id)) return id;
      this.assertCapacity(serializedBytes);

      const destination = join(this.directory, `${id}.json`);
      const temporary = join(this.directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
      let fd: number | null = null;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, serialized, 'utf8');
        closeSync(fd);
        fd = null;
        renameSync(temporary, destination);
        chmodSync(destination, 0o600);
        return id;
      } catch (error) {
        if (fd !== null) closeSync(fd);
        try { unlinkSync(temporary); } catch { /* best effort */ }
        throw error;
      }
    });
  }

  pendingCount(): number {
    try {
      this.ensureDirectory();
      return this.withQueueLock(() => {
        this.maintainBounded();
        return readdirSync(this.directory)
          .filter(name => isPendingFilename(name) || isClaimFilename(name))
          .slice(0, this.maxPendingEntries + 1)
          .length;
      });
    } catch {
      return 0;
    }
  }

  async replayOne(
    send: (event: ServerBetaRecordEventRequest, options: ServerBetaRequestOptions) => Promise<unknown>,
    options: ServerBetaRequestOptions,
  ): Promise<ServerBetaEventReplayResult> {
    this.ensureDirectory();
    const claimed = this.withQueueLock(() => {
      this.maintainBounded();
      const candidate = this.oldestPendingEntry();
      if (!candidate) return null;

      const id = entryIdFromFilename(candidate.filename);
      if (!id) return null;
      const original = join(this.directory, candidate.filename);
      const claim = `${original}.sending-${process.pid}-${randomUUID().replaceAll('-', '')}`;
      try {
        renameSync(original, claim);
        // rename preserves the old mtime. Touch the claim so stale recovery
        // measures the active send, not the pending age.
        const claimedAt = new Date(this.now());
        utimesSync(claim, claimedAt, claimedAt);
        return { id, original, claim };
      } catch {
        return null;
      }
    });

    if (!claimed) return { status: 'empty' };

    let entry: ServerBetaEventSpoolEntry;
    try {
      const parsed = JSON.parse(readFileSync(claimed.claim, 'utf8')) as ServerBetaEventSpoolEntry;
      const validation = CreateAgentEventSchema.safeParse(parsed?.event);
      if (parsed?.version !== SPOOL_VERSION || parsed.id !== claimed.id || !validation.success) {
        throw new Error('unsupported or malformed spool entry');
      }
      entry = parsed;
    } catch (error: unknown) {
      this.archiveClaim(claimed.claim, 'quarantine', 'corrupt');
      logger.warn('HOOK', 'Quarantined invalid server-beta event spool entry', {
        id: claimed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'quarantined', id: claimed.id };
    }

    try {
      await send(entry.event, options);
      unlinkSync(claimed.claim);
      return { status: 'replayed', id: entry.id };
    } catch (error: unknown) {
      if (isPermanentReplayError(error)) {
        this.archiveClaim(claimed.claim, 'quarantine', 'rejected');
        logger.warn('HOOK', 'Quarantined permanently rejected server-beta event spool entry', {
          id: entry.id,
          status: isServerBetaClientError(error) ? error.status : null,
        });
        return { status: 'quarantined', id: entry.id };
      }
      try {
        this.withQueueLock(() => {
          if (existsSync(claimed.original)) unlinkSync(claimed.claim);
          else renameSync(claimed.claim, claimed.original);
        });
      } catch { /* leave claim for stale recovery */ }
      logger.debug('HOOK', 'Server-beta event spool replay deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'deferred', id: entry.id };
    }
  }

  private ensureDirectory(): void {
    if (existsSync(this.directory)) {
      const metadata = lstatSync(this.directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`server-beta event spool path is not a real directory: ${this.directory}`);
      }
      chmodSync(this.directory, 0o700);
      return;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private ensurePrivateSubdirectory(name: 'quarantine' | 'expired'): string {
    const directory = join(this.directory, name);
    if (existsSync(directory)) {
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`server-beta event spool ${name} path is not a real directory`);
      }
    } else {
      mkdirSync(directory, { mode: 0o700 });
    }
    chmodSync(directory, 0o700);
    return directory;
  }

  private withQueueLock<T>(operation: () => T): T {
    const lock = this.acquireQueueLock();
    try {
      return operation();
    } finally {
      try { unlinkSync(lock); } catch { /* stale-lock recovery handles crashes */ }
    }
  }

  private acquireQueueLock(): string {
    const lock = join(this.directory, '.queue.lock');
    const deadline = Date.now() + QUEUE_LOCK_WAIT_MS;
    while (true) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        closeSync(fd);
        return lock;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs >= STALE_CLAIM_MS) {
            unlinkSync(lock);
            continue;
          }
        } catch { /* owner released it */ }
        if (Date.now() >= deadline) {
          throw new Error('server-beta event spool queue lock busy');
        }
        waitSynchronously(QUEUE_LOCK_POLL_MS);
      }
    }
  }

  private maintainBounded(): void {
    this.recoverStaleClaims();
    this.removeStaleTemporaryFiles();
    this.expireOneOldEntry();
    this.pruneArchive('quarantine');
    this.pruneArchive('expired');
  }

  private hasOutstandingEntry(id: string): boolean {
    const pendingName = `${id}.json`;
    return readdirSync(this.directory).some(
      name => name === pendingName || name.startsWith(`${pendingName}.sending-`),
    );
  }

  private oldestPendingEntry(): { filename: string; mtimeMs: number } | null {
    const entries = readdirSync(this.directory)
      .filter(isPendingFilename)
      .slice(0, this.maxPendingEntries + 1)
      .flatMap(filename => {
        try {
          return [{ filename, mtimeMs: statSync(join(this.directory, filename)).mtimeMs }];
        } catch {
          return [];
        }
      });
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.filename.localeCompare(right.filename));
    return entries[0] ?? null;
  }

  private archiveClaim(claim: string, archiveName: 'quarantine' | 'expired', reason: string): void {
    try {
      this.withQueueLock(() => {
        const directory = this.ensurePrivateSubdirectory(archiveName);
        const incomingBytes = statSync(claim).size;
        this.ensureArchiveCapacity(directory, incomingBytes);
        const target = join(directory, `${basename(claim)}.${reason}-${this.now()}`);
        renameSync(claim, target);
        chmodSync(target, 0o600);
        const archivedAt = new Date(this.now());
        utimesSync(target, archivedAt, archivedAt);
      });
    } catch {
      // Leave the claim for stale recovery rather than deleting evidence.
    }
  }

  private expireOneOldEntry(): void {
    const oldest = this.oldestPendingEntry();
    if (!oldest || oldest.mtimeMs >= this.now() - this.retryWindowMs) return;
    const source = join(this.directory, oldest.filename);
    const directory = this.ensurePrivateSubdirectory('expired');
    try {
      const incomingBytes = statSync(source).size;
      this.ensureArchiveCapacity(directory, incomingBytes);
      const target = join(directory, `${oldest.filename}.expired-${this.now()}`);
      renameSync(source, target);
      chmodSync(target, 0o600);
      const archivedAt = new Date(this.now());
      utimesSync(target, archivedAt, archivedAt);
      logger.error('HOOK', 'Server-beta event spool entry exceeded its retry window; moved to expired', {
        filename: oldest.filename,
        retryWindowMs: this.retryWindowMs,
      });
    } catch (error: unknown) {
      logger.warn('HOOK', 'Could not expire old server-beta event spool entry', {
        filename: oldest.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private assertCapacity(incomingBytes: number): void {
    if (incomingBytes > this.maxPendingBytes) {
      throw new Error(`server-beta event spool capacity exceeded (incoming ${incomingBytes} bytes)`);
    }
    let entries = 0;
    let bytes = 0;
    for (const filename of readdirSync(this.directory)) {
      if (!isPendingFilename(filename) && !isClaimFilename(filename) && !isTemporaryFilename(filename)) continue;
      entries += 1;
      if (entries > this.maxPendingEntries) break;
      try { bytes += statSync(join(this.directory, filename)).size; } catch { /* concurrent replay */ }
      if (bytes + incomingBytes > this.maxPendingBytes) break;
    }
    if (entries >= this.maxPendingEntries || bytes + incomingBytes > this.maxPendingBytes) {
      throw new Error(`server-beta event spool capacity exceeded (${entries} entries, ${bytes} bytes)`);
    }
  }

  private recoverStaleClaims(): void {
    const now = this.now();
    let inspected = 0;
    for (const filename of readdirSync(this.directory)) {
      if (!isLegacyEntryLockFilename(filename) && !isClaimFilename(filename)) continue;
      inspected += 1;
      if (inspected > this.maxPendingEntries + 1) break;
      const path = join(this.directory, filename);
      try {
        if (now - statSync(path).mtimeMs < STALE_CLAIM_MS) continue;
        if (isLegacyEntryLockFilename(filename)) {
          unlinkSync(path);
          continue;
        }
        const original = path.replace(/\.sending-\d+-[a-f0-9]+$/, '');
        if (existsSync(original)) unlinkSync(path);
        else renameSync(path, original);
      } catch {
        // Another hook may own or have completed the claim.
      }
    }
  }

  private removeStaleTemporaryFiles(): void {
    const now = this.now();
    let inspected = 0;
    for (const filename of readdirSync(this.directory)) {
      if (!isTemporaryFilename(filename)) continue;
      inspected += 1;
      if (inspected > this.maxPendingEntries + 1) break;
      const path = join(this.directory, filename);
      try {
        if (now - statSync(path).mtimeMs >= STALE_TEMPORARY_MS) unlinkSync(path);
      } catch {
        // A live enqueue may have completed the atomic rename.
      }
    }
  }

  private pruneArchive(name: 'quarantine' | 'expired'): void {
    const directory = join(this.directory, name);
    if (!existsSync(directory)) return;
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`server-beta event spool ${name} path is not a real directory`);
    }

    const cutoff = this.now() - this.archiveRetentionMs;
    const entries = this.readArchiveEntries(directory);
    for (const entry of entries.filter(item => item.mtimeMs < cutoff)) {
      try {
        unlinkSync(join(directory, entry.filename));
        logger.warn('HOOK', 'Removed expired server-beta event archive entry', { archive: name, filename: entry.filename });
      } catch { /* concurrent cleanup */ }
    }
    this.trimArchiveToLimits(directory);
  }

  private ensureArchiveCapacity(directory: string, incomingBytes: number): void {
    this.trimArchiveToLimits(directory, incomingBytes, 1);
  }

  private trimArchiveToLimits(directory: string, incomingBytes = 0, incomingEntries = 0): void {
    const entries = this.readArchiveEntries(directory);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (count + incomingEntries <= this.maxArchiveEntries && bytes + incomingBytes <= this.maxArchiveBytes) break;
      try {
        unlinkSync(join(directory, entry.filename));
        count -= 1;
        bytes -= entry.size;
        logger.warn('HOOK', 'Pruned server-beta event archive entry to enforce retention limits', {
          filename: entry.filename,
        });
      } catch { /* concurrent cleanup */ }
    }
    if (count + incomingEntries > this.maxArchiveEntries || bytes + incomingBytes > this.maxArchiveBytes) {
      throw new Error('server-beta event archive capacity exceeded');
    }
  }

  private readArchiveEntries(directory: string): Array<{ filename: string; mtimeMs: number; size: number }> {
    const entries = readdirSync(directory)
      .slice(0, this.maxArchiveEntries + 1)
      .flatMap(filename => {
        try {
          const metadata = statSync(join(directory, filename));
          return [{ filename, mtimeMs: metadata.mtimeMs, size: metadata.size }];
        } catch {
          return [];
        }
      });
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.filename.localeCompare(right.filename));
    return entries;
  }
}

let defaultSpool: ServerBetaEventSpool | null = null;

function getDefaultSpool(): ServerBetaEventSpool {
  defaultSpool ??= new ServerBetaEventSpool();
  return defaultSpool;
}

export function spoolServerBetaEvent(event: ServerBetaRecordEventRequest): string {
  return getDefaultSpool().enqueue(event);
}

export async function replayOneServerBetaEvent(
  client: ServerBetaClient,
  options: ServerBetaRequestOptions,
): Promise<ServerBetaEventReplayResult> {
  return getDefaultSpool().replayOne(
    (event, requestOptions) => client.recordEvent(event, requestOptions),
    options,
  );
}
