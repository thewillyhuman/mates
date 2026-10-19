# 0006 — Migration Job runs post-install, pre-upgrade

Spec §11 lists `migration-job.yaml (hook: pre-install, pre-upgrade)`.
Status: accepted deviation, 2026-10-19.

## Decision

The migration Job is a `post-install,pre-upgrade` hook. `mates-api` also
applies pending migrations at start-up under a Postgres advisory lock.

## Why

With the bundled database (decision 0003) nothing is listening before the
chart's main resources exist, so a `pre-install` Job can only wait and time
out. Running it after install keeps the fresh-install path working while
`pre-upgrade` still guarantees the schema is current before new API pods
roll out. The start-up migration makes the API self-sufficient for local
development and for the first install; the advisory lock makes the two
paths safe to run concurrently.

## Consequences

- On a fresh install the API pod, not the Job, usually applies the schema.
- Operators using an external database may run the Job manually before
  install with `helm template ... -s templates/migration-job.yaml | kubectl apply -f -`.
