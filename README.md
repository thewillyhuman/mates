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
complete Settings → Anthropic, Jira, Source control and Team context.

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
End-to-end on kind: build the images, `kind load docker-image`, then
`scripts/kind-smoke.sh`.

## License

Apache-2.0.
