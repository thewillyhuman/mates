import { describe, expect, it } from 'vitest';
import { validateTeamManifest } from './manifest.js';

const good = `
version: 1
team:
  name: Payments platform
  conventions: docs/conventions.md
  extra_docs:
    - path: docs/testing.md
      about: How to run tests
repos:
  - id: webhook-service
    scm: gitlab
    project: platform/webhook-service
    default_branch: main
    jira_projects: [API]
    setup: pnpm install --frozen-lockfile
    test: pnpm test
branching:
  pattern: "mates/{ticket}-{slug}"
  commit_trailer: "Jira: {ticket}"
review:
  rubric: docs/review-rubric.md
  max_iterations: 3
`;

const files = new Set(['docs/conventions.md', 'docs/testing.md', 'docs/review-rubric.md']);
const ctx = { providers: ['gitlab', 'github'], fileExists: (p: string) => files.has(p) };

describe('validateTeamManifest', () => {
  it('accepts the §6.3 example and applies defaults', () => {
    const r = validateTeamManifest(good, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.team.conventions).toEqual(['docs/conventions.md']);
    expect(r.manifest.repos[0]).toMatchObject({ id: 'webhook-service', lint: '', env: {} });
    expect(r.manifest.review.max_iterations).toBe(3);
  });

  it('rejects invalid yaml and schema violations with paths', () => {
    expect(validateTeamManifest('version: [', ctx)).toMatchObject({ ok: false, manifest: null });
    const r = validateTeamManifest('version: 2\nteam: {name: x, conventions: a}\nrepos: []', ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/version/);
    expect(r.errors.join('\n')).toMatch(/repos/);
  });

  it('enforces unique repo ids, configured providers, existing paths and {ticket}', () => {
    const bad = good
      .replace('pattern: "mates/{ticket}-{slug}"', 'pattern: "mates/{slug}"')
      .replace('scm: gitlab', 'scm: bitbucket')
      .replace('conventions: docs/conventions.md', 'conventions: docs/missing.md')
      .replace(
        'branching:',
        '  - id: webhook-service\n    scm: github\n    project: a/b\nbranching:',
      );
    const r = validateTeamManifest(bad, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate id "webhook-service"'),
        expect.stringContaining('no source-control provider "bitbucket"'),
        expect.stringContaining('"docs/missing.md" does not exist'),
        'branching.pattern: must contain {ticket}',
      ]),
    );
    // Partially valid manifests are still returned so the UI can show them.
    expect(r.manifest).not.toBeNull();
  });
});
