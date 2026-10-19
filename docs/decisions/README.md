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
