# Changelog

All notable changes to Mates. Format: one entry per milestone, newest first.

## Unreleased

### M0 — Skeleton

- pnpm workspace with `core`, `api`, `runner`, `ui` packages.
- `mates-api`: config, logging, migrations, `/healthz`, `/readyz`,
  bootstrap token, first-admin setup, local login.
- Container images for `mates-api` and `mates-runner`.
- Helm chart with bundled Postgres; installs on `kind`.
- CI: lint, typecheck, unit tests, chart lint, kind smoke test.
