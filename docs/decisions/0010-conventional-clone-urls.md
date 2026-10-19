# 0010 — Clone URLs derived from provider base URL until M3

Spec §8 (`Scm.resolveRepo`), §16 ordering. Status: accepted, 2026-10-19;
superseded when the SCM adapters land in M3.

## Decision

In M2 the clone URL for a repository is
`<provider base URL>/<project>.git` and the default branch is the one in
`mates.yaml`. The credential is `<username>:<token>` per provider type
(`oauth2` for GitLab, `x-access-token` for GitHub, the configured user for
a generic git host such as Gitea).

## Why

- GitHub, GitLab and Gitea all follow that convention, so the runner can be
  exercised end to end before the API adapters exist, as §16 requires
  (runner before adapters).

## Consequences

- M3's adapters replace this with `resolveRepo`; the runner contract
  (`invocation.json` with `clone_url`, `base_branch`, `branch`) does not
  change.
