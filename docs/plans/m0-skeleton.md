# M0 — Skeleton

Spec: MATES-SPEC.md §15.2 (M0), §3.3, §6.1, §11.

## Goal

A repository that builds, lints, tests and ships two container images, and a
Helm chart that installs on a plain `kind` cluster with a bundled Postgres.
After install, `/readyz` is green and `/setup` can create the first admin.

## Plan

1. **Layout** — pnpm workspace with four packages:
   - `packages/core` (`@mates/core`): pure domain code shared by API, runner
     and UI (event types, `projectRun`, redaction, `mates.yaml` validation…).
     No I/O, no framework imports.
   - `packages/api` (`mates-api`): control plane. Fastify, `pg`, plain SQL
     migrations, Kubernetes client.
   - `packages/runner` (`mates-runner`): the `mates-run` wrapper.
   - `packages/ui` (`mates-ui`): React + Vite SPA, built into `packages/api`'s
     static dir at image build time.
   - `charts/mates`: Helm chart. `fixtures/claude`: fake-Claude transcripts.
2. **CI** — GitHub Actions: lint (eslint + prettier), typecheck, unit tests,
   `helm lint` + `helm template | kubeconform`, image builds. A `kind` smoke
   job installs the chart and waits for `/readyz`.
3. **API skeleton** — config from env (validated at start, fails loudly),
   structured logs (pino), `/healthz`, `/readyz` (DB reachable + migrations
   applied + Kubernetes API reachable when running in-cluster), migration
   runner, `users` + `sessions` tables, bootstrap token (§6.1),
   `POST /api/setup/bootstrap`, `POST /api/auth/login|logout`, `GET /api/auth/me`.
4. **Images** — `Dockerfile` per service, multi-arch, distroless for the API,
   Debian slim for the runner with Claude Code pinned.
5. **Chart** — API Deployment/Service/SA/Role/RoleBinding, runner SA,
   bundled Postgres StatefulSet, migration Job hook, internal + credentials
   Secrets, `NOTES.txt` with the bootstrap command.
6. **Docs** — `docs/decisions/` with the choices made here; `CHANGELOG.md`.

## Out of scope for M0

Orchestrator, adapters, event log, SSE, the UI pages. The UI package only
contains a login + setup page so the chart can be exercised end to end.

## What changed from the plan

- `packages/core` is not created yet: nothing in M0 needs shared domain code,
  and an empty package is boilerplate. It arrives with the event model in M1.
- The migration Job is `post-install,pre-upgrade` instead of `pre-install`
  (decision 0006): the bundled database does not exist before the hooks run.
- Internal, credentials and bundled-Postgres Secrets are `pre-install` hooks
  with `resource-policy: keep`, so `helm upgrade` never regenerates keys or
  wipes credentials the API wrote.
- Verified locally on kind v0.33 with Helm 4: `scripts/kind-smoke.sh` installs
  the chart, waits for `/readyz`, reads the bootstrap token from the Secret
  and completes setup over the API.
- The UI ships a setup page, a login page and the app shell with the
  mockup's design tokens; the board is an empty state until M6.
