# 0018 — Audit events in their own table

Spec §10.4 ("All mutating actions produce an audit event (`audit.*`)").
Status: accepted, 2026-10-19.

## Decision

Audit events live in `audit_log` (actor, action, target, details, ts),
not in the run event log. Run-scoped actions (cancel, nudge, retry) still
produce their run events; the audit row is in addition.

## Why

- Most audited actions have no run (settings, credentials, users).
- The run log is a projection input; mixing operator actions into it
  would complicate `projectRun` for no gain.

## Consequences

- `GET /api/settings/audit` pages the table newest first; the UI shows it
  under Settings → Audit log.
