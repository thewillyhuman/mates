# 0017 — Team context fetched as a provider archive

Spec §6.2 step 4 ("git URL + ref, polled every 5 min"). Status: accepted,
2026-10-19.

## Decision

A git-sourced team context is fetched through the configured SCM
provider's archive endpoint (GitLab `repository/archive.tar.gz`, GitHub
`tarball/{ref}`, Gitea `archive/{ref}.tar.gz`) with the provider's token,
not with `git clone`. The source is `{ provider id, project, ref }`.

## Why

- The API image is distroless (decision 0001): no git binary, no shell.
- The provider token is already stored; the archive endpoint needs no
  extra credential or network path.
- The archive carries the commit sha, which is what the version history
  should show.

## Consequences

- A team context repository must live on a configured provider; an
  arbitrary git URL is not supported. The upload path remains for
  everything else.
- Archives have a top-level directory; the fetcher strips it.
