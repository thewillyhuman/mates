import Mustache from 'mustache';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prompt templates (§7.4): Mustache files in `prompts/`, overridable from
 * Settings → Prompts. Rendering never HTML-escapes (prompts are markdown).
 */
export const PROMPT_NAMES = ['system', 'intake', 'implementer', 'reviewer'] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

/** Placeholders a template must keep for the mate to work. */
export const REQUIRED_PLACEHOLDERS: Record<PromptName, string[]> = {
  system: ['team_name', 'mate', 'conventions'],
  intake: ['ticket.key', 'ticket.description', 'repos'],
  implementer: ['ticket.key', 'branch', 'iteration'],
  reviewer: ['ticket.key', 'branch', 'iteration'],
};

export const PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../prompts',
);

const cache = new Map<PromptName, string>();

export async function defaultPrompt(name: PromptName): Promise<string> {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = await readFile(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  cache.set(name, text);
  return text;
}

/** Problems with a template: Mustache syntax errors and missing placeholders. */
export function validateTemplate(name: PromptName, text: string): string[] {
  const errors: string[] = [];
  try {
    Mustache.parse(text);
  } catch (err) {
    errors.push(`template syntax: ${(err as Error).message}`);
    return errors;
  }
  for (const ph of REQUIRED_PLACEHOLDERS[name]) {
    const re = new RegExp(`\\{\\{[#^/]?\\s*${ph.replace('.', '\\.')}\\s*\\}\\}`);
    if (!re.test(text)) errors.push(`missing placeholder {{${ph}}}`);
  }
  return errors;
}

export async function renderPrompt(
  name: PromptName,
  view: Record<string, unknown>,
  overrides: Record<string, string> = {},
): Promise<string> {
  const template = overrides[name] ?? (await defaultPrompt(name));
  return Mustache.render(template, view, {}, { escape: (v: unknown) => String(v) });
}
