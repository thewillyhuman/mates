# M7 — Hardening

Spec: §10 (security), §11 (chart), §14 (observability), §6.2 steps 4 and
7, §8.5 (GitHub App), §12 (`/settings/audit`), §15.2 (M7).

## Goal

Mates is safe and operable enough to run against real Jira and GitLab or
GitHub: locked-down networking and pod security, an audit trail of every
human action, OIDC sign-in, short-lived GitHub App tokens, external
secrets, bounded retention, metrics, notifications, a validated chart, and
the documents an operator needs.

## Plan

1. **Audit log** (§10.4): `audit_log` table, one row per mutating action
   with actor, action, target and details; written by the routes;
   `GET /api/settings/audit` and the Settings → Audit log tab.
2. **Metrics** (§14): `/metrics` with the listed gauges, counters and
   histograms through prom-client, fed by the orchestrator and adapters.
3. **Retention**: a daily job deletes transcript blobs older than
   `retention.transcripts_days` and runs that finished more than
   `retention.events_days` ago (cascading their events, blobs, usage).
4. **Notifications** (§6.2 step 7): Slack-compatible JSON to the configured
   webhook on `intake.needs_clarification`, `run.blocked`,
   `mr.marked_ready`, `run.failed` and `run.budget_exceeded`.
5. **Team context from git** (§6.2 step 4): fetch the repository archive
   through the configured provider's API (no git in the API image),
   `POST /api/settings/team-context/refresh`, a 5-minute poll, versions
   recorded with the ref and commit.
6. **OIDC** (§10.4): authorization code + PKCE with any compliant issuer,
   first OIDC user becomes admin on an empty instance, optional
   group → role mapping, `/api/auth/oidc/start` and `/callback`.
7. **GitHub App** (§8.5): installation tokens minted from the App's
   private key, refreshed before expiry; configured per provider.
8. **Chart**: NetworkPolicy (runner → DNS, API, egress; API ingress from
   runners and the ingress class), `values.schema.json`, OIDC and
   notifications values, `credentials.existingSecret` documented and
   tested, PSS `restricted` label on the namespace in the e2e.
9. **Docs**: README quickstart, `docs/operations.md` (backups, upgrades,
   scaling, troubleshooting a stuck run).

## Out of scope

SCM webhooks for MR state (may), per-project daily budgets (should,
deferred), phone layout (may).

## What changed from the plan

- **SCM API errors** are counted from `run.failed{reason: mr_failed}` on
  the event bus rather than inside the adapters, so the metric needs no
  wiring through the orchestrator; the team-context fetcher's failures
  surface in its log line and the audit entry instead.
- **GitHub App tokens** reach runner pods through the per-invocation Secret
  (decision 0019) instead of the credentials Secret, because they expire
  hourly and the credentials Secret is written only by humans.
- **ESO / existing-secret mode** was already in place since M1
  (`credentials.existingSecret`, decision 0004); M7 only documented and
  schema-validated it.
- **OIDC** keeps the pending login (state, nonce, PKCE verifier) in a
  ten-minute HttpOnly cookie scoped to `/api/auth/oidc`, so no server
  state is needed and a restarted API still completes a login in flight.
- Nothing in the spec's M7 list was dropped. Pod Security `restricted` is
  enforced by labelling the namespace in the kind e2e; the chart does not
  label the namespace itself because it rarely owns it.
