# 0009 — Large artefacts stored in Postgres

Spec §4.3 ("large blobs are stored separately and referenced by id"), §7.3
step 7. Status: accepted, 2026-10-19.

## Decision

Test logs, per-iteration diffs and gzipped transcripts go into a `blobs`
table (`bytea`, capped at 32 MiB per blob) referenced by id from events.
Retention (§7.3, `retention.transcripts_days`) is a periodic delete.

## Why

- No object store is required to install Mates (§11: nothing but the chart
  on a plain cluster).
- Volumes are per invocation and the API is the only reader; Postgres
  handles tens of MiB per run comfortably.

## Consequences

- Backups include blobs; `docs/operations.md` sizes them.
- Switching to object storage later means replacing one repository module.
