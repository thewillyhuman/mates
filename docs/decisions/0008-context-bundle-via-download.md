# 0008 — Invocation context delivered by download only

Spec §7.2, §17.3. Status: accepted, 2026-10-19.

## Decision

The runner always fetches its context bundle from
`GET /internal/invocations/{id}/context` (a tar.gz) with its JWT and
extracts it into an emptyDir mounted at `/context`. No ConfigMap is
created.

## Why

- The download path is mandatory anyway; the ConfigMap is an optimisation
  with a 1 MiB ceiling that a team-context package can exceed at any time.
- One path means one thing to test and nothing to garbage-collect.

## Consequences

- `/context` is writable (emptyDir) rather than a read-only ConfigMap
  mount; the runner treats it as read-only after extraction.
- The API must serve the bundle for as long as the Job can start, i.e.
  while the invocation is `pending` or `running`.
