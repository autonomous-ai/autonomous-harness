#!/usr/bin/env bash
set -euo pipefail

if [[ "${PROD_TERMINAL_E2E:-}" != "1" ]]; then
  echo "REFUSED: export PROD_TERMINAL_E2E=1 to opt in to production E2E" >&2
  exit 64
fi

for name in E2E_RELEASE_TAG E2E_RELEASE_SHA E2E_DESKTOP_SHA E2E_MACHINE_NAME E2E_K8S_NAMESPACE E2E_API_DEPLOYMENT E2E_WORKER_DEPLOYMENT; do
  if [[ -z "${!name:-}" ]]; then
    echo "MISSING: $name" >&2
    exit 64
  fi
done

for command in git gh curl jq kubectl flutter harness tmux grep node; do
  command -v "$command" >/dev/null || { echo "MISSING TOOL: $command" >&2; exit 69; }
done

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTONOMOUS_CODE_ROOT="${AUTONOMOUS_CODE_ROOT:-$DESKTOP_ROOT/../../autonomous-code}"
[[ -d "$AUTONOMOUS_CODE_ROOT/apps/backend" ]] \
  || { echo "MISSING AUTONOMOUS_CODE_ROOT: $AUTONOMOUS_CODE_ROOT" >&2; exit 69; }
AUTONOMOUS_CODE_ROOT="$(cd "$AUTONOMOUS_CODE_ROOT" && pwd)"
HARNESS_ROOT="${HARNESS_REPO_ROOT:-$DESKTOP_ROOT/..}"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/terminal-prod-e2e.XXXXXX")"
RUN_ID="${$}-$(date +%s)"
TMUX_PRIMARY="terminal-prod-e2e-${RUN_ID}-a"
TMUX_SECONDARY="terminal-prod-e2e-${RUN_ID}-b"
PRIMARY_MARKER="PROD_TERMINAL_E2E_A_${RUN_ID}"
SECONDARY_MARKER="PROD_TERMINAL_E2E_B_${RUN_ID}"
PRIMARY_PANE=""
SECONDARY_PANE=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  tmux kill-session -t "$TMUX_PRIMARY" >/dev/null 2>&1 || true
  tmux kill-session -t "$TMUX_SECONDARY" >/dev/null 2>&1 || true
  if [[ "${PROD_TERMINAL_E2E_KEEP:-0}" == "1" ]]; then
    echo "Prod E2E metadata kept at $RUN_ROOT"
  else
    rm -rf "$RUN_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

cd "$DESKTOP_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSED: desktop working tree must be clean for release evidence" >&2
  exit 65
fi
if [[ "$(git rev-parse HEAD)" != "$E2E_DESKTOP_SHA" ]]; then
  echo "REFUSED: desktop HEAD does not match E2E_DESKTOP_SHA" >&2
  exit 65
fi
cd "$AUTONOMOUS_CODE_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSED: autonomous-code working tree must be clean for release evidence" >&2
  exit 65
fi
if [[ "$(git rev-list -n 1 "$E2E_RELEASE_TAG")" != "$E2E_RELEASE_SHA" ]]; then
  echo "REFUSED: release tag does not point to expected SHA" >&2
  exit 65
fi
# Desktop-only fixes may be committed after the Backend image was tagged. The
# production smoke is valid only when no Backend build input changed between
# that exact release revision and the Desktop revision under test.
backend_inputs=(apps/backend package.json yarn.lock)
for optional_input in pnpm-lock.yaml package-lock.json; do
  [[ -e "$optional_input" ]] && backend_inputs+=("$optional_input")
done
if ! git diff --quiet "$E2E_RELEASE_SHA"..HEAD -- "${backend_inputs[@]}"; then
  echo "REFUSED: Backend inputs changed after E2E_RELEASE_SHA; release a new Backend tag" >&2
  exit 65
fi

deploy_deadline=$((SECONDS + ${E2E_DEPLOY_TIMEOUT_SECONDS:-600}))
run_row=""
while [[ -z "$run_row" && "$SECONDS" -lt "$deploy_deadline" ]]; do
  run_row="$(gh run list --workflow='Docker production backend build' --limit 30 \
    --json databaseId,headBranch,headSha,conclusion \
    --jq ".[] | select(.headBranch == \"$E2E_RELEASE_TAG\" and .headSha == \"$E2E_RELEASE_SHA\") | [.databaseId, .conclusion] | @tsv" \
    | head -1)"
  [[ -n "$run_row" ]] || sleep 5
done
if [[ -z "$run_row" ]]; then
  echo "DEPLOY_NOT_READY: no GitHub Actions run for exact tag/SHA" >&2
  exit 75
fi
run_id="${run_row%%$'\t'*}"
conclusion="${run_row#*$'\t'}"
if [[ "$conclusion" != "success" ]]; then
  gh run watch "$run_id" --exit-status
fi
conclusion="$(gh run view "$run_id" --json conclusion --jq .conclusion)"
[[ "$conclusion" == "success" ]] || { echo "DEPLOY_NOT_READY: backend build did not succeed" >&2; exit 75; }

for deployment in "$E2E_API_DEPLOYMENT" "$E2E_WORKER_DEPLOYMENT"; do
  image=""
  while [[ "$SECONDS" -lt "$deploy_deadline" ]]; do
    image="$(kubectl -n "$E2E_K8S_NAMESPACE" get deployment "$deployment" \
      -o jsonpath='{.spec.template.spec.containers[*].image}')"
    [[ "$image" == *":$E2E_RELEASE_TAG"* ]] && break
    sleep 5
  done
  if [[ "$image" != *":$E2E_RELEASE_TAG"* ]]; then
    echo "DEPLOY_NOT_READY: $deployment image does not contain exact tag $E2E_RELEASE_TAG" >&2
    exit 75
  fi
  kubectl -n "$E2E_K8S_NAMESPACE" rollout status "deployment/$deployment" --timeout=5m
  deployment_json="$(kubectl -n "$E2E_K8S_NAMESPACE" get deployment "$deployment" -o json)"
  printf '%s' "$deployment_json" | jq -e \
    '.status.replicas > 0 and .status.readyReplicas == .status.replicas and .status.updatedReplicas == .status.replicas and .status.unavailableReplicas == null' \
    >/dev/null
  selector="$(printf '%s' "$deployment_json" | jq -r '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")')"
  kubectl -n "$E2E_K8S_NAMESPACE" get pods -l "$selector" -o json | jq -e \
    '[.items[] | select(.status.phase != "Running" or ([.status.containerStatuses[]? | select(.ready != true)] | length > 0) or ([.status.containerStatuses[]?.state.waiting.reason? | select(. == "CrashLoopBackOff" or . == "ImagePullBackOff" or . == "ErrImagePull")] | length > 0))] | length == 0' \
    >/dev/null
done

health_ready=0
while [[ "$SECONDS" -lt "$deploy_deadline" ]]; do
  if health="$(curl --fail --silent --show-error https://harness-api.autonomous.ai/api/health 2>/dev/null)" \
    && printf '%s' "$health" | jq -e '.success == true and .data.status == "ok"' >/dev/null; then
    health_ready=1
    break
  fi
  sleep 3
done
[[ "$health_ready" == "1" ]] || { echo "DEPLOY_NOT_READY: production health did not become ready" >&2; exit 75; }

cd "$HARNESS_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "REFUSED: Harness source used for official E2E must be clean" >&2
  exit 65
fi
local_sha="$(git rev-parse --short HEAD)"
harness_version="$(harness version)"
if [[ "$harness_version" != *"$local_sha"* || "$harness_version" == *".dirty"* ]]; then
  echo "REFUSED: installed Harness does not match clean local source SHA $local_sha" >&2
  exit 65
fi
harness_status="$(harness status)"
if [[ "$harness_status" != *"harness-api.autonomous.ai"* || "$harness_status" != *"● running"* ]]; then
  echo "REFUSED: Harness is not running against production" >&2
  exit 65
fi
if [[ "$harness_status" != *"$E2E_MACHINE_NAME"* ]]; then
  echo "REFUSED: joined machine does not match E2E_MACHINE_NAME" >&2
  exit 65
fi
dashboard_url="$(printf '%s\n' "$harness_status" | sed -nE 's/^[[:space:]]*dashboard[[:space:]]+(http[^[:space:]]+).*$/\1/p' | head -1)"
[[ -n "$dashboard_url" ]] || { echo "REFUSED: Harness status did not expose its local dashboard" >&2; exit 65; }

mkdir -p "$RUN_ROOT/bin" "$RUN_ROOT/work-a" "$RUN_ROOT/work-b"
ln -s "$AUTONOMOUS_CODE_ROOT/scripts/fixtures/terminal-e2e-agent.mjs" "$RUN_ROOT/bin/codex"
PRIMARY_PANE="$(tmux new-session -d -P -F '#{pane_id}' -s "$TMUX_PRIMARY" \
  -c "$RUN_ROOT/work-a" -x 92 -y 27 \
  "env TERMINAL_E2E_MARKER=$PRIMARY_MARKER $RUN_ROOT/bin/codex")"
SECONDARY_PANE="$(tmux new-session -d -P -F '#{pane_id}' -s "$TMUX_SECONDARY" \
  -c "$RUN_ROOT/work-b" -x 92 -y 27 \
  "env TERMINAL_E2E_MARKER=$SECONDARY_MARKER $RUN_ROOT/bin/codex")"
[[ "$PRIMARY_PANE" =~ ^%[0-9]+$ && "$SECONDARY_PANE" =~ ^%[0-9]+$ ]] \
  || { echo "Could not create exact disposable tmux panes" >&2; exit 70; }
tmux select-pane -t "$PRIMARY_PANE" -T "prod-e2e-a-$RUN_ID"
tmux select-pane -t "$SECONDARY_PANE" -T "prod-e2e-b-$RUN_ID"

PRIMARY_AGENT_NAME=""
SECONDARY_AGENT_NAME=""
inventory_deadline=$((SECONDS + 60))
while [[ "$SECONDS" -lt "$inventory_deadline" ]]; do
  status_json="$(curl --fail --silent --show-error "$dashboard_url/api/status" 2>/dev/null || true)"
  if [[ -n "$status_json" ]]; then
    PRIMARY_AGENT_NAME="$(printf '%s' "$status_json" | jq -r --arg pane "$PRIMARY_PANE" '.sessions[]? | select(.tmuxPane == $pane) | .name' | head -1)"
    SECONDARY_AGENT_NAME="$(printf '%s' "$status_json" | jq -r --arg pane "$SECONDARY_PANE" '.sessions[]? | select(.tmuxPane == $pane) | .name' | head -1)"
  fi
  [[ -n "$PRIMARY_AGENT_NAME" && -n "$SECONDARY_AGENT_NAME" ]] && break
  sleep 1
done
if [[ -z "$PRIMARY_AGENT_NAME" || -z "$SECONDARY_AGENT_NAME" ]]; then
  echo "Harness did not publish both disposable panes as agents" >&2
  exit 75
fi

cd "$DESKTOP_ROOT"
flutter test integration_test/prod_terminal_e2e_test.dart -d macos \
  --dart-define=PROD_TERMINAL_E2E=true \
  --dart-define=E2E_MACHINE_NAME="$E2E_MACHINE_NAME" \
  --dart-define=E2E_AGENT_NAME="$PRIMARY_AGENT_NAME" \
  --dart-define=E2E_SECOND_AGENT_NAME="$SECONDARY_AGENT_NAME" \
  --dart-define=E2E_AUTONOMOUS_ENV="${E2E_AUTONOMOUS_ENV:-prod}" \
  --dart-define=E2E_TERMINAL_MARKER="$PRIMARY_MARKER" \
  --dart-define=E2E_SECOND_TERMINAL_MARKER="$SECONDARY_MARKER" \
  --dart-define=E2E_TERMINAL_INPUT="${E2E_TERMINAL_INPUT:-terminal-e2e-input-✓}"

for deployment in "$E2E_API_DEPLOYMENT" "$E2E_WORKER_DEPLOYMENT"; do
  if kubectl -n "$E2E_K8S_NAMESPACE" logs "deployment/$deployment" --all-containers=true --since=20m \
  | grep -F -e "$PRIMARY_MARKER" -e "$SECONDARY_MARKER" >/dev/null; then
    echo "PLAINTEXT LEAK: terminal marker appeared in $deployment logs" >&2
    exit 1
  fi
done

printf '%s\n' \
  "release_tag=$E2E_RELEASE_TAG" \
  "release_sha=$E2E_RELEASE_SHA" \
  "desktop_sha=$E2E_DESKTOP_SHA" \
  "harness_sha=$(git -C "$HARNESS_ROOT" rev-parse HEAD)" \
  "harness_version=$harness_version" \
  "machine_name=$E2E_MACHINE_NAME" \
  "primary_pane=${PRIMARY_PANE:0:12}" \
  "secondary_pane=${SECONDARY_PANE:0:12}" \
  'result=pass' >"$RUN_ROOT/evidence.txt"

echo "PASS: prod terminal E2E tag=$E2E_RELEASE_TAG sha=${E2E_RELEASE_SHA:0:12} harness=$harness_version"
