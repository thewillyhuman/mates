# 0016 — Charts are hand-written SVG

Spec §13.4, §17.8. Status: accepted, 2026-10-19.

## Decision

The Usage page draws its four charts (cost per day stacked by mate, tokens
per day stacked by model, iterations-to-approval histogram, cost per
ready MR over time) with a small in-repo SVG component: stacked bars and
a histogram, two-colour scales, axis labels, hover values.

## Why

- The spec wants simple two-colour charts with no runtime theme
  dependency; a charting library brings more code than the charts need
  and its own theming.
- SVG in React is a few dozen lines per chart, testable as plain
  components, and renders identically in light and dark.

## Consequences

- No zoom, brushing or animations; the date-range picker is the way to
  look closer.
- Adding a chart type means adding a component, not a config.
