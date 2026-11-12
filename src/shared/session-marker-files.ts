import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { resolveDataDir } from './paths.js';
import { logger } from '../utils/logger.js';

const SAFE_MARKER_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionMarkerFiles {
  has(key: string): boolean;
  mark(key: string): void;
  clear(key: string): void;
  take(key: string): boolean;
}

/** Small, fail-open markers shared by independent hook processes. */
export function sessionMarkerFiles(directoryName: string, logLabel: string): SessionMarkerFiles {
  function markerPath(key: string): string {
    const name = SAFE_MARKER_KEY.test(key)
      ? key
      : `sha256-${createHash('sha256').update(key).digest('hex')}`;
    return join(resolveDataDir(), 'state', directoryName, name);
  }

  function warnFailedOpen(operation: string, error: unknown): void {
    logger.warn('HOOK', `${logLabel}: ${operation} failed open`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    has(key) {
      try {
        return existsSync(markerPath(key));
      } catch (error) {
        warnFailedOpen('has', error);
        return false;
      }
    },
    mark(key) {
      try {
        const marker = markerPath(key);
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, new Date().toISOString());
      } catch (error) {
        warnFailedOpen('mark', error);
      }
    },
    clear(key) {
      try {
        rmSync(markerPath(key), { force: true });
      } catch (error) {
        warnFailedOpen('clear', error);
      }
    },
    take(key) {
      try {
        unlinkSync(markerPath(key));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          warnFailedOpen('take', error);
        }
        return false;
      }
    },
  };
}
