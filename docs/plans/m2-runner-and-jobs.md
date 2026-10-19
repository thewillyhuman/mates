# M2 — Runner + Jobs

Spec: §7 (runner), §5.1 items 3–4, §10.1–10.3, §10.5, §12 (internal
endpoints, cancel), §15.2 (M2), Appendix A.

## Goal

`mates-api` can turn an invocation row into a Kubernetes Job; the pod runs
`mates-run`, which downloads its context bundle, clones the repository,
runs `setup`, runs Claude Code (real or fake), streams condensed events,
pushes to a `mates/*` branch, uploads blobs and reports its result. Pod
phase changes become events, cancellation kills the pod cleanly, infra
failures are retried once with a `-r1` Job.

## Plan

1. **core**: `redact(text, secrets)` (§10.3) with fixtures; `mates.yaml`
   schema + `validateTeamManifest` (§6.3); `branchName` / `commitMessage`
   (§6.3 `branching`); test-output parsers for pytest, jest/vitest, go test,
   cargo test and JUnit XML (§17.7).
2. **fixtures/claude**: the nine Appendix A scenarios as hand-written
   stream-json in the 2.1.303 envelope shape, each with a realistic final
   `result`, plus a patch per implementer scenario.
3. **runner** (`mates-run`): api client (batched events, blobs, context
   download), stream-json parser → condensed events, git operations through
   a credential helper, setup with timeout, Claude execution with the §7.3
   flags, fake mode replaying a fixture and applying its patch, commit/push
   guarded to the run branch, test run + parse, blob upload, redaction,
   SIGTERM handling.
4. **api**: migration 0003 (`blobs`, `team_context`); settings service with
   Helm precedence; team-context upload + validation; SCM provider settings
   and credential storage; context bundle builder (ticket, team package,
   brief, system prompt, schemas, prior verdicts, nudges, reviewer diff +
   tests log); `JobSpawner` (manifest per §7.2, per-invocation Secret with
   the JWT and git token, owner references); `PodWatcher` (Job/pod →
   `invocation.started|failed`, timeouts); blob and context endpoints;
   `POST /runs/{id}/cancel`; retry-once supervisor (§7.5 rule 6).
5. **e2e** (`test/e2e/`): on kind, deploy Gitea, seed a repository, upload a
   team context, trigger a run in fake mode and assert: Job name, pod
   security context, events in order, branch pushed, blobs stored,
   cancellation of a running invocation.

## Out of scope

Jira/GitLab/GitHub API adapters (M3; clone URLs are derived
conventionally until then, decision 0010), the full loop (M4), cost
ledger (M5).

## What changed from the plan

- The stream-json fixtures are authored, not recorded: a real
  `claude --bare -p` run captured the 2.1.303 envelope shapes (init,
  assistant with `message.usage`, result with `usage`/`modelUsage`/
  `total_cost_usd`/`is_error`), but the session had no API key, so the
  tool-call content is hand-written to those shapes. The real-API smoke
  test (M7, manual trigger) is where they get validated against a live run.
- `invocation.finished` carries the redacted final `result` message and a
  `transcript_ref`; `implementation.pushed` carries `changed_in_iteration`
  and `diff_ref`; `invocation.heartbeat` carries a cumulative token estimate.
- The reconcile loop uses a per-run advisory lock instead of
  `FOR UPDATE SKIP LOCKED`, and Job state is polled rather than watched
  (decision 0013). The loop already handles `queued → intake` so the e2e can
  exercise a real Job; M4 adds the rest of the decision table.
- The runner refuses to push outside the branching pattern or to the default
  branch, runs the implementer's commit itself, and in fake mode applies the
  scenario's patch before the result line so `git diff` is real.
- Intake runs without a checkout when more than one repository matches the
  ticket's Jira project; `invocation.json.repo` is nullable.
- Two in-cluster lessons: the `core` package manifest must be in the image
  build's install layer, and the context bundle must not contain a `.`
  member (tar would chmod the `/context` emptyDir the runner does not own).
- Verified on kind: Gitea seeded from `test/e2e/seed-repo`, chart installed
  with `runner.fakeClaude=true`, a manual run spawns a Job whose pod spec
  matches §7.2, the runner clones over the credential helper, replays the
  intake fixture, uploads the transcript and reports `implementable`; a
  second run is cancelled while its Job is live. `scripts/e2e-kind.sh` runs
  the same in CI after the smoke test.
