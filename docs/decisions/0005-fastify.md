# 0005 — Fastify as the HTTP framework

Status: accepted, 2026-10-19.

## Decision

`mates-api` uses Fastify 5 with Zod-typed routes (`fastify-type-provider-zod`),
`@fastify/swagger` for the OpenAPI 3.1 document, `@fastify/cookie` for
sessions, and raw replies for SSE.

## Why

- Schema-first routes give request validation and the OpenAPI document from
  the same source, which §12 requires.
- Small, fast, well maintained, plain Node streams for SSE.

## Consequences

- Route handlers are thin: validate, call the application layer, map errors.
  No business logic in `packages/api/src/http`.
