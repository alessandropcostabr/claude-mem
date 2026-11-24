
import { logger } from './logger.js';

const TAG_NAMES = [
  'private',
  'claude-mem-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;
type TagName = (typeof TAG_NAMES)[number];
const MEMORY_TAG_NAMES = new Set<string>(TAG_NAMES);
const OPEN_TAG_NAME_RE = /<([A-Za-z_][A-Za-z0-9_-]*)/y;
const CLOSE_TAG_RE = /<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;

export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MAX_TAG_COUNT = 100;

function stripBalancedMemoryTags(input: string): {
  text: string;
  counts: Record<TagName, number>;
  total: number;
} {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  if (!input.includes('<')) return { text: input, counts, total: 0 };

  const len = input.length;
  const nextGt = new Int32Array(len + 1);
  nextGt[len] = len;
  for (let index = len - 1; index >= 0; index--) {
    nextGt[index] = input.charCodeAt(index) === 0x3e ? index : nextGt[index + 1];
  }

  const opens = new Map<TagName, {
    items: Array<{ start: number; attrEnd: number }>;
    head: number;
  }>();
  const removed: Array<[number, number]> = [];
  let total = 0;
  let index = 0;

  while (index < len) {
    if (input.charCodeAt(index) !== 0x3c) {
      index++;
      continue;
    }

    CLOSE_TAG_RE.lastIndex = index;
    const close = CLOSE_TAG_RE.exec(input);
    if (close) {
      const name = close[1] as TagName;
      const entry = opens.get(name);
      const open = entry && entry.head < entry.items.length ? entry.items[entry.head] : undefined;
      if (open && index >= open.attrEnd) {
        entry!.head++;
        removed.push([open.start, index + close[0].length]);
        counts[name]++;
        total++;
      }
      index += close[0].length;
      continue;
    }

    OPEN_TAG_NAME_RE.lastIndex = index;
    const open = OPEN_TAG_NAME_RE.exec(input);
    if (open && MEMORY_TAG_NAMES.has(open[1])) {
      const name = open[1] as TagName;
      const item = { start: index, attrEnd: nextGt[index + open[0].length] };
      const entry = opens.get(name);
      if (entry) entry.items.push(item);
      else opens.set(name, { items: [item], head: 0 });
      index += open[0].length;
      continue;
    }
    index++;
  }

  removed.sort((left, right) => left[0] - right[0]);
  let text = '';
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) text += input.slice(cursor, start);
    if (end > cursor) cursor = end;
  }
  text += input.slice(cursor);
  return { text, counts, total };
}

function finishStrippedTags(
  input: string,
  result: ReturnType<typeof stripBalancedMemoryTags>,
): { stripped: string; counts: Record<TagName, number> } {
  const { text, counts, total } = result;

  if (total > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length,
    });
  }

  return { stripped: text.trim(), counts };
}

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  return finishStrippedTags(input, stripBalancedMemoryTags(input));
}

export function stripMemoryTagsFromJson(content: string): string {
  return stripTags(content).stripped;
}

export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTags(content).stripped;
}

/** Strip memory-tag blocks from every string in a JSON-compatible value. */
export function stripMemoryTagsFromJsonStrings<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = stripBalancedMemoryTags(node);
      return result.total > 0 ? finishStrippedTags(node, result).stripped : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}

const PROTOCOL_ONLY_TAGS = ['task-notification'] as const;

const PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join('|')})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`,
);

const MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_PROTOCOL_PAYLOAD_BYTES) return false;
  return PROTOCOL_ONLY_REGEX.test(text);
}
