# 0014 — Gitea adapter, webhook secret scheme, acceptance-criteria detection

Spec §8.1, §8.5, §15.1. Status: accepted, 2026-10-19.

## Decisions

1. A third `Scm` implementation, **Gitea**, ships next to GitLab and GitHub.
   It speaks Gitea's GitHub-shaped `/api/v1`, uses `WIP:` titles for drafts
   and resolves labels to ids.
2. Jira webhooks are authenticated with a **shared secret** carried either
   in the `X-Mates-Secret` header or the `secret` query parameter
   (`jira.webhook_secret_in`), compared in constant time.
3. Acceptance criteria come from an optional **custom field**
   (`jira.acceptance_criteria_field`) or, when unset, from a heading or
   bold label named "Acceptance criteria" inside the description.
4. Comments posted by Mates are recognised **by their prefix** (and the
   configured Jira email when present), so the clarification round-trip
   needs no extra API call to learn its own identity.

## Why

- §15.1 wants the loop exercised against a local Gitea; an adapter is far
  simpler than making the GitHub adapter tolerate Gitea's differences, and
  Gitea/Forgejo are common self-hosted forges anyway.
- Jira Cloud does not sign webhook deliveries and Data Center differs; a
  shared secret works for both and for Automation rules.
- Teams keep acceptance criteria in different places; both common layouts
  are covered without a per-team parser.

## Consequences

- `scm.providers[].type` accepts `gitea`; `mates.yaml` `scm` values must
  match a provider id, as before.
- A webhook URL carrying the secret in the query is visible in Jira's
  configuration screen; the header form is the default.
