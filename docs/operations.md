# Operating Mates

For the people who run it. The specification is `MATES-SPEC.md`; design
choices are in `docs/decisions/`.

## Install in ten minutes

```bash
helm install mates oci://ghcr.io/thewillyhuman/charts/mates -n mates --create-namespace \
  --set ingress.enabled=true --set ingress.host=mates.example.com
kubectl -n mates get secret mates-bootstrap -o jsonpath='{.data.token}' | base64 -d; echo
```

Open `https://mates.example.com/setup`, paste the token, create the first
admin, then walk the Settings tabs in order. The checklist page tells you
what is still red. Each step has a **Test** button that reports pass or
fail with a reason: the Anthropic test runs a one-turn `claude -p` in a
short-lived pod; the Jira test validates the credentials and lists the
tickets the trigger rule matches; a source-control test lists the
repositories the token can see.

A ticket is picked up when it matches the trigger rule (assignee, label,
status or JQL) through the Jira webhook or the poll (every
`jira.poll_interval_seconds`). You can also start a run by hand with
`POST /api/runs { "ticket_key": "API-198" }` using a personal API token.

## What runs where

| Component | Kind | Notes |
| --- | --- | --- |
| `mates-api` | Deployment, 1 replica | Orchestrator, adapters, Job spawner, SSE, UI. Single replica by design (decision 0007). |
| runner pods | `batch/v1` Jobs | One per invocation, labelled `mates/run=<id>`; `kubectl -n mates logs -l mates/run=<id>`. |
| Postgres | bundled StatefulSet or external | Everything is in the database: events, blobs, usage, settings. |

Secrets never leave Kubernetes: credentials live in `<release>-credentials`,
the signing key in `<release>-internal`, each runner's JWT in a Secret
owned by its Job.

## Backups

Back up the database; that is all the state. With the bundled Postgres:

```bash
kubectl -n mates exec statefulset/mates-postgresql -- pg_dump -U mates mates | gzip > mates-$(date +%F).sql.gz
```

Restore into an empty database and `helm upgrade`; the API applies any
pending migrations at start-up. Keep the `<release>-internal` Secret with
the backup if you want sessions and in-flight runner tokens to survive a
rebuild; otherwise a new key is generated and users sign in again.

Size: a run stores its events (small), its diffs and test logs, and a
gzipped transcript per invocation (tens of KB to a few MB). Transcripts
are deleted after `retention.transcripts_days` (default 14); runs
finished more than `retention.events_days` (default 365) ago are deleted
with everything they own.

## Upgrades

```bash
helm upgrade mates oci://ghcr.io/thewillyhuman/charts/mates -n mates
```

The `pre-upgrade` migration Job applies schema changes before the new API
rolls out; migrations are forward-only (decision 0002). The internal,
credentials and bundled-Postgres Secrets are `pre-install` hooks with
`resource-policy: keep`, so an upgrade never regenerates keys or wipes
what the UI stored. Runner pods in flight keep running; the orchestrator
picks their events up again after the restart because the log, not the
process, is the state.

Values set under `config:` are "managed by Helm": they override the UI
and show as read-only there. Leave the block empty to manage everything
from Settings.

## Scaling

- The API is single-replica; one instance comfortably drives dozens of
  concurrent runs because the work happens in runner pods.
- Runner pods are bounded by `runner.resources`, the invocation timeout,
  `--max-turns`, `--max-budget-usd` and the workspace size limit. Set
  budgets under Settings → Models & budgets; the daily budget pauses new
  invocations and shows a banner on the board.
- Heavier toolchains: build `FROM ghcr.io/thewillyhuman/mates-runner` and
  set `runner_image` per repository in `mates.yaml`.

## External secrets

Set `credentials.existingSecret` to a Secret you manage (for example with
the External Secrets Operator) holding `anthropic_api_key`, `jira_token`,
`jira_webhook_secret`, `scm_<provider>_token`, `oidc_client_secret`. The UI
then shows credentials as read-only.

## Authentication

Local accounts always work. To add single sign-on, set the OIDC values and
store the client secret:

```yaml
auth:
  oidc:
    enabled: true
    issuer: https://login.example.com/realms/platform
    clientId: mates
    scopes: openid profile email groups
    groupsClaim: groups
    groups:
      admin: [mates-admins]
      operator: [platform-team]
```

Register `https://<public URL>/api/auth/oidc/callback` as the redirect
URI, then store `oidc_client_secret` through Settings → Credentials (or
the existing Secret). Users not in any mapped group sign in as viewers;
on an empty instance the first OIDC user becomes admin, so run the
first login yourself. Local admins keep working as a break-glass path.

For GitHub, prefer a GitHub App over a personal token: set the provider's
authentication to "GitHub App", fill the App and installation ids, and
store the PEM private key as `scm_<provider>_app_private_key`. Mates mints
one-hour installation tokens, renews them five minutes before expiry and
passes each runner a fresh one in its per-invocation Secret, so no
long-lived token exists anywhere in the cluster. The App needs contents
and pull requests read & write, and metadata read.

## Networking

`networkPolicy.enabled` (default on) lets runner pods reach DNS, the API
and the internet minus private ranges (or `egressCidrs`); nothing reaches
runner pods, and only the API reaches the bundled database. Set
`networkPolicy.ingressNamespaces` to your ingress controller's namespace to
restrict who can call the API. The chart runs under the `restricted` Pod
Security Standard; the CI smoke test enforces that label.

## Troubleshooting a stuck run

1. Open the run in the UI. The **Live tail** shows the last lines of the
   current pod; **Run facts** show elapsed time against the timeout.
2. `kubectl -n mates get jobs -l mates/run=<run id>` — a Job in `Pending`
   usually means an image pull or scheduling problem; the monitor turns
   `ImagePullBackOff`, evictions and deadline hits into
   `invocation.failed` events within ten seconds, and the orchestrator
   retries infrastructure failures once (`-r1` Job).
3. `kubectl -n mates logs -l mates/run=<run id> --tail=100` — the runner
   logs every step (`workspace ready`, `claude stderr`, `invocation
   failed` with a reason). Tokens are redacted.
4. No pod at all and the run says `intake` or `implementing`: check the
   API logs for `spawn failed` (RBAC, quota, bad image name) and
   `/readyz`, which reports the database, migrations and Kubernetes API.
5. A run `blocked` on clarification waits for a human comment on the Jira
   ticket (or a nudge with "and retry"); one blocked at the cap waits for a
   retry; one blocked on budget waits for a retry with a raised budget.
6. Nothing helps: **Cancel run** deletes the Job and ends the run; the
   branch and any open merge request stay. Start a new run from the ticket.

## Metrics and logs

`/metrics` (Prometheus) exposes `mates_runs_total{stage}`,
`mates_invocations_total{mate,status}`,
`mates_invocation_duration_seconds{mate}`, `mates_cost_usd_total{mate,model}`,
`mates_tokens_total{mate,model,kind}`, `mates_iterations_to_approval`,
`mates_queue_depth`, `mates_tracker_poll_errors_total` and
`mates_scm_api_errors_total`. Enable `metrics.serviceMonitor.enabled` for
the Prometheus Operator. Logs are JSON with `run_id`, `invocation_id` and
`ticket_key` on every line that concerns a run.
