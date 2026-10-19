# 0003 — Bundled Postgres as an in-chart StatefulSet

Spec §11 says `Chart.yaml` depends on the Bitnami `postgresql` subchart.
Status: accepted deviation, 2026-10-19.

## Decision

`postgresql.enabled=true` renders a single-replica StatefulSet using the
official `postgres:16` image, a Service and a Secret, all in this chart.
`postgresql.enabled=false` + `externalDatabase` is unchanged from the spec.

## Why

- In 2025 Bitnami moved its images behind a paid catalogue and left the
  free tags frozen. A chart that must install "on a plain kind cluster with
  nothing else" cannot depend on a registry policy outside our control.
- The bundled database is for evaluation and small teams; a 70-line template
  is easier to operate and to revert than a 2 000-line subchart.

## Consequences

- Production deployments should use `externalDatabase`. Documented in
  `docs/operations.md`.
- No subchart value passthrough; the bundled DB has four knobs
  (image, storage size, storage class, resources).
