import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOTS = ['src', 'scripts'];
const MANIFESTS = ['package.json', 'plugin/package.json'];
const FORBIDDEN = [
  'posthog-node',
  'api.posthog.com',
  'us.i.posthog.com',
  '@sentry/node',
  'mixpanel',
  'amplitude',
  'segment.io',
  'phc_',
];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|json)$/.test(entry)) files.push(path);
  }
  return files;
}

describe('telemetry-free fork policy', () => {
  it('keeps product analytics SDKs, keys, and endpoints out of executable sources', () => {
    const violations: string[] = [];
    for (const file of [...ROOTS.flatMap(sourceFiles), ...MANIFESTS]) {
      const content = readFileSync(file, 'utf8').toLowerCase();
      for (const marker of FORBIDDEN) {
        if (content.includes(marker)) violations.push(`${file}: ${marker}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
