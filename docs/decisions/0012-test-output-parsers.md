# 0012 — Test output parsers in v1

Spec §7.3 step 6, §17.7. Status: accepted, 2026-10-19.

## Decision

The runner parses the canonical `test` command's output for pytest,
jest/vitest, `go test`, `cargo test` and JUnit XML (when the command writes
a `junit*.xml` under the workspace). Anything else yields `passed: null`
with the log reference.

## Why

- These cover the stacks the runner image ships (Node, Python) plus the two
  compiled ecosystems most likely to appear in a `FROM mates-runner` image.
- Parsers are regex summaries of the final lines, kept in `core` with
  fixtures; adding one is a small, isolated change.
