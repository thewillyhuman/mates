#!/usr/bin/env bash
# Installs the chart on the current kube context (a kind cluster), waits for
# readiness and completes first-run setup through the API. Used by CI and
# locally: scripts/kind-smoke.sh [api-tag] [runner-tag]
set -euo pipefail

API_TAG="${1:-smoke}"
RUNNER_TAG="${2:-smoke}"
NS="${MATES_SMOKE_NAMESPACE:-mates}"
RELEASE="mates"

helm upgrade --install "$RELEASE" charts/mates \
  --namespace "$NS" --create-namespace \
  --set image.repository=mates-api --set image.tag="$API_TAG" --set image.pullPolicy=Never \
  --set runner.image.repository=mates-runner --set runner.image.tag="$RUNNER_TAG" \
  --wait --timeout 5m

kubectl -n "$NS" rollout status deploy/"$RELEASE" --timeout=3m

kubectl -n "$NS" port-forward svc/"$RELEASE" 18080:8080 >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -fsS http://localhost:18080/readyz >/dev/null 2>&1 && break
  sleep 1
done

echo "readyz:"; curl -fsS http://localhost:18080/readyz; echo

TOKEN="$(kubectl -n "$NS" get secret "$RELEASE-bootstrap" -o jsonpath='{.data.token}' | base64 -d)"
test -n "$TOKEN"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST http://localhost:18080/api/setup/bootstrap \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"email\":\"admin@example.com\",\"password\":\"smoke-test-password\"}")"
test "$code" = "201" || { echo "setup failed with HTTP $code"; exit 1; }

# The token is single-use: the secret must be gone and setup disabled.
if kubectl -n "$NS" get secret "$RELEASE-bootstrap" >/dev/null 2>&1; then
  echo "bootstrap secret still present after setup"; exit 1
fi
curl -fsS http://localhost:18080/api/setup/status | grep -q '"setupRequired":false'
echo "smoke test passed"
