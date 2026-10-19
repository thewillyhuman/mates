# Mates

Autonomous ticket-to-merge-request agents for Jira + GitLab/GitHub, built on
Claude Code, deployed on Kubernetes. A human assigns a Jira ticket to Mates;
an intake mate checks it is implementable, an implementer mate writes the
change in its own pod, a reviewer mate reviews it with a clean context, and
the loop ends with a reviewed draft-then-ready merge request. Humans watch,
nudge and merge.

The full specification is [MATES-SPEC.md](MATES-SPEC.md). Implementation
status per milestone is in [CHANGELOG.md](CHANGELOG.md); plans are in
`docs/plans/` and recorded decisions in `docs/decisions/`.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Shared domain code: event types, `projectRun`, redaction, validation. No I/O. |
| `packages/api` | `mates-api`: control plane (HTTP API, orchestrator, adapters, Kubernetes jobs). |
| `packages/runner` | `mates-run`: the wrapper that executes one Claude Code invocation in a pod. |
| `packages/ui` | `mates-ui`: React SPA, built into `packages/api/public`. |
| `charts/mates` | Helm chart. |
| `fixtures/claude` | Recorded `stream-json` transcripts for the fake-Claude mode. |

## Quickstart (ten minutes)

```bash
helm install mates oci://ghcr.io/thewillyhuman/charts/mates --namespace mates --create-namespace
kubectl -n mates get secret mates-bootstrap -o jsonpath='{.data.token}' | base64 -d; echo
kubectl -n mates port-forward svc/mates 8080:8080
```

Open <http://localhost:8080/setup>, paste the token, create the admin, then
complete Settings → Anthropic, Jira, Source control and Team context; the
checklist page shows what is still missing and every step has a Test
button. Assign a ticket to Mates in Jira and watch the board. The full
operator guide is [docs/operations.md](docs/operations.md).

Single sign-on (OIDC), GitHub App tokens, network policies, backups and
upgrades are covered in [docs/operations.md](docs/operations.md).

## Development

Requirements: Node 22, pnpm 10, Docker (for Postgres in tests).

```bash
pnpm install
docker compose up -d            # local Postgres
cp .env.example .env && set -a && source .env && set +a
pnpm --filter mates-api dev     # API on :8080
pnpm --filter mates-ui dev      # UI on :5173, proxies /api
pnpm lint && pnpm typecheck && pnpm test
```

Integration tests start Postgres through testcontainers; set
`MATES_TEST_DATABASE_URL` to reuse a running server instead.

Chart checks: `helm lint charts/mates && helm template mates charts/mates | kubeconform -strict`.

End-to-end on kind, without spending tokens (fake-Claude mode, §15.1):

```bash
kind create cluster --name mates-dev
docker build -f packages/api/Dockerfile -t mates-api:dev .
docker build -f packages/runner/Dockerfile -t mates-runner:dev .
kind load docker-image --name mates-dev mates-api:dev mates-runner:dev
scripts/kind-smoke.sh dev dev   # install, readiness, first admin
scripts/e2e-kind.sh dev dev     # Gitea + a run through a real runner pod
```

`runner.fakeClaude=true` makes runner pods replay `fixtures/claude/*.jsonl`
instead of calling Claude; `MATES_JOBS=fake` runs the API with in-memory
Jobs for local development without a cluster.

## License

Apache-2.0.
