# 0011 — No `~/.claude` persistence across pods

Spec §17.6. Status: accepted, 2026-10-19.

## Decision

Each invocation runs Claude Code with a fresh home directory. Nothing is
resumed with `--resume`; the brief carries everything the mate needs
(ticket, plan, prior verdicts, nudges).

## Why

- §3.2 wants state to travel through git and the event log only; a
  persisted session is a third, opaque channel.
- The reviewer must not see the implementer's reasoning (§3.2); a shared
  session store would make that leak easy.
- Resumption would need a PVC per run and a cleanup policy.

## Consequences

- An implementer on iteration n re-reads the repository; the brief's
  verdict and `addressed` sections replace memory. Cost per iteration is
  higher than with a resumed session; it is visible in the ledger.
