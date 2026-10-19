# M3 — Adapters

Spec: §8 (integrations), §6.2 steps 2–3 ("Test" buttons), §8.3 (MR content),
§12 (`/webhooks/jira`, `/settings/credentials/{name}/test`), §15.2 (M3).

## Goal

Mates can talk to the outside world: receive and poll Jira, comment and
transition tickets; resolve repositories, open draft merge requests, update
their descriptions and mark them ready on GitLab and GitHub (and Gitea for
the e2e). Everything behind the two small interfaces of §8, with fakes for
the orchestrator tests and recorded HTTP fixtures for the adapters.

## Plan

1. **core**: `renderMrTitle` / `renderMrDescription` (§8.3) from a run
   projection; pure, tested.
2. **Interfaces** (`packages/api/src/tracker/`, `packages/api/src/scm/`):
   `Tracker` and `Scm` exactly as §8, plus `FakeTracker` / `FakeScm` used by
   the loop tests in M4.
3. **Jira** (`tracker/jira.ts`): Cloud (email + API token, ADF description
   rendered to markdown) and Data Center (PAT, wiki markup kept as text);
   `listTriggered` builds JQL from the trigger rule; `getTicket` maps
   summary, description, acceptance criteria (a custom field or a heading
   in the description), comments, links, labels; `comment` with the
   configurable prefix and a link to the run; `transition` resolves the
   transition by target status name and emits a warning event when absent;
   `verifyWebhook`/`parseWebhook` for `jira:issue_updated` and
   `comment_created`, secret in a header or query parameter.
4. **GitLab** (`scm/gitlab.ts`): `resolveRepo` (`GET /projects/:path`),
   `openMergeRequest` with `draft: true` (title prefix `Draft:`), labels,
   reviewers by username, `updateMergeRequest`, `getMergeRequest`,
   `commentOnMergeRequest`. Clone credential `oauth2:<token>`.
5. **GitHub** (`scm/github.ts`): `resolveRepo` (`GET /repos/:owner/:repo`),
   `openMergeRequest` with `draft: true` and the §8.3 fallback (label
   `mates:draft` + an event) when the repository rejects drafts, reviewers
   via `requested_reviewers`, `markReady` through the GraphQL
   `markPullRequestReadyForReview` mutation. PAT only in M3; the GitHub App
   is M7. Clone credential `x-access-token:<token>`.
6. **Gitea** (`scm/gitea.ts`): the GitHub-shaped API under `/api/v1`, used
   by the e2e; drafts via the `WIP:` title prefix.
7. **HTTP**: `POST /webhooks/jira`, `POST /api/settings/credentials/{name}/test`
   (Jira: auth + JQL + matched tickets; SCM: list accessible repositories;
   Anthropic: a short-lived Job, M6), Jira polling on
   `jira.poll_interval_seconds` creating runs idempotently.
8. **Fixtures**: recorded request/response pairs under
   `packages/api/test/fixtures/http/<provider>/*.json`, served by a fake
   `fetch`; one file per adapter method.

## Out of scope

Using the adapters inside the loop (M4), GitHub App auth and SCM webhooks
(M7 / may).

## What changed from the plan

- `Tracker.transition` returns a `TransitionResult` (ok/from/to/reason)
  instead of `void`, so the orchestrator can emit the warning event the spec
  asks for without a second call; `parseWebhook` takes the trigger rule so
  it can say whether an issue update matches it.
- Jira Cloud searches use `POST /rest/api/3/search/jql` (the v3 search
  endpoint); Data Center keeps `GET /rest/api/2/search`.
- The `RunStarter` enriches tickets from the tracker on every trigger
  (manual, webhook, poll) and owns the clarification re-queue (§8.2); the
  poller also detects new human comments for runs blocked on a question,
  so the round-trip works without webhooks.
- Credential "Test" for Jira and SCM providers is live; the Anthropic test
  needs a short-lived Job and lands with the settings UI (M6).
- GitHub App authentication is left for M7 as planned; the GitHub adapter
  already falls back to a ready PR plus the `mates:draft` label when a
  repository refuses drafts.
- Fixtures are hand-recorded request/response pairs served by a fake
  `fetch` rather than nock/msw: no dependency, same coverage, each adapter
  method asserts the exact request it sends.
