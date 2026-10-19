import {
  addressedBlockSchema,
  claudeResultSchema,
  type AddressedBlock,
  type ClaudeResult,
} from '@mates/core';

/**
 * stream-json parsing (§7.3 steps 4–5). Only `type`, `subtype`,
 * `message.content`, `message.usage` and the `result` fields are relied
 * upon; everything else is carried along and ignored.
 */
export interface StreamLine {
  type: string;
  subtype?: string;
  [k: string]: unknown;
}

export type Condensed =
  | { kind: 'tool_use'; tool: string; summary: string; input: Record<string, unknown>; id: string }
  | { kind: 'tool_result'; toolUseId: string; content: string }
  | { kind: 'text'; text: string }
  | { kind: 'api_retry'; note: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'result'; result: ClaudeResult };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function parseStreamLine(line: string): StreamLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string')
      return v as StreamLine;
    return null;
  } catch {
    return null;
  }
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function shortPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  return p.replace(/^\/workspace\/repo\//, '').replace(/^\/workspace\//, '');
}

function lineCount(s: unknown): number {
  return typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0;
}

/** One line per tool call for the live tail: `read src/x.ts`, `run pnpm test`, `edit src/y.ts (+12 −3)`. */
export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `read ${shortPath(input.file_path)}`;
    case 'Edit':
      return `edit ${shortPath(input.file_path)} (+${lineCount(input.new_string)} −${lineCount(input.old_string)})`;
    case 'Write':
      return `write ${shortPath(input.file_path)} (${lineCount(input.content)} lines)`;
    case 'Bash':
      return `run ${str(input.command).replace(/\s+/g, ' ').slice(0, 160)}`;
    case 'Glob':
      return `glob ${str(input.pattern)}`;
    case 'Grep':
      return `grep ${str(input.pattern)}${input.path ? ` in ${shortPath(input.path)}` : ''}`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return `${name.toLowerCase()} ${first ? first.slice(0, 120) : ''}`.trim();
    }
  }
}

/** Turns one stream line into zero or more condensed records. */
export function condense(line: StreamLine): Condensed[] {
  if (line.type === 'system' && line.subtype === 'api_retry') {
    const attempt = n(line.attempt);
    const err = typeof line.error === 'string' ? line.error : 'api error';
    return [{ kind: 'api_retry', note: `API retry ${attempt || ''}: ${err}`.replace('  ', ' ') }];
  }
  if (line.type === 'assistant') {
    const message = line.message as
      { content?: unknown; usage?: Record<string, unknown> } | undefined;
    const out: Condensed[] = [];
    const content = Array.isArray(message?.content)
      ? (message.content as Record<string, unknown>[])
      : [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        out.push({
          kind: 'tool_use',
          tool: block.name,
          summary: summarizeToolUse(block.name, input),
          input,
          id: typeof block.id === 'string' ? block.id : '',
        });
      }
    }
    if (message?.usage) {
      const u = message.usage;
      out.push({
        kind: 'usage',
        usage: {
          input_tokens: n(u.input_tokens),
          output_tokens: n(u.output_tokens),
          cache_read_tokens: n(u.cache_read_input_tokens),
          cache_write_tokens: n(u.cache_creation_input_tokens),
        },
      });
    }
    return out;
  }
  if (line.type === 'user') {
    const message = line.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as Record<string, unknown>[])
      : [];
    return content
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({
        kind: 'tool_result' as const,
        toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
        content: toolResultText(b.content),
      }));
  }
  if (line.type === 'result') {
    const parsed = claudeResultSchema.safeParse(line);
    return [{ kind: 'result', result: parsed.success ? parsed.data : { type: 'result' } }];
  }
  return [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

/** Sums usage records, as the live estimate before the final result (§9.1). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
  };
}

/**
 * Finds the implementer's closing JSON block (§7.4): the last fenced
 * ```json block, or the last `{...}` containing "addressed", in `text`.
 */
export function extractAddressedBlock(text: string): AddressedBlock | null {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!);
  const bare = text.match(/\{[^{}]*"addressed"[\s\S]*\}/g);
  if (bare) candidates.push(...bare);
  for (const c of candidates.reverse()) {
    try {
      const parsed = addressedBlockSchema.safeParse(JSON.parse(c.trim()));
      if (parsed.success && 'addressed' in (JSON.parse(c.trim()) as object)) return parsed.data;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}
