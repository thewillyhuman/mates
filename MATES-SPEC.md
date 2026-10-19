# Mates — Specification

**Autonomous ticket-to-merge-request agents for Jira + GitLab/GitHub, built on Claude Code, deployed on Kubernetes.**

Version 0.1 · 2026-10-19 · Status: ready for implementation

---

## How to use this document with Claude Code

1. Create an empty git repository and copy this file to its root as `SPEC.md`.
2. Start Claude Code in that directory and give it this kickoff prompt:

> Read SPEC.md in full. It is the specification for a system called Mates. Implement it in the milestone order given in §16. Before writing code for a milestone, write a short plan into `docs/plans/<milestone>.md`, then implement, then make sure the acceptance criteria for that milestone (§15) pass with real tests. Keep `docs/decisions/` up to date with any choice the spec leaves open (§17) or that you had to deviate from, with the reason. Do not skip the security requirements in §10. Stop and ask me only when the spec is contradictory or when a decision is irreversible and could reasonably go either way.

3. Review the plan for milestone 0 before letting it continue.

Everything below is written for the implementer. "Must" means required for v1; "should" means strongly preferred; "may" means optional / v2.

---

## 1. Purpose

Mates turns a Jira ticket into a reviewed merge request with no human in the loop until the MR is open.

A human assigns a ticket to Mates (via a Jira assignee, label, or status — configurable). Mates then:

1. Runs **intake**: decides whether the ticket is implementable as written. If not, it comments on the ticket asking for clarification and stops.
2. Spawns an **implementer** agent in its own Kubernetes pod. It clones the right repository, implements the change on a branch, runs the tests, pushes, and opens a **draft** MR/PR.
3. Spawns a **reviewer** agent in its own pod with a clean context (ticket + team context + diff + test output, never the implementer's reasoning). The reviewer returns a structured verdict: `approve` or `changes_requested` with blocking and non-blocking items.
4. Loops implementer → reviewer until the reviewer approves or the iteration cap is reached (default 4, configurable 1–10).
5. Marks the MR ready for human review (or leaves it as a draft with the unresolved review points if the cap was hit), updates Jira, and stops.

A web UI shows every run, its stage, the full event timeline, the live agent output, token usage and cost, and lets humans pause, cancel, retry, and "nudge" (inject a note into the next iteration).

The whole thing installs with one `helm install` and is configured from the web UI: credentials, the team-context package (repos, docs, conventions), and model choices.

### 1.1 Non-goals (v1)

- Merging MRs. A human always merges.
- Multi-repo changes in one ticket. Intake rejects these with a clarification comment. (May be v2.)
- Replacing CI. Agents run tests locally in their pod; the project's CI still runs on the MR as usual.
- Supporting trackers other than Jira or SCMs other than GitLab/GitHub. The adapters are interfaces so others can be added later, but only these are implemented.
- Organisation-specific integrations (SSO vendors, internal registries, etc.). Everything is generic Kubernetes + OIDC.

---

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Ticket** | A Jira issue assigned to Mates. |
| **Run** | One end-to-end attempt to turn a ticket into an MR. A ticket can have several runs (e.g. after a retry). |
| **Stage** | Where a run is: `queued`, `intake`, `implementing`, `reviewing`, `mr_ready`, `blocked`, `cancelled`, `failed`, `done`. |
| **Iteration** | One implementer pass followed by one reviewer pass. Iteration numbers start at 1. |
| **Invocation** | A single execution of a Claude Code agent in one pod (one implementer pass *or* one reviewer pass *or* one intake pass). |
| **Mate** | A role an agent plays: `intake`, `implementer`, `reviewer`. Each has its own system prompt, tool permissions, model and budget. |
| **Team context** | A versioned package (git repo or uploaded bundle) describing the team's repositories, docs, conventions and how to run things. Loaded by every mate. |
| **Verdict** | The reviewer's structured output. |
| **Nudge** | A human note injected into the implementer's next iteration. |
| **MR** | Merge request (GitLab) or pull request (GitHub). The code uses `MergeRequest` for both. |

---

## 3. Architecture

```
                 Jira                     GitLab / GitHub
                  │ webhook / poll              ▲ clone, push, MR API
                  ▼                             │
┌────────────────────────────────────────────────────────────────┐
│  Kubernetes namespace: mates                                   │
│                                                                │
│  ┌──────────────┐   REST+SSE   ┌──────────────┐                │
│  │   mates-ui   │◄────────────►│  mates-api   │  (control plane)│
│  │ (static SPA) │              │              │                │
│  └──────────────┘              │ • orchestrator (state machine) │
│                                │ • Jira / SCM adapters          │
│                                │ • Job spawner (k8s client)     │
│                                │ • event ingest + SSE fan-out   │
│                                │ • usage/cost ledger            │
│                                └──────┬───────┬─────────────┘  │
│                                       │       │                │
│                              Postgres │       │ creates batch/v1 Jobs
│                                       ▼       ▼                │
│                                ┌──────────┐  ┌──────────────────┐
│                                │ postgres │  │ runner pod (Job) │  one per invocation
│                                └──────────┘  │ ┌──────────────┐ │
│                                              │ │ mates-runner │ │  wrapper
│                                              │ │  └ claude -p │ │  Claude Code CLI
│                                              │ └──────────────┘ │
│                                              │  emptyDir workspace
│                                              └──────────────────┘
└────────────────────────────────────────────────────────────────┘
```

### 3.1 Components

| Component | What it is | Runs as |
| --- | --- | --- |
| `mates-api` | Control plane: HTTP API, orchestrator, adapters, Kubernetes Job spawner, event ingest, SSE stream, cost ledger, migrations. | Deployment, 1 replica by default (leader election not required in v1; see §17). |
| `mates-ui` | Single-page web app. | Static files served by `mates-api` (same origin, no CORS). Separate container optional. |
| `mates-runner` | Container image with Claude Code CLI, git, and a thin wrapper that runs one invocation and streams events to `mates-api`. | `batch/v1 Job`, one per invocation, in the same namespace. |
| `postgres` | Persistence for everything. | Bundled subchart by default; external DB via values. |

### 3.2 Design principles the implementer must follow

- **Event log is the source of truth.** Every state change is an appended event. Stage, iteration count, cost and the UI are all derived from events. Never store a derived field without the events that produced it.
- **One invocation = one pod.** Implementer, reviewer and intake each run in a fresh pod. State between them travels through git (the branch) and the event log, not through shared disk. This is what makes runs resumable and pods disposable.
- **Clean reviewer context.** The reviewer never sees the implementer's transcript or reasoning. Only: ticket, team context, the diff against the base branch, test output, prior verdicts and how the implementer said it addressed them.
- **Idempotent orchestration.** The same Jira event delivered twice, or the orchestrator restarting mid-run, must not spawn duplicate invocations. Every Job is named deterministically from `(run_id, invocation_seq)`.
- **Nothing is hard-coded to an organisation.** No vendor-specific SSO, registries, URLs or conventions. Everything comes from Helm values or the settings UI.
- **Secrets never leave Kubernetes Secrets.** The API writes them, the runner reads them from env; they are never logged, never in events, never in the DB.

### 3.3 Recommended stack

A single language keeps the project tractable for one implementer. Default:

- **TypeScript (Node 22 LTS)** for `mates-api` and `mates-runner`. Rationale: the Claude Agent SDK ships for TypeScript, `@kubernetes/client-node` is mature, and the UI is TypeScript too.
- **React + Vite** for `mates-ui`, with a small component layer (no heavy UI framework). Styling: CSS modules or Tailwind — implementer's choice, but match the mockup's look (§13).
- **Postgres 16** via `node-postgres` + a migration tool (`node-pg-migrate` or `drizzle-kit`).
- **Helm 3** chart, Kubernetes ≥ 1.28.
- **Containers**: distroless or Debian-slim; multi-arch (amd64, arm64).

The implementer may choose Go for `mates-api` if they prefer, but must then record the decision in `docs/decisions/` and still keep the runner wrapper simple. Do not split into more services than listed in §3.1.

---

## 4. Domain model

### 4.1 Tables (minimum)

```
tickets          id, tracker ('jira'), external_key ('API-198'), external_id, title, url,
                 project_key, repo_id (nullable until intake), created_at

runs             id, ticket_id, status (stage enum), iteration (int), max_iterations,
                 branch, base_branch, mr_id (nullable), mr_url, mr_state (draft|ready|merged|closed),
                 workspace_ref (nullable), created_by, created_at, finished_at,
                 budget_usd (nullable), budget_tokens (nullable)

invocations      id, run_id, seq (int, unique per run), mate ('intake'|'implementer'|'reviewer'),
                 iteration, status (pending|running|succeeded|failed|cancelled|timed_out),
                 k8s_job_name, pod_name, model, started_at, finished_at, exit_code,
                 claude_session_id, result_json (jsonb)

events           id (bigserial), run_id, invocation_id (nullable), ts, type, payload (jsonb)
                 -- append only; indexed on (run_id, id)

verdicts         id, invocation_id, run_id, iteration, decision ('approve'|'changes_requested'),
                 blocking (jsonb array), non_blocking (jsonb array), summary, raw (jsonb)

nudges           id, run_id, author, text, post_to_tracker (bool), created_at, consumed_by_invocation_id (nullable)

usage            id, invocation_id, run_id, model, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_usd_reported (numeric),
                 cost_usd_computed (numeric), source ('claude_code_result'), ts

settings         key (pk), value (jsonb), updated_at, updated_by     -- non-secret config
team_context     id, version (int), source ('git'|'upload'), ref, manifest (jsonb), fetched_at, active (bool)
users            id, email, display_name, role ('admin'|'operator'|'viewer'), auth ('local'|'oidc'), password_hash (nullable)
api_tokens       id, user_id, name, hash, created_at, last_used_at
```

Secrets (Jira token, SCM tokens, Anthropic API key, webhook secrets) are **not** in the DB. They live in one Kubernetes Secret (`<release>-credentials`) managed by `mates-api`. The DB only stores whether a credential is set and when it was last validated.

### 4.2 Run state machine

```
queued ──► intake ──┬──► implementing ──► reviewing ──┬──► mr_ready ──► done
                    │        ▲                        │
                    │        └──── changes_requested ──┘   (iteration < max)
                    │                                  └──► blocked (cap reached; draft MR stays open)
                    └──► blocked (needs clarification)

any non-terminal ──► cancelled   (human)
any non-terminal ──► failed      (infra error, budget exceeded, repeated pod failure)
blocked ──► queued               (human: "retry" or Jira comment answered)
```

Terminal: `done`, `cancelled`, `failed`. `blocked` is not terminal; a human action (or a Jira reply, see §8.2) moves it back to `queued`.

### 4.3 Event types

All events: `{ id, run_id, invocation_id?, ts, type, payload }`. Payloads are small JSON; large blobs (logs, diffs) are stored separately and referenced by id.

```
run.created                 { ticket_key, trigger: 'webhook'|'poll'|'manual', by }
run.stage_changed           { from, to, reason }
run.cancelled               { by, reason }
run.failed                  { reason, detail }
run.budget_exceeded         { kind: 'usd'|'tokens', limit, used }

intake.started / intake.finished
intake.needs_clarification  { questions: [string], tracker_comment_id }
intake.passed               { repo, base_branch, plan: [string], scope_notes }

invocation.scheduled        { mate, iteration, job_name, model }
invocation.started          { pod_name }
invocation.heartbeat        { }                          -- every 30s from the runner
invocation.tool_use         { tool, summary }            -- condensed from stream-json
invocation.text             { text }                     -- assistant text, truncated to 2k chars
invocation.finished         { exit_code, duration_ms, session_id }
invocation.failed           { reason }

implementation.pushed       { commit, files_changed, additions, deletions }
implementation.tests        { passed, failed, skipped, runner, duration_ms, log_ref }
implementation.addressed    { blocking_ids: [..], skipped: [{id, reason}] }

review.verdict              { decision, blocking: [...], non_blocking: [...], summary }

mr.opened                   { mr_id, url, draft: true }
mr.updated                  { description_updated: bool }
mr.marked_ready             { mr_id }
tracker.transitioned        { from, to }
tracker.commented           { comment_id, kind: 'clarification'|'status'|'nudge_echo' }

nudge.added                 { nudge_id, by }
nudge.consumed              { nudge_id, invocation_id }

usage.recorded              { model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd }
```

Stage, iteration, and totals are projections over this list. Implement a single `projectRun(events)` function and use it everywhere (API responses, UI, tests).

---

## 5. Control plane (`mates-api`)

### 5.1 Responsibilities

1. **Trigger intake** — receive Jira webhooks and/or poll JQL (§8.1). Create `tickets` + `runs` idempotently (unique on `(tracker, external_id, active run)`).
2. **Orchestrate** — a reconcile loop: for each non-terminal run, look at the projected state and decide the next action (spawn invocation, open MR, mark ready, block, etc.). The loop runs every 5 s and on every incoming event. It must be safe to run concurrently with itself (use `SELECT … FOR UPDATE SKIP LOCKED` per run).
3. **Spawn invocations** — create `batch/v1 Job`s (§7). Watch pods via the Kubernetes watch API and translate pod phase changes into `invocation.*` events. Reap finished Jobs after a configurable TTL (`ttlSecondsAfterFinished`, default 3600).
4. **Ingest runner events** — `POST /internal/runs/{run_id}/invocations/{id}/events` authenticated with a per-invocation JWT minted at spawn time (expiry = invocation timeout + 10 min).
5. **Fan out** — SSE stream per run and a global stream for the board.
6. **Adapters** — Jira, GitLab, GitHub (§8).
7. **Cost ledger** — §9.
8. **Settings & setup** — §6.
9. **Auth** — §10.4.

### 5.2 Configuration precedence

Helm values → environment variables → settings in DB (set from the UI). The UI can only change what the chart marks as UI-configurable (default: everything except DB connection, listen address and Kubernetes namespace). `helm upgrade` with a value set overrides the UI value and the UI shows it as "managed by Helm".

---

## 6. First-run setup and configuration (UI)

Goal: `helm install mates mates/mates` then open the URL and be running tickets in ten minutes.

### 6.1 Bootstrap

- On first start with no users, `mates-api` generates a one-time **setup token**, logs it (once) and exposes it via `kubectl get secret <release>-bootstrap -o jsonpath=...`. The chart's `NOTES.txt` prints the exact command.
- The UI's `/setup` page asks for the setup token, then creates the first admin (email + password) or, if OIDC is configured in values, offers "Sign in with OIDC" and makes the first OIDC user admin.
- `/setup` is disabled once an admin exists.

### 6.2 Setup wizard steps (each independently revisitable under Settings)

1. **Anthropic** — API key (or choose Bedrock / Vertex / Foundry, in which case the UI shows which env vars the chart expects instead of a key field). "Test" button runs a minimal `claude -p` in a short-lived Job and reports model, latency and cost.
2. **Jira** — base URL, auth (API token + email for Cloud; PAT for Data Center), trigger rule (one of: assignee = *user*, label = *x*, status = *y*, or custom JQL), status mapping (which Jira status to set at each stage; each optional), comment behaviour (post clarification comments: yes/no; post stage updates: yes/no). "Test" validates auth and the JQL, and shows the matched tickets.
3. **Source control** — one or more providers. For each: type (GitLab / GitHub), base URL (for self-hosted), token (GitLab PAT / project token with `api` + `write_repository`; GitHub PAT or GitHub App — App support **should** be implemented, PAT **must**), and whether MRs are opened as drafts (default yes), the MR label(s) to apply, the reviewer(s) to request (optional). "Test" lists accessible repositories.
4. **Team context** — either a git URL + ref (recommended; polled every 5 min and on webhook) or an uploaded `.tar.gz`. The UI validates `mates.yaml` (§6.3) and shows a diff on each new version. Every run records the team-context version it used.
5. **Models & budgets** — per mate (`intake`, `implementer`, `reviewer`): model id (free text with a dropdown of known ids, defaults below), effort (`low|medium|high` if supported by the CLI, else omitted), max budget USD per invocation, max turns, timeout. Global: max iterations (default 4), per-run USD budget (default 25), per-day USD budget (default 200; when hit, new runs queue and the UI shows a banner), pricing table (§9.3).
   Defaults: intake → `claude-sonnet-5-5`, implementer → `claude-opus-5-5`, reviewer → `claude-opus-5-5`. These are defaults, not assertions about what exists; the UI must accept any model id string.
6. **Runner** — default runner image + tag, CPU/memory requests and limits, invocation timeout (default 45 min), workspace size (default 10 Gi emptyDir), optional extra CA bundle (ConfigMap name), optional HTTP proxy, optional image pull secret.
7. **Notifications (should)** — one generic webhook URL (Slack-compatible JSON) fired on `intake.needs_clarification`, `run.blocked`, `mr.marked_ready`, `run.failed`, `run.budget_exceeded`.

Every step has a "Test" that produces a pass/fail with a reason, and the wizard's last page is a summary with the three things that are still red.

### 6.3 Team context package — `mates.yaml`

The team context is a directory. The manifest is `mates.yaml` at its root. Everything else is free-form markdown the mates can read.

```yaml
version: 1
team:
  name: Payments platform          # shown in UI
  conventions: docs/conventions.md # path(s) to markdown the mates always load
  extra_docs:                      # loaded by path when the mate decides it needs them (listed with a one-line description)
    - path: docs/architecture.md
      about: Service boundaries and data ownership
    - path: docs/testing.md
      about: How to run and write tests in each repo
repos:
  - id: webhook-service
    scm: gitlab                    # must match a provider configured in Settings
    project: platform/webhook-service   # GitLab path or GitHub owner/repo
    default_branch: main
    about: Delivers outbound webhooks with retries. Owns webhook_* tables.
    jira_projects: [API]           # intake uses this to shortlist repos for a ticket
    paths_hint: ["src/", "test/"]
    setup: |                       # run before the mate starts (idempotent, non-interactive)
      pnpm install --frozen-lockfile
    test: pnpm test                # the canonical test command; output is parsed when possible
    lint: pnpm lint
    runner_image: ghcr.io/example/mates-runner-node:22   # optional override of the default image
    env:                           # non-secret env for setup/test
      CI: "true"
  - id: billing-service
    scm: github
    project: example-org/billing-service
    default_branch: main
    about: Invoicing and VAT. Python/Django.
    jira_projects: [BILL]
    setup: pip install -r requirements-dev.txt
    test: pytest -q
branching:
  pattern: "mates/{ticket}-{slug}"  # slug = kebab-cased title, max 40 chars
  commit_trailer: "Jira: {ticket}"
review:
  rubric: docs/review-rubric.md    # optional: additional reviewer criteria
  max_iterations: 4                # overrides the global default for this team
```

Validation rules: unique repo ids; every `scm` has a configured provider; every referenced path exists; `pattern` contains `{ticket}`. Validation errors block activation of that version and are shown in the UI; the previous version stays active.

---

## 7. Runner (`mates-runner`)

### 7.1 Image

- Base: Debian slim. Installed: `git`, `curl`, `jq`, `ca-certificates`, Node 22, Python 3.12, `pnpm`, `pip`, and the Claude Code CLI (`@anthropic-ai/claude-code`, pinned version in the Dockerfile; **minimum v2.1.259**, which is required for `--permission-prompts none`).
- The wrapper: `/usr/local/bin/mates-run` (TypeScript compiled to a single file, or a Bash script if the implementer keeps it under ~300 lines; TypeScript preferred so stream-json parsing is robust).
- Teams with other toolchains build their own image `FROM` this one and set `runner_image` in `mates.yaml`.
- Runs as non-root uid 1000. Read-only root filesystem except `/workspace`, `/home/mate`, `/tmp`.

### 7.2 Job spec (created by `mates-api`)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: mates-r{run_short}-i{seq}-{mate}         # deterministic, ≤ 63 chars
  labels: { app.kubernetes.io/name: mates-runner, mates/run: <run_id>, mates/mate: implementer, mates/iteration: "2" }
spec:
  backoffLimit: 0                                # the orchestrator decides on retries, not k8s
  ttlSecondsAfterFinished: 3600
  activeDeadlineSeconds: <invocation timeout + 120>
  template:
    spec:
      serviceAccountName: mates-runner           # no RBAC permissions at all
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: runner
          image: <runner image>
          command: ["mates-run"]
          env:
            - MATES_API_URL            # internal service URL
            - MATES_INVOCATION_TOKEN   # per-invocation JWT (from a Secret created with the Job, deleted with it)
            - MATES_INVOCATION_ID, MATES_RUN_ID, MATES_MATE, MATES_ITERATION
            - ANTHROPIC_API_KEY        # from <release>-credentials (or provider-specific vars)
            - GIT_TOKEN                # scoped to this repo's provider, from <release>-credentials
            - HTTPS_PROXY / NO_PROXY   # if configured
          resources: { requests: {cpu: "1", memory: "2Gi"}, limits: {cpu: "4", memory: "8Gi"} }   # from settings
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
            - { name: home, mountPath: /home/mate }
            - { name: tmp, mountPath: /tmp }
            - { name: context, mountPath: /context, readOnly: true }     # the invocation context bundle
      volumes:
        - { name: workspace, emptyDir: { sizeLimit: 10Gi } }
        - { name: home, emptyDir: {} }
        - { name: tmp, emptyDir: {} }
        - { name: context, configMap: { name: mates-ctx-<invocation_id> } }   # or secret if > 1 MiB → use an object fetched from the API instead
```

The invocation **context bundle** (`/context/`) contains: `ticket.json`, `team/` (the active team-context package), `brief.md` (the mate's task, rendered from a template — §7.4), `prior_verdicts.json`, `nudges.json`, and for the reviewer `diff.patch` and `tests.log`. If the bundle exceeds ConfigMap limits, the runner instead downloads it from `GET /internal/invocations/{id}/context` with its token. Implement the download path from the start; make the ConfigMap an optimisation.

### 7.3 What `mates-run` does

1. Register: `POST …/events` `invocation.started`. Start a heartbeat every 30 s.
2. Clone: `git clone --depth 50 --branch <base or run branch>` using `GIT_TOKEN` via a credential helper (never in the URL that ends up in logs). For `implementer` on iteration > 1 and for `reviewer`, check out the run branch.
3. Run `setup` from `mates.yaml` for this repo with a timeout (default 10 min). Failure → `invocation.failed { reason: 'setup_failed' }`; the orchestrator fails the run after one retry.
4. Execute Claude Code non-interactively:

   ```bash
   claude --bare -p "$(cat /context/brief.md)" \
     --model "$MODEL" \
     --output-format stream-json --verbose \
     --append-system-prompt-file /context/system.md \
     --allowedTools "$ALLOWED_TOOLS" \
     --permission-mode "$PERMISSION_MODE" \
     --permission-prompts none \
     --max-budget-usd "$MAX_BUDGET_USD" \
     --max-turns "$MAX_TURNS" \
     [--json-schema "$(cat /context/verdict.schema.json)"]      # reviewer and intake only
   ```

   Notes verified against the Claude Code docs at the time of writing:
   - `--bare` skips host hooks/plugins/CLAUDE.md discovery and is the recommended mode for scripted runs; it requires `ANTHROPIC_API_KEY` (or provider credentials) in the environment.
   - `--output-format stream-json` emits newline-delimited JSON events; the final line is a `result` message carrying the response, `session_id`, usage and cost (`total_cost_usd` plus a per-model breakdown).
   - `--json-schema` with `--output-format json`/`stream-json` returns the structured output in `structured_output`.
   - `--permission-prompts none` denies anything that would prompt and removes `AskUserQuestion`; `--permission-mode` sets the baseline (`acceptEdits` for implementer; `dontAsk` for reviewer/intake); `--allowedTools` uses permission-rule syntax, e.g. `Bash(pnpm test *)`.
   - Reference: https://code.claude.com/docs/en/headless.md and https://code.claude.com/docs/en/cli-reference .
   The wrapper must not assume any field beyond `type`, `subtype`, `session_id`, `result`, `structured_output`, `total_cost_usd`, `usage`, `modelUsage`/per-model breakdown, `is_error`, `permission_denials`; log and ignore unknown fields.

   Tool permissions per mate (configurable, these are defaults):
   - `intake`: `Read`, `Glob`, `Grep`, `Bash(git log *)`, `Bash(git ls-files *)`. Mode `dontAsk`.
   - `implementer`: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash(git *)` (minus `git push` — the wrapper pushes), `Bash(<setup/test/lint commands from mates.yaml> *)`, `Bash(pnpm *)`, `Bash(npm *)`, `Bash(pip *)`, `Bash(pytest *)`, `Bash(make *)`. Mode `acceptEdits`. The repo entry may add `allowed_commands`.
   - `reviewer`: `Read`, `Glob`, `Grep`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(<test command> *)`. Mode `dontAsk`. The reviewer may run the tests but may not edit.
5. Stream: parse each stream-json line and forward condensed events (`invocation.tool_use`, `invocation.text`, `api_retry` as `invocation.heartbeat` with a note). Do **not** forward raw tool results or file contents; the UI's live tail shows one line per tool call (`read src/x.ts`, `run pnpm test`, `edit src/y.ts (+12 −3)`) plus assistant text. Buffer and batch events (max 1 s / 50 events per POST).
6. After Claude exits (implementer only): `git add -A`, commit with message from the brief's template (`<ticket>: <summary>` + trailer), push the run branch with `--force-with-lease`. Compute `files_changed/additions/deletions` from `git diff --shortstat <base>..HEAD` and emit `implementation.pushed`. Run the canonical `test` command once more if Claude did not run it in the last 5 minutes of the session (the wrapper tracks test runs via tool_use events); emit `implementation.tests` with a parsed summary when the output matches common formats (pytest, jest/vitest, go test, cargo test, junit XML if the command writes one) — otherwise just `passed: null` and the log ref.
7. Upload large artefacts (test log, `git diff` of the iteration, the full stream-json transcript gzipped) to `POST /internal/invocations/{id}/blobs/{kind}`. Transcripts are kept for `retention.transcripts_days` (default 14).
8. Emit `invocation.finished` with the `result` message (minus anything that looks like a secret — run the payload through the redaction filter in §10.3) and exit 0. Any exception → `invocation.failed` and exit 1.
9. Honour cancellation: on SIGTERM, send SIGINT to `claude` and wait up to 20 s, then exit 143. (The docs: SIGTERM leaves the turn unfinished; SIGINT ends it.)

### 7.4 Briefs and system prompts

All prompts are files in `mates-api/prompts/` rendered with a small template engine (Mustache/Handlebars). They are also editable from the UI under Settings → Prompts (stored in `settings`, with "reset to default"). Keep them short and explicit. Required content:

**Common system prompt (`system.md`)**: who the mate is, the team name, where the team context lives (`/context/team`), that it must read `conventions.md` first, that it may not touch files outside the repo, must not push (implementer) or edit (reviewer), must not use network beyond package registries, and must never put credentials in code or commits.

**Intake brief**: ticket (key, summary, description, acceptance criteria, comments, links), the repo list with `about`/`jira_projects`. Output schema:

```json
{ "decision": "implementable" | "needs_clarification" | "out_of_scope",
  "repo_id": "string|null", "base_branch": "string|null",
  "plan": ["step", "..."], "questions": ["...", "..."], "reasoning_summary": "≤ 600 chars" }
```

Rules for `needs_clarification`: more than one plausible repo; acceptance criteria missing or contradictory; the ticket requires product decisions; the ticket touches > 1 repo. Questions must be concrete and answerable in one Jira comment.

**Implementer brief**: ticket, intake plan, repo info, conventions, test command, branch name, iteration number. On iteration > 1: the previous verdict's blocking items (and non-blocking ones, labelled optional), any nudges, and the instruction to end its final message with a JSON block `{"addressed": ["B1","B2"], "skipped": [{"id":"N3","reason":"…"}], "summary": "…"}` — the wrapper extracts it and emits `implementation.addressed`.

**Reviewer brief**: ticket + acceptance criteria, conventions + `review.rubric` if any, `diff.patch`, `tests.log`, prior verdicts and the implementer's `addressed` list. Output schema (`verdict.schema.json`):

```json
{ "decision": "approve" | "changes_requested",
  "blocking":     [{ "id": "B1", "title": "string", "detail": "string", "file": "string|null", "line": "int|null" }],
  "non_blocking": [{ "id": "N1", "title": "string", "detail": "string", "file": "string|null", "line": "int|null" }],
  "verified": { "tests_run": true, "acceptance_criteria": [{ "text": "…", "met": true }] },
  "summary": "≤ 800 chars for the MR description" }
```

Rules: `approve` is only valid with zero blocking items; a reviewer that cannot run tests must say so in `summary` and may still approve only if the implementer's `tests.log` shows a green run; style-only comments are never blocking unless `conventions.md` says so; the same blocking item must not be re-raised with a new id if the implementer addressed it — it must either be dropped or escalated with "still present because …".

### 7.5 Implementer ↔ reviewer loop (orchestrator rules)

1. Iteration `n` implementer finishes and pushed → spawn reviewer `n`.
2. Reviewer `n` `approve` → `mr.marked_ready`, update MR description (§8.3), Jira transition, stage `mr_ready` → `done` once the MR exists and is not a draft. (Watching the MR for merge is **may**; v1 marks `done` when the MR is ready.)
3. Reviewer `n` `changes_requested` and `n < max_iterations` → spawn implementer `n+1` with the verdict.
4. `changes_requested` and `n == max_iterations` → stage `blocked { reason: 'iteration_cap' }`; MR stays a draft; MR description gets an "Unresolved review points" section; Jira comment; notification.
5. Implementer produced no diff → treat as `changes_requested` with a synthetic blocking item "No changes produced" once; a second empty iteration → `failed`.
6. Any invocation `failed` for infra reasons (pod evicted, image pull, setup failed) → retry the same invocation once with a new Job name suffix `-r1`; a second failure → run `failed`.
7. Budget: before each spawn, check run spend + per-day spend against limits; if over → `run.budget_exceeded` and `blocked` (not `failed`, so a human can raise the budget and retry).
8. Pause: a paused run finishes the current invocation and does not spawn the next one until resumed.
9. Nudge: when spawning an implementer, include all unconsumed nudges and mark them consumed. A nudge on a `blocked` run also moves it back to `queued` if the human ticks "and retry".

---

## 8. Integrations

All adapters implement small interfaces with fakes used in tests:

```ts
interface Tracker {
  listTriggered(rule): Promise<TicketRef[]>;
  getTicket(key): Promise<Ticket>;              // summary, description (rendered to markdown), acceptance criteria, comments, links, labels, reporter, assignee
  comment(key, markdown, opts?): Promise<{ id }>;
  transition(key, toStatusName): Promise<void>; // resolve transition id by name; no-op with a warning event if not available
  verifyWebhook(req): boolean;
  parseWebhook(req): TrackerEvent[];
}
interface Scm {
  resolveRepo(project): Promise<{ id, cloneUrl, defaultBranch, webUrl }>;
  cloneCredential(repo): { username, token };   // what the runner gets
  openMergeRequest(repo, { source, target, title, description, draft, labels, reviewers }): Promise<MergeRequest>;
  updateMergeRequest(repo, mrId, { description?, draft?, title? }): Promise<MergeRequest>;
  getMergeRequest(repo, mrId): Promise<MergeRequest>;   // state, web url, pipeline/checks status if cheap
  commentOnMergeRequest(repo, mrId, markdown): Promise<void>;
}
```

### 8.1 Jira

- **Webhook** (preferred): `POST /webhooks/jira` validated with a shared secret (header or query param, configurable since Jira Cloud and DC differ). Handles `jira:issue_updated` (assignee/label/status change matching the trigger rule) and `comment_created` (for §8.2). Jira Automation rules that call a webhook are also accepted (the UI shows a copy-paste JSON body example).
- **Polling** fallback: JQL every `pollIntervalSeconds` (default 60) for tickets matching the trigger rule and not yet having an active run.
- **Status mapping**: configurable Jira status names for `intake`, `implementing/reviewing` (one status, e.g. "In Progress"), `mr_ready` (e.g. "In Review"), `blocked` (e.g. "Needs Info"). Each optional.
- Comments are posted with a recognisable prefix (configurable, default `🤖 Mates:`) and end with a link to the run in the UI.

### 8.2 Clarification round-trip

When intake posts a clarification comment, the run is `blocked`. If a later comment on the ticket is from someone other than the Mates user (webhook `comment_created` or poll), the orchestrator moves the run to `queued` and the new intake receives the full comment thread. Guard against loops: at most 3 clarification rounds per run; then `failed { reason: 'clarification_limit' }`.

### 8.3 MR / PR content

Title: `<ticket key>: <ticket summary>` (truncated to 72 chars for GitHub; GitLab allows longer).

Description (regenerated after each iteration; sections in this order):

1. One-paragraph summary from the latest reviewer `summary` (or the implementer's if no verdict yet).
2. **Ticket** — link.
3. **Changes per iteration** — a short list: iteration, files changed, tests result, one-line verdict.
4. **Review** — the final verdict's non-blocking items as a checklist for the human; when blocked by the cap, an **Unresolved review points** section with the blocking items.
5. **Run** — link to the run in Mates, model(s), total cost, iterations.
6. Footer: `Generated by Mates <version>. Reviewed by an AI reviewer; a human must review before merging.`

Draft handling: GitLab → `draft: true` / title prefix as the API requires; GitHub → `draft: true` (requires a repo that allows draft PRs; if the API rejects, open as ready and add a `mates:draft` label; record the fallback in an event).

### 8.4 GitLab specifics

- Supports gitlab.com and self-hosted (`baseUrl`). Auth: PAT or project/group access token with `api` scope and `write_repository`. Clone over HTTPS with `oauth2:<token>` via credential helper.
- Webhooks for MR state (merged/closed) are **may**.

### 8.5 GitHub specifics

- Supports github.com and GitHub Enterprise Server (`baseUrl`). Auth: PAT (**must**) or GitHub App with installation token minting (**should**; preferred for production because tokens are short-lived). Clone with `x-access-token:<token>`.

---

## 9. Token usage and cost

### 9.1 Capture

Every invocation's final `result` message is the source: store `usage` (input, output, cache read, cache write tokens), the per-model breakdown when present, and `total_cost_usd` as `cost_usd_reported`. Also compute `cost_usd_computed` from the pricing table (§9.3) so the two can be compared; the UI shows `reported` by default and flags a > 10 % discrepancy.

The docs note these figures are client-side estimates and can differ from the bill — surface that as a tooltip, once, on the cost widgets.

Also record the mid-run running total: `--max-budget-usd` is enforced by Claude Code; the wrapper reads cost from the final result only. For live display, the UI estimates from tokens seen in `assistant` stream messages' `usage` when present; label it "estimate" until `invocation.finished`.

### 9.2 Aggregation

Materialised (or on-the-fly, if fast enough) rollups:

- per invocation, per run, per ticket, per repo, per Jira project, per mate, per model
- per day / week / month
- cost per *successful* MR (`done` runs), iterations-to-approval distribution, p50/p90 run duration

Expose at `GET /api/stats` with `from`, `to`, `group_by` and show on the UI's **Usage** page (§13.4) and in the board's stats strip.

### 9.3 Pricing table

`settings.pricing` — a JSON map `model id → { input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, currency: "USD" }`. Ship an empty table with a UI hint to fill it in from Anthropic's current price list (do **not** hard-code prices in the repo — they change). `cost_usd_computed` is null when the model is missing from the table; the UI then shows `reported` only.

### 9.4 Budgets

- Per invocation: passed to `--max-budget-usd`.
- Per run: checked before every spawn (§7.5 rule 7).
- Per day (global): checked before every spawn; when exceeded, runs stay `queued` and the board shows a banner with the reset time (midnight in the configured timezone).
- Optional per Jira project daily budget (**should**).

### 9.5 Ticket-level visibility

The Jira comment posted at `mr_ready`/`blocked` includes "Cost: $X · N iterations · model(s)". Configurable off.

---

## 10. Security

### 10.1 Kubernetes

- Runner pods: dedicated ServiceAccount with **no** Role bindings; `automountServiceAccountToken: false`; non-root; read-only root FS; all capabilities dropped; seccomp `RuntimeDefault`; resource limits always set.
- `mates-api` ServiceAccount: a namespaced Role allowing `jobs` (create/get/list/watch/delete), `pods` (get/list/watch), `pods/log` (get), `configmaps` and `secrets` (create/get/update/delete — restricted by name prefix where the cluster supports it; otherwise documented), nothing cluster-wide.
- NetworkPolicy (chart option, default on): runner pods may reach DNS, `mates-api`, and egress to the internet (or a configurable CIDR/FQDN allowlist if the cluster has an egress controller); runner pods may not reach each other, Postgres, or other namespaces. `mates-api` accepts ingress only from the ingress controller and runner pods.
- Pod Security Standards: the chart must work under the `restricted` profile.

### 10.2 Credentials

- One Secret `<release>-credentials` with keys `anthropic_api_key`, `jira_token`, `scm_<provider_id>_token`, `jira_webhook_secret`, `oidc_client_secret`. Managed by `mates-api` through the Kubernetes API. The UI never displays a stored value, only "set / not set / last validated".
- Per-invocation JWTs: HS256 with a key in `<release>-internal`, audience `mates-runner`, subject = invocation id, exp as in §5.1. Rotation on `helm upgrade` is acceptable.
- Git tokens reach the runner as env and are consumed by a credential helper; they must never appear in the clone URL, in `git remote -v`, in commits, or in events.
- Support for External Secrets Operator / pre-created Secrets: `credentials.existingSecret` in values turns the UI's credential fields read-only.

### 10.3 Redaction

A single `redact(text)` function applied to every event payload, blob, and log line forwarded by the runner: masks values of any configured secret, common token shapes (`ghp_…`, `glpat-…`, `sk-ant-…`, `Bearer …`, `AKIA…`, PEM blocks), and anything matching user-configured regexes. Unit-tested with fixtures.

### 10.4 Authentication & authorisation (UI/API)

- Local users (email + Argon2id password) **must**; OIDC (any compliant provider; `issuer`, `clientId`, `clientSecret`, `scopes`, optional group→role mapping) **should**.
- Roles: `viewer` (read everything), `operator` (viewer + pause/cancel/retry/nudge/manual run), `admin` (operator + settings, credentials, users, prompts).
- Session cookie (HttpOnly, SameSite=Lax, Secure when TLS) + CSRF token for mutating requests; personal API tokens for scripts.
- All mutating actions produce an audit event (`audit.*`) with actor, visible under Settings → Audit log.

### 10.5 Agent containment

- Agents cannot push (implementer: the wrapper pushes; reviewer: no write token — the SCM adapter must be able to mint read-only credentials where the provider supports it, otherwise the same token is used and the restriction is enforced by the wrapper not running `git push` and `Bash(git push *)` being denied).
- Agents never receive Jira or SCM API tokens — only the git clone credential. All Jira/MR API calls are made by `mates-api`.
- Everything the agent writes goes to a branch matching `branching.pattern`; the wrapper refuses to push to any other ref or to the default branch.
- `--max-turns`, `--max-budget-usd`, `activeDeadlineSeconds` and the emptyDir size limit bound every invocation.

---

## 11. Helm chart

```
charts/mates/
  Chart.yaml                     # dependencies: postgresql (bitnami) condition postgresql.enabled
  values.yaml
  values.schema.json             # validate values
  templates/
    _helpers.tpl
    api-deployment.yaml  api-service.yaml  api-serviceaccount.yaml  api-role.yaml  api-rolebinding.yaml
    runner-serviceaccount.yaml  networkpolicy.yaml  ingress.yaml  configmap-config.yaml
    secret-internal.yaml  secret-credentials.yaml (only if !existingSecret; created empty, owned by api)
    migration-job.yaml  (hook: pre-install, pre-upgrade)
    pdb.yaml  servicemonitor.yaml (optional)
    NOTES.txt                    # prints the URL and the bootstrap-token command
```

Key values (with defaults):

```yaml
image: { repository: ghcr.io/<org>/mates-api, tag: <chart appVersion>, pullPolicy: IfNotPresent }
runner: { image: { repository: ghcr.io/<org>/mates-runner, tag: <appVersion> }, resources: {...}, timeoutSeconds: 2700, workspaceSizeGi: 10 }
ingress: { enabled: false, className: "", host: "", tls: [] }
service: { type: ClusterIP, port: 8080 }
postgresql: { enabled: true, auth: { database: mates, username: mates } }      # bundled
externalDatabase: { url: "" , existingSecret: "", key: "" }                      # if postgresql.enabled=false
credentials: { existingSecret: "" }
auth: { oidc: { enabled: false, issuer: "", clientId: "", existingSecret: "" } }
networkPolicy: { enabled: true, egressAllowAll: true, egressCidrs: [] }
config:                                   # anything here is "managed by Helm" in the UI
  maxIterations: 4
  budgets: { perRunUsd: 25, perDayUsd: 200 }
  models: { intake: claude-sonnet-5-5, implementer: claude-opus-5-5, reviewer: claude-opus-5-5 }
  jira: { pollIntervalSeconds: 60 }
  retention: { transcriptsDays: 14, eventsDays: 365 }
  timezone: UTC
metrics: { enabled: true, serviceMonitor: { enabled: false } }
podSecurityContext / securityContext / nodeSelector / tolerations / affinity   # standard
```

Install must succeed on a plain `kind` cluster with `helm install mates ./charts/mates` and nothing else. `helm lint`, `helm template` + `kubeconform`, and a `kind`-based smoke test run in CI.

---

## 12. API surface

Prefix `/api`. JSON. All list endpoints paginate (`?cursor=&limit=`).

```
POST /setup/bootstrap                      { token, email, password }
POST /auth/login | /auth/logout | GET /auth/me | GET /auth/oidc/start | /auth/oidc/callback

GET  /runs?stage=&repo=&project=&q=        board data: projected runs with ticket, stage, iteration, elapsed, cost
GET  /runs/{id}                            projection + ticket + invocations + verdicts + nudges + usage
GET  /runs/{id}/events?after=              paginated event log
GET  /runs/{id}/stream                     SSE: events as they arrive (+ live-tail lines)
GET  /runs/{id}/blobs/{blob_id}            test logs, diffs, transcripts (role ≥ viewer; transcripts ≥ operator)
POST /runs/{id}/pause | /resume | /cancel | /retry   { reason? }     (operator)
POST /runs/{id}/nudges                     { text, post_to_tracker, and_retry }  (operator)
POST /runs                                 { ticket_key }  manual trigger        (operator)
GET  /stream                               SSE: global board updates

GET  /stats?from=&to=&group_by=            §9.2
GET  /tickets/{key}                        ticket with all its runs

GET/PUT /settings                          non-secret settings; PUT validates; returns which keys are Helm-managed   (admin)
GET/PUT /settings/credentials/{name}       PUT stores into the Secret; GET returns {set, last_validated_at}         (admin)
POST /settings/credentials/{name}/test     runs the adapter's connectivity test                                     (admin)
GET/POST /settings/team-context            current + history; POST { git: {url, ref} | upload }                      (admin)
POST /settings/team-context/refresh        fetch + validate now                                                      (admin)
GET/PUT /settings/prompts/{mate}           templates; PUT validates placeholders                                    (admin)
GET/PUT /settings/pricing                  §9.3                                                                      (admin)
GET /settings/audit                        audit events                                                              (admin)
GET/POST/DELETE /users, /api-tokens        (admin; users may manage their own tokens)

POST /webhooks/jira                        (secret-validated)
POST /webhooks/scm/{provider_id}           (may)

# runner-only, JWT:
POST /internal/invocations/{id}/events     [ {type, payload, ts}, ... ]
POST /internal/invocations/{id}/blobs/{kind}
GET  /internal/invocations/{id}/context    tar.gz of the context bundle

GET /healthz  GET /readyz  GET /metrics (Prometheus)
```

OpenAPI 3.1 document generated from the code and served at `/api/openapi.json`; the UI client is generated from it.

---

## 13. Web UI

Follow the mockup the team agreed on (two screens were designed: **Board** and **Ticket detail**; the look is a light, dense ops console — IBM Plex Sans/Mono, blue = running, green = approved/ready, amber = needs a human, one accent per meaning, no gradients). Where the mockup is silent, keep the same density and restraint.

### 13.1 Board (`/`)

- Header: product name, nav (Board · Tickets · Mates · Usage · Settings), running count, "need you" count, search, user menu.
- Stats strip: running now (by stage), waiting on a human, MRs opened today, average iterations-to-approval (7 d), spend today (tokens and USD) with ≈ per-ticket.
- **Needs a human** lane: one row per blocked run with the reason (clarification question text / cap reached / budget / failed), age, and actions (Reply on Jira → opens Jira; Nudge; View MR; Open).
- Columns: Queued · Intake · Implementing · In review · MR open · Blocked. Cards: ticket key (mono), title, repo, iteration bar (segments = max iterations; filled = done; colour by state), current action line ("Iteration 1 · running tests · 6 min"), MR id when open. Cards are links to the detail view. Live via SSE.
- Footer: merged this week (**may**: requires SCM webhook or polling MR state).

### 13.2 Ticket / run detail (`/runs/:id`)

- Header: key, title, chips (repo, branch, MR id + draft/ready, Jira status, run state), controls: Pause/Resume, Retry stage, Open workspace (**may**: downloads the last iteration's diff + logs as a tarball in v1), Cancel run (confirm dialog).
- Stage stepper: Queued → Intake → Implementing → In review (n/max) → MR ready → Human review, with timestamps and one-line notes.
- Left: **Timeline** with tabs Events · Diff per iteration · Raw log. Events render per §4.3 with the reviewer's blocking items expanded inline and non-blocking collapsed; implementer events show +/− lines, files, test result, duration, tokens/cost.
- Right: **Live tail** (dark panel, mono, one line per tool call / assistant text, Follow toggle, only while an invocation is running; otherwise shows "last lines of invocation N"). **Run facts**: elapsed, tokens and cost vs budget, iterations vs cap, team-context version, implementer/reviewer model, links (Jira, MR, workspace). **Nudge** composer with "Also post to Jira" and, when blocked, "and retry".
- Older runs for the same ticket are listed at the bottom.

### 13.3 Tickets (`/tickets`)

Table of all tickets ever seen with latest run stage, cost, iterations, MR link, filters by project/repo/stage/date. CSV export.

### 13.4 Usage (`/usage`)

Charts (simple, two-colour): cost per day (stacked by mate), tokens per day (stacked by model), iterations-to-approval histogram, cost per ready MR over time; tables: top tickets by cost, cost by repo, cost by Jira project. Date range picker. Note on estimate vs bill (§9.1).

### 13.5 Mates (`/mates`)

Shows the three mates with their model, permissions, budget, prompt (read-only here, edit under Settings → Prompts), and the active team-context version with its `mates.yaml` rendered (repos table) and version history with diffs.

### 13.6 Settings (`/settings/*`)

The wizard steps from §6.2 as tabs, plus Users, API tokens, Prompts, Pricing, Audit log. Helm-managed values are shown disabled with a "managed by Helm" badge.

### 13.7 Behaviour

- Everything updates live over SSE; no manual refresh needed; reconnect with backoff.
- Keyboard: `/` focuses search; `Esc` closes dialogs.
- Accessible: real buttons/links, labelled inputs, 4.5:1 contrast, works at 1024 px width (phone layout is **may**).

---

## 14. Observability

- Structured JSON logs (pino or equivalent) with `run_id`, `invocation_id`, `ticket_key` on every line; no secrets (§10.3).
- Prometheus metrics: `mates_runs_total{stage}`, `mates_invocations_total{mate,status}`, `mates_invocation_duration_seconds{mate}`, `mates_cost_usd_total{mate,model}`, `mates_tokens_total{mate,model,kind}`, `mates_iterations_to_approval` (histogram), `mates_queue_depth`, `mates_tracker_poll_errors_total`, `mates_scm_api_errors_total`.
- `/healthz` (process up) and `/readyz` (DB reachable, migrations applied, Kubernetes API reachable).
- Each Job/pod labelled so `kubectl logs -l mates/run=<id>` works.

---

## 15. Testing and acceptance criteria

### 15.1 Test layers

- Unit: projection (`projectRun`), state machine transitions, redaction, verdict schema validation, `mates.yaml` validation, pricing computation, branch/commit naming, MR description rendering, stream-json parsing (fixtures recorded from real `claude -p` runs with secrets stripped).
- Integration: adapters against recorded HTTP fixtures (nock/msw) for Jira Cloud, Jira DC, GitLab, GitHub; Postgres via testcontainers.
- End-to-end: `kind` cluster in CI, chart installed, a **fake Claude** mode (`MATES_FAKE_CLAUDE=1` makes the runner emit a scripted stream-json from a fixture instead of calling the real CLI) so the whole loop — webhook → intake → implementer → reviewer → MR — runs against a local Gitea/GitLab container or a GitHub/GitLab fixture server without spending tokens. One real-API smoke test behind a manual CI trigger.

### 15.2 Acceptance criteria per milestone

**M0 — Skeleton**: repo layout, CI (lint, typecheck, unit tests), Dockerfiles for api and runner, Helm chart installs on `kind` with bundled Postgres, `/readyz` green, `/setup` creates an admin. `docs/decisions/` exists.

**M1 — Event core**: tables + migrations; `projectRun`; event ingest endpoint with JWT auth; SSE per run and global; `POST /runs` manual trigger creates a run in `queued`. Unit tests for all transitions in §4.2.

**M2 — Runner + Jobs**: `mates-api` spawns a Job for a fake invocation; runner clones a repo from a local Gitea, runs `setup`, runs `claude` (real or fake), streams condensed events, pushes to a `mates/*` branch, uploads blobs, exits; pod phase → events; cancellation works; deterministic Job names; retries per §7.5 rule 6. Security contexts as in §7.2 enforced in the e2e test (pod spec assertions).

**M3 — Adapters**: Jira webhook + poll + comment + transition; GitLab and GitHub: resolve repo, open draft MR, update description, mark ready. All with recorded fixtures and "Test" endpoints.

**M4 — The loop**: intake → implementer → reviewer → iterate → ready/blocked exactly as §7.5; clarification round-trip (§8.2); nudges; pause/resume; budget blocking. Fake-Claude e2e for: approve on iteration 1, approve on iteration 3, cap hit at 4, needs clarification then answered, empty diff twice → failed.

**M5 — Cost ledger**: usage captured from `result`; computed vs reported; rollups; `/stats`; daily budget banner; Jira cost comment.

**M6 — UI**: Board and Ticket detail matching the mockup and §13.1–13.2 with live SSE; Settings wizard with all "Test" buttons; Usage page; Mates page; Tickets table. Playwright tests for the board, the detail timeline, a nudge, and the wizard.

**M7 — Hardening**: NetworkPolicy, PSS `restricted`, redaction fixtures, audit log, OIDC, GitHub App auth, ESO/existing-secret mode, retention jobs, `values.schema.json`, `NOTES.txt`, `README.md` with the ten-minute quickstart, `docs/operations.md` (backups, upgrades, scaling, troubleshooting a stuck run).

Definition of done for v1: a fresh `kind` cluster, `helm install`, the wizard completed against a real Jira + GitLab or GitHub, a ticket assigned, and a reviewed draft-then-ready MR produced with its cost visible in the UI and in the Jira comment.

---

## 16. Milestone order for the implementer

M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7, in that order. Each milestone ends with: tests green, `docs/plans/<milestone>.md` updated with what changed from the plan, and a short `CHANGELOG.md` entry. Do not start the UI (M6) before the loop (M4) works end-to-end with the fake Claude; the event model must stabilise first.

---

## 17. Decisions left to the implementer (record each in `docs/decisions/`)

1. TypeScript vs Go for `mates-api` (§3.3). Default TypeScript.
2. Migration tool and query layer (plain SQL + node-postgres is acceptable; avoid heavy ORMs).
3. Whether invocation context is delivered via ConfigMap or always via the download endpoint (§7.2). Download must exist; ConfigMap is optional.
4. Live-tail transport: SSE is required; whether to also persist tail lines as events or keep them in a ring buffer in memory (events are preferred for replay; cap per invocation at 5 000 lines, then summarise).
5. Multi-replica `mates-api`: v1 may require a single replica; if you add leader election, use a Postgres advisory lock, not a Kubernetes Lease, to keep RBAC minimal.
6. Whether to persist `~/.claude` session state to allow `--resume` across pods. Default no (stateless invocations with fresh context); document the trade-off.
7. Test-output parsers: which frameworks to parse in v1 (at least pytest, jest/vitest, go test, JUnit XML).
8. Charting library for the Usage page (small, no runtime theme dependency).

Anything else not covered: choose the simplest option that satisfies §3.2, write it down, move on.

---

## Appendix A — Fake Claude fixtures

`fixtures/claude/<scenario>.jsonl` — recorded `stream-json` output with these scenarios at minimum: `intake_implementable`, `intake_needs_clarification`, `impl_iter1_green`, `impl_iter2_addressed`, `review_changes_requested_2_blocking`, `review_approve`, `impl_empty_diff`, `impl_budget_exceeded`, `api_retry_then_success`. Each scenario's final `result` line carries realistic `usage` and `total_cost_usd` so the cost ledger is exercised. The runner in fake mode also applies a scripted patch file to the workspace so `git diff` is non-empty where the scenario says so.

## Appendix B — Example `brief.md` for the implementer (iteration 2)

```
# Task — API-198: Retry policy for webhook delivery (iteration 2 of 4)

You are the implementer. Repository: webhook-service (branch mates/API-198-retry-policy, base main).
Read /context/team/docs/conventions.md before anything else.

## Ticket
<summary, description, acceptance criteria, relevant comments>

## Plan from intake
1. … 2. … 3. …

## Reviewer verdict on iteration 1 — changes requested
Blocking:
- B1 Backoff is unbounded. The ticket caps retries at 5 attempts within 10 minutes; RetryPolicy.next() keeps doubling with no ceiling. (src/retry/policy.ts:41)
- B2 No test covers the dead-letter path. Exhausted deliveries must land in webhook_dlq; nothing asserts it.
Non-blocking (optional):
- N1 … N2 … N3 …

## Human note (nudge)
"Use the existing BackoffSchedule helper in shared/ instead of a new one." — Ana Keller, 14:40

## Rules
- Address every blocking item or explain why not. Non-blocking items are optional.
- Run `pnpm test` before you finish. Do not run git push; the system pushes for you.
- Finish with a JSON block: {"addressed": [...], "skipped": [{"id": "...", "reason": "..."}], "summary": "..."}
```
