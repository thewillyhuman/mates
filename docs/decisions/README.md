# Decisions

One file per decision the spec left open (§17) or that deviates from it.
Numbered, never edited after the fact: supersede with a new file instead.

| # | Decision |
| --- | --- |
| [0001](0001-typescript-for-api.md) | TypeScript for `mates-api` and `mates-runner` |
| [0002](0002-plain-sql-migrations.md) | Plain SQL migrations + `node-postgres`, no ORM |
| [0003](0003-bundled-postgres-statefulset.md) | Bundled Postgres as an in-chart StatefulSet, not the Bitnami subchart |
| [0004](0004-monorepo-and-shared-core.md) | pnpm monorepo with a shared `@mates/core` library |
| [0005](0005-fastify.md) | Fastify as the HTTP framework |
| [0006](0006-migration-job-hook-timing.md) | Migration Job runs post-install, pre-upgrade |
| [0007](0007-in-process-event-bus.md) | In-process event bus, single API replica |
| [0008](0008-context-bundle-via-download.md) | Invocation context delivered by download only |
| [0009](0009-blobs-in-postgres.md) | Large artefacts stored in Postgres |
| [0010](0010-conventional-clone-urls.md) | Clone URLs derived from provider base URL until M3 |
| [0011](0011-no-claude-session-persistence.md) | No `~/.claude` persistence across pods |
| [0012](0012-test-output-parsers.md) | Test output parsers in v1 |
| [0013](0013-advisory-locks-and-polling-monitor.md) | Advisory locks per run; Job state by polling |
| [0014](0014-gitea-and-webhook-secret.md) | Gitea adapter, webhook secret scheme, acceptance-criteria detection |
| [0015](0015-retry-semantics.md) | What "retry" means for a blocked run |
| [0016](0016-charts.md) | Charts are hand-written SVG |
| [0017](0017-team-context-via-provider-archives.md) | Team context fetched as a provider archive |
| [0018](0018-audit-log-table.md) | Audit events in their own table |
