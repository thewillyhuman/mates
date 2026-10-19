# 0019 — GitHub App tokens reach runners through the invocation Secret

Spec §8.5 (GitHub App, installation tokens), §7.2 (Job manifest),
§10.2 (no long-lived tokens in pods). Status: accepted, 2026-10-19.

## Decision

For a provider configured with GitHub App authentication, the API mints
an installation token when it creates an invocation's Job and stores it
under `git_token` in the per-invocation Secret, the same Secret that
holds `MATES_INVOCATION_TOKEN`. The pod's `GIT_TOKEN` env points there.
Providers with a personal access token keep reading the credentials
Secret, as before.

## Why

- Installation tokens expire after one hour, so writing them into the
  credentials Secret would turn a human-managed Secret into a rotating
  one and race with the UI's credential writes.
- The per-invocation Secret already exists, is owned by the Job and is
  garbage-collected with it, which is exactly the token's lifetime.
- The runner stays unaware of the auth mode: its credential helper reads
  `GIT_USERNAME` and `GIT_TOKEN` either way.

## Consequences

- An invocation that runs longer than the token's remaining life cannot
  push. The API renews tokens five minutes before expiry and mints at
  Job creation, so an invocation has at least 55 minutes; keep
  `mates.<mate>.timeout_seconds` under that for App providers.
- The API caches one token per provider; a change of App id,
  installation id, base URL or key invalidates the cache.
