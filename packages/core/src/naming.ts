/** Branch and commit naming from `mates.yaml` `branching` (§6.3, §10.5). */

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export function slugify(title: string, max = 40): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > max / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
}

/** Renders `pattern` with `{ticket}` and `{slug}`. Throws on a malformed ticket key. */
export function branchName(pattern: string, ticketKey: string, title: string): string {
  if (!JIRA_KEY.test(ticketKey)) throw new Error(`invalid ticket key "${ticketKey}"`);
  return pattern.replaceAll('{ticket}', ticketKey).replaceAll('{slug}', slugify(title));
}

/**
 * `true` when `branch` could have been produced by `pattern` for any ticket
 * and title. The runner refuses to push anywhere else (§10.5).
 */
export function branchMatchesPattern(branch: string, pattern: string): boolean {
  const re = pattern
    .split(/(\{ticket\}|\{slug\})/)
    .map((part) => {
      if (part === '{ticket}') return '[A-Z][A-Z0-9_]+-\\d+';
      if (part === '{slug}') return '[a-z0-9-]*';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${re}$`).test(branch);
}

/** `<ticket>: <summary>` plus the configured trailer, e.g. `Jira: API-198`. */
export function commitMessage(ticketKey: string, summary: string, trailer: string): string {
  const title = `${ticketKey}: ${summary.trim().split('\n')[0] ?? ''}`.slice(0, 72);
  const rendered = trailer.replaceAll('{ticket}', ticketKey).trim();
  return rendered ? `${title}\n\n${rendered}\n` : `${title}\n`;
}
