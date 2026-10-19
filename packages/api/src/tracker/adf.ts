/**
 * Atlassian Document Format ↔ markdown, the small subset Jira Cloud needs:
 * paragraphs, headings, lists, code blocks, inline marks, links, mentions
 * and hard breaks. Unknown nodes degrade to their text.
 */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

function inline(node: AdfNode): string {
  if (node.type === 'text') {
    let t = node.text ?? '';
    for (const m of node.marks ?? []) {
      if (m.type === 'code') t = `\`${t}\``;
      else if (m.type === 'strong') t = `**${t}**`;
      else if (m.type === 'em') t = `_${t}_`;
      else if (m.type === 'link') t = `[${t}](${str(m.attrs?.href)})`;
    }
    return t;
  }
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention')
    return `@${str(node.attrs?.text ?? node.attrs?.id).replace(/^@/, '')}`;
  if (node.type === 'emoji') return str(node.attrs?.text ?? node.attrs?.shortName);
  if (node.type === 'inlineCard') return str(node.attrs?.url);
  return (node.content ?? []).map(inline).join('');
}

function block(node: AdfNode, depth = 0): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'doc':
      return children
        .map((c) => block(c, depth))
        .filter(Boolean)
        .join('\n\n');
    case 'paragraph':
      return children.map(inline).join('');
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1) || 1)} ${children.map(inline).join('')}`;
    case 'bulletList':
      return children.map((li) => `${'  '.repeat(depth)}- ${listItem(li, depth)}`).join('\n');
    case 'orderedList':
      return children
        .map((li, i) => `${'  '.repeat(depth)}${i + 1}. ${listItem(li, depth)}`)
        .join('\n');
    case 'codeBlock':
      return `\`\`\`${str(node.attrs?.language)}\n${children.map(inline).join('')}\n\`\`\``;
    case 'blockquote':
      return children
        .map((c) => block(c, depth))
        .join('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'panel':
    case 'expand':
    case 'table':
    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
    case 'mediaSingle':
    case 'mediaGroup':
    default:
      return children
        .map((c) => block(c, depth))
        .filter(Boolean)
        .join('\n');
  }
}

function listItem(li: AdfNode, depth: number): string {
  const parts = (li.content ?? []).map((c) =>
    c.type === 'bulletList' || c.type === 'orderedList'
      ? `\n${block(c, depth + 1)}`
      : block(c, depth),
  );
  return parts.join('');
}

export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return typeof doc === 'string' ? doc : '';
  return block(doc as AdfNode).trim();
}

/** Markdown → ADF, paragraphs with links and inline code only (enough for Mates' comments). */
export function markdownToAdf(markdown: string): AdfNode {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({ type: 'paragraph', content: inlineFromMarkdown(p) })),
  } as AdfNode & { version: number };
}

function inlineFromMarkdown(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\n/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] });
    } else if (m[3] !== undefined) {
      out.push({ type: 'text', text: m[3], marks: [{ type: 'code' }] });
    } else {
      out.push({ type: 'hardBreak' });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.length ? out : [{ type: 'text', text }];
}
