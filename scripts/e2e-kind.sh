#!/usr/bin/env bash
# End-to-end test on a kind cluster (§15.1, M2): Gitea + Mates in fake-Claude
# mode. Expects the images to be loaded into the cluster and the chart to be
# installed by scripts/kind-smoke.sh (setup completed, admin@example.com).
#
#   scripts/e2e-kind.sh [api-tag] [runner-tag]
set -euo pipefail

API_TAG="${1:-smoke}"
RUNNER_TAG="${2:-smoke}"
NS="${MATES_SMOKE_NAMESPACE:-mates}"
RELEASE="mates"
# Ticket keys carry a per-execution suffix so reruns on the same cluster never
# share a run or a branch. MATES_E2E_RESET=1 reinstalls Mates on a clean
# database first (local reruns; CI clusters are always fresh).
SUFFIX="$(date +%s | tail -c 5)"
K() { printf 'API-%s%s' "$1" "$SUFFIX"; }
GITEA_USER="mates"
GITEA_PASS="e2e-password-123"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASS="smoke-test-password"
WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

log() { printf '\n==> %s\n' "$*"; }
api() { curl -sS -b "$WORK/jar" -c "$WORK/jar" -H "x-csrf-token: ${CSRF:-}" "$@"; }

if [ "${MATES_E2E_RESET:-0}" = "1" ]; then
  log "resetting the mates install"
  helm -n "$NS" uninstall "$RELEASE" >/dev/null 2>&1 || true
  kubectl -n "$NS" delete pvc -l app.kubernetes.io/instance="$RELEASE" --ignore-not-found >/dev/null
  kubectl -n "$NS" delete secret "$RELEASE-bootstrap" "$RELEASE-internal" "$RELEASE-credentials" "$RELEASE-postgresql" --ignore-not-found >/dev/null
  kubectl -n "$NS" delete jobs -l app.kubernetes.io/name=mates-runner --ignore-not-found >/dev/null 2>&1 || true
  scripts/kind-smoke.sh "$API_TAG" "$RUNNER_TAG" >/dev/null
fi

# ---------------------------------------------------------------- Gitea
log "deploying gitea"
kubectl -n "$NS" apply -f test/e2e/gitea.yaml >/dev/null
kubectl -n "$NS" rollout status deploy/gitea --timeout=3m
kubectl -n "$NS" exec deploy/gitea -- \
  gitea admin user create --admin --username "$GITEA_USER" --password "$GITEA_PASS" --email mates@example.com --must-change-password=false \
  >/dev/null 2>&1 || echo "(gitea user exists)"
kubectl -n "$NS" port-forward svc/gitea 13000:3000 >/dev/null 2>&1 &
for _ in $(seq 1 30); do curl -fsS http://localhost:13000/api/healthz >/dev/null 2>&1 && break; sleep 1; done

GITEA_TOKEN="$(curl -fsS -u "$GITEA_USER:$GITEA_PASS" -X POST http://localhost:13000/api/v1/users/$GITEA_USER/tokens \
  -H 'content-type: application/json' \
  -d "{\"name\":\"mates-$(date +%s)\",\"scopes\":[\"write:repository\",\"write:user\",\"write:issue\",\"read:organization\"]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha1"])')"
curl -fsS -u "$GITEA_USER:$GITEA_PASS" -X POST http://localhost:13000/api/v1/user/repos \
  -H 'content-type: application/json' -d '{"name":"webhook-service","default_branch":"main","auto_init":false}' >/dev/null 2>&1 || echo "(repo exists)"

log "pushing the seed repository"
cp -r test/e2e/seed-repo "$WORK/seed" && cd "$WORK/seed"
git init -q -b main . && git add -A && git -c user.name=seed -c user.email=seed@example.com commit -qm "seed"
printf '#!/bin/sh\necho "%s"\n' "$GITEA_TOKEN" > "$WORK/askpass" && chmod +x "$WORK/askpass"
GIT_ASKPASS="$WORK/askpass" git push -q --force "http://$GITEA_USER@localhost:13000/$GITEA_USER/webhook-service.git" main
cd - >/dev/null

# ---------------------------------------------------------------- Mates
log "installing mates in fake-claude mode"
helm upgrade --install "$RELEASE" charts/mates --namespace "$NS" \
  --set image.repository=mates-api --set image.tag="$API_TAG" --set image.pullPolicy=Never \
  --set runner.image.repository=mates-runner --set runner.image.tag="$RUNNER_TAG" \
  --set runner.fakeClaude=true --set runner.resources.requests.cpu=100m --set runner.resources.requests.memory=128Mi \
  --wait --timeout 5m >/dev/null
kubectl -n "$NS" rollout status deploy/"$RELEASE" --timeout=3m >/dev/null
kubectl -n "$NS" port-forward svc/"$RELEASE" 18080:8080 >/dev/null 2>&1 &
for _ in $(seq 1 30); do curl -fsS http://localhost:18080/readyz >/dev/null 2>&1 && break; sleep 1; done

log "signing in"
api -X POST http://localhost:18080/api/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" >/dev/null
CSRF="$(grep mates_csrf "$WORK/jar" | awk '{print $7}')"

log "configuring source control, credential and team context"
api -X PUT http://localhost:18080/api/settings -H 'content-type: application/json' \
  -d "{\"scm\":{\"providers\":[{\"id\":\"gitea\",\"type\":\"gitea\",\"base_url\":\"http://gitea.$NS.svc:3000\",\"username\":\"$GITEA_USER\"}]}}" >/dev/null
api -X PUT http://localhost:18080/api/settings/credentials/scm_gitea_token -H 'content-type: application/json' \
  -d "{\"value\":\"$GITEA_TOKEN\"}" | grep -q '"set":true'
tar -czf "$WORK/team.tgz" -C test/e2e/team-context .
api -X POST http://localhost:18080/api/settings/team-context -H 'content-type: application/gzip' --data-binary @"$WORK/team.tgz" \
  | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["active"], v["errors"]; print("team context v%d active" % v["version"])'

# ---------------------------------------------------------------- Run
log "triggering a run"
RUN_ID="$(api -X POST http://localhost:18080/api/runs -H 'content-type: application/json' -d "{\"ticket_key\":\"$(K 198)\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "run $RUN_ID"

# The intake invocation is the first one; the loop continues past it (M4).
intake_status() { api "http://localhost:18080/api/runs/$RUN_ID" | python3 -c '
import json,sys
p=json.load(sys.stdin)["projection"]
inv=p["invocations"][0] if p["invocations"] else None
print(p["stage"], inv["status"] if inv else "-", inv["jobName"] if inv else "-")'; }

for i in $(seq 1 120); do
  read -r STAGE INV_STATUS JOB <<<"$(intake_status)"
  [ "$INV_STATUS" = "succeeded" ] || [ "$INV_STATUS" = "failed" ] && break
  sleep 2
done
echo "stage=$STAGE intake=$INV_STATUS job=$JOB"
kubectl -n "$NS" get pods -l "mates/run=$RUN_ID" -o wide || true
if [ "$INV_STATUS" != "succeeded" ]; then
  kubectl -n "$NS" logs -l "mates/run=$RUN_ID" --tail=50 || true
  api "http://localhost:18080/api/runs/$RUN_ID/events" | python3 -m json.tool | tail -40
  echo "intake invocation did not succeed"; exit 1
fi

log "asserting the job spec (§7.2) and the event log"
kubectl -n "$NS" get job "$JOB" -o json | python3 -c '
import json,sys
j=json.load(sys.stdin); s=j["spec"]; p=s["template"]["spec"]; c=p["containers"][0]
assert s["backoffLimit"]==0 and s["ttlSecondsAfterFinished"]==3600, s
assert p["automountServiceAccountToken"] is False and p["restartPolicy"]=="Never"
assert p["securityContext"]["runAsNonRoot"] and p["securityContext"]["runAsUser"]==1000 and p["securityContext"]["seccompProfile"]["type"]=="RuntimeDefault"
sc=c["securityContext"]; assert sc["readOnlyRootFilesystem"] and not sc["allowPrivilegeEscalation"] and sc["capabilities"]["drop"]==["ALL"]
assert c["command"]==["mates-run"] and "limits" in c["resources"]
assert j["metadata"]["labels"]["mates/mate"]=="intake"
env={e["name"]:e for e in c["env"]}
assert "secretKeyRef" in env["MATES_INVOCATION_TOKEN"]["valueFrom"] and "secretKeyRef" in env["GIT_TOKEN"]["valueFrom"]
assert env["MATES_FAKE_CLAUDE"]["value"]=="1"
print("job spec ok")'
api "http://localhost:18080/api/runs/$RUN_ID/events" | python3 -c '
import json,sys
ev=json.load(sys.stdin)["events"]; types=[e["type"] for e in ev]
for t in ["run.created","run.stage_changed","invocation.scheduled","invocation.started","invocation.tool_use","invocation.text","invocation.finished"]:
    assert t in types, (t, types)
fin=[e for e in ev if e["type"]=="invocation.finished"][0]["payload"]
assert fin["exit_code"]==0, fin
assert fin["result"]["structured_output"]["decision"]=="implementable", fin["result"]
assert fin["transcript_ref"], "transcript blob missing"
assert fin["result"]["total_cost_usd"]>0
print("events ok:", " ".join(types))'
# token must not leak anywhere in the log or in pod logs
api "http://localhost:18080/api/runs/$RUN_ID/events" | grep -q "$GITEA_TOKEN" && { echo "git token leaked into events"; exit 1; }
kubectl -n "$NS" logs -l "mates/run=$RUN_ID" --tail=-1 2>/dev/null | grep -q "$GITEA_TOKEN" && { echo "git token leaked into pod logs"; exit 1; }
echo "no token leak"

# ---------------------------------------------------------------- Cancel
log "cancelling a second run while its invocation is live"
RUN2="$(api -X POST http://localhost:18080/api/runs -H 'content-type: application/json' -d "{\"ticket_key\":\"$(K 199)\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
for _ in $(seq 1 30); do
  JOB2="$(kubectl -n "$NS" get jobs -l "mates/run=$RUN2" -o name 2>/dev/null | head -1)"
  [ -n "$JOB2" ] && break; sleep 1
done
test -n "$JOB2"
STAGE2="$(api -X POST "http://localhost:18080/api/runs/$RUN2/cancel" -H 'content-type: application/json' -d '{"reason":"e2e"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["projection"]["stage"])')"
test "$STAGE2" = "cancelled"
for _ in $(seq 1 30); do
  kubectl -n "$NS" get "$JOB2" >/dev/null 2>&1 || break; sleep 1
done
kubectl -n "$NS" get "$JOB2" >/dev/null 2>&1 && { echo "job still exists after cancel"; exit 1; }
echo "cancel ok"

# ---------------------------------------------------------------- The loop (M4)
# Each scenario sets the fake fixtures per mate, triggers a run and waits for
# a terminal or blocked stage, then checks the pull request on Gitea.
gitea_api() { curl -sS -u "$GITEA_USER:$GITEA_PASS" "http://localhost:13000/api/v1$1"; }
pr_for_branch() { gitea_api "/repos/$GITEA_USER/webhook-service/pulls?state=all&limit=50" | python3 -c "
import json,sys
prs=[p for p in json.load(sys.stdin) if p['head']['ref']=='$1']
print(json.dumps(prs[0]) if prs else '')"; }

scenario() {  # <key> <intake-json> <implementer-json> <reviewer-json> <max_iterations> <expected stage>
  local key="$1" intake="$2" impl="$3" rev="$4" maxit="$5" expected="$6"
  log "scenario $key → expect $expected"
  api -X PUT http://localhost:18080/api/settings -H 'content-type: application/json' \
    -d "{\"fake_claude\":{\"scenarios\":{\"intake\":$intake,\"implementer\":$impl,\"reviewer\":$rev}},\"limits\":{\"max_iterations\":$maxit}}" >/dev/null
  SCENARIO_RUN="$(api -X POST http://localhost:18080/api/runs -H 'content-type: application/json' -d "{\"ticket_key\":\"$key\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  local stage="" i
  for i in $(seq 1 240); do
    stage="$(api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["projection"]["stage"])')"
    case "$stage" in done|failed|cancelled|blocked) break ;; esac
    sleep 3
  done
  api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c "
import json,sys
p=json.load(sys.stdin)['projection']
print('  stage=%s iteration=%s verdicts=%s cost=%.4f mr=%s' % (p['stage'], p['iteration'], [v['decision'] for v in p['verdicts']], p['usage']['costUsd'], (p['mr'] or {}).get('url')))
assert p['stage']=='$expected', 'expected $expected, got ' + p['stage']"
  SCENARIO_BRANCH="$(api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"])')"
}

scenario "$(K 301)" '["intake_implementable"]' '["impl_iter1_green"]' '["review_approve"]' 4 done
pr_for_branch "$SCENARIO_BRANCH" | python3 -c "
import json,sys; pr=json.loads(sys.stdin.read() or 'null'); assert pr, 'no pull request for the branch'
assert not pr['title'].startswith('WIP'), pr['title']; assert pr['state']=='open'
assert '## Review' in pr['body'] and 'Generated by Mates' in pr['body'], pr['body'][:200]
print('  pull request #%d ready: %s' % (pr['number'], pr['title']))"
gitea_api "/repos/$GITEA_USER/webhook-service/branches/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$SCENARIO_BRANCH")" | grep -q '"name"' && echo "  branch pushed"

scenario "$(K 302)" '["intake_implementable"]' '["impl_iter1_green","impl_iter2_addressed","impl_iter2_addressed"]' '["review_changes_requested_2_blocking","review_changes_requested_2_blocking","review_approve"]' 4 done
api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c "
import json,sys; p=json.load(sys.stdin)['projection']; assert p['iteration']==3, p['iteration']; print('  approved on iteration 3')"

scenario "$(K 303)" '["intake_implementable"]' '["impl_iter1_green"]' '["review_changes_requested_2_blocking"]' 2 blocked
api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c "
import json,sys; p=json.load(sys.stdin)['projection']; assert p['iteration']==2 and p['maxIterations']==2, (p['iteration'], p['maxIterations'])"
pr_for_branch "$SCENARIO_BRANCH" | python3 -c "
import json,sys; pr=json.loads(sys.stdin.read() or 'null'); assert pr, 'no pull request'
assert pr['title'].startswith('WIP:'), pr['title']; assert 'Unresolved review points' in pr['body']
print('  draft stays open with unresolved points: %s' % pr['title'])"

scenario "$(K 304)" '["intake_needs_clarification","intake_implementable"]' '["impl_iter1_green"]' '["review_approve"]' 4 blocked
api -X POST "http://localhost:18080/api/runs/$SCENARIO_RUN/nudges" -H 'content-type: application/json' \
  -d '{"text":"Free tier is 100 req/min.","post_to_tracker":false,"and_retry":true}' >/dev/null
for i in $(seq 1 240); do
  stage="$(api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["projection"]["stage"])')"
  case "$stage" in done|failed|cancelled) break ;; esac
  sleep 3
done
api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c "
import json,sys; p=json.load(sys.stdin)['projection']
assert p['stage']=='done', p['stage']; assert p['clarificationRounds']==1
print('  clarification answered, then done (%d iteration)' % p['iteration'])"

scenario "$(K 305)" '["intake_implementable"]' '["impl_empty_diff"]' '["review_approve"]' 4 failed
api "http://localhost:18080/api/runs/$SCENARIO_RUN" | python3 -c "
import json,sys; p=json.load(sys.stdin)['projection']; assert p['failure']['reason']=='empty_diff', p['failure']; print('  failed: empty_diff after two empty iterations')"

log "e2e passed"
