# 0001 — TypeScript for `mates-api` and `mates-runner`

Spec §3.3 / §17.1. Status: accepted, 2026-10-19.

## Decision

Both services are TypeScript on Node 22 LTS (ES modules, strict mode).

## Why

- The spec's default; the Claude Agent SDK and `@kubernetes/client-node` are
  first-class in TypeScript.
- One language for API, runner and UI means the projection (`projectRun`),
  redaction and `mates.yaml` validation are written once and shared.
- A single implementer keeps one toolchain, one test runner, one linter.

## Consequences

- Images use `gcr.io/distroless/nodejs22-debian12` for the API.
- The runner wrapper is compiled to a single file with `esbuild`.
