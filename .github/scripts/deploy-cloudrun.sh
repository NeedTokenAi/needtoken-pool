#!/usr/bin/env bash
# Image-only Cloud Run rollout for NeedToken pool.
# Builds are pinned to a SHA already on main. The new revision is created with
# --no-traffic, smoked, then promoted to 100%. Env, secrets, volumes, and the
# runtime service account are not rewritten.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OPS_PY="${SCRIPT_DIR}/needtoken_ops.py"
export PYTHONPATH="${SCRIPT_DIR}${PYTHONPATH:+:${PYTHONPATH}}"

log() {
  printf '%s\n' "$*"
}

summary() {
  log "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

require_env() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "missing ${name}; see docs/ops/deploy.md" >&2
      exit 1
    fi
  done
}

gcloud_cmd() {
  gcloud --quiet "$@"
}

describe_service() {
  gcloud_cmd run services describe "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --format=json
}

describe_revision() {
  gcloud_cmd run revisions describe "$1" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --format=json
}

remove_candidate_tag() {
  gcloud_cmd run services update-traffic "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --remove-tags=candidate
}

shift_traffic() {
  gcloud_cmd run services update-traffic "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --to-revisions "$1"
}

prepare_names() {
  require_env GIT_SHA GCP_PROJECT_ID GCP_REGION CLOUD_RUN_SERVICE ARTIFACT_REGISTRY_REPOSITORY
  export GIT_SHA GCP_PROJECT_ID GCP_REGION CLOUD_RUN_SERVICE ARTIFACT_REGISTRY_REPOSITORY
  REVISION=$(python3 "$OPS_PY" revision-name)
  IMAGE_REPOSITORY=$(python3 "$OPS_PY" image-repository)
  export REVISION IMAGE_REPOSITORY
}

stale_main() {
  if [[ "${EVENT_NAME}" != "workflow_run" ]]; then
    return 1
  fi
  git fetch --no-tags origin main
  local main_sha
  main_sha=$(git rev-parse origin/main)
  [[ "$main_sha" != "$GIT_SHA" ]]
}

write_output() {
  python3 - "$@" <<'PY'
import os
import sys

pairs = sys.argv[1:]
if len(pairs) % 2:
    raise SystemExit("output keys must be paired")
text = "".join(f"{key}={value}\n" for key, value in zip(pairs[0::2], pairs[1::2]))
destination = os.environ.get("GITHUB_OUTPUT")
if destination:
    with open(destination, "a", encoding="utf-8") as handle:
        handle.write(text)
else:
    sys.stdout.write(text)
PY
}

http_get() {
  local url="$1"
  local outfile="$2"
  local token="${3:-}"
  local -a args=(-sS --max-time 20 -o "$outfile" -w '%{http_code}')
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi
  curl "${args[@]}" "$url"
}

smoke_url() {
  local base="$1"
  base=$(SMOKE_URL="$base" python3 "$OPS_PY" assert-url)
  local path code body origin token attempt curl_status
  local attempts="${SMOKE_ATTEMPTS:-20}"
  local pause="${SMOKE_SLEEP:-3}"
  for path in / /health; do
    body=$(mktemp)
    code="000"
    for attempt in $(seq 1 "$attempts"); do
      set +e
      code=$(http_get "${base}${path}" "$body" "")
      curl_status=$?
      set -e
      if [[ "$curl_status" -ne 0 ]]; then
        code="000"
      fi
      if [[ "$code" == "401" || "$code" == "403" ]]; then
        origin=$(SMOKE_URL="$base" python3 - <<'PY'
import os
from urllib.parse import urlparse
import needtoken_ops

url = needtoken_ops.assert_run_url(os.environ["SMOKE_URL"])
parsed = urlparse(url)
print(f"{parsed.scheme}://{parsed.netloc}")
PY
        )
        token=$(gcloud_cmd auth print-identity-token --audiences="$origin")
        set +e
        code=$(http_get "${base}${path}" "$body" "$token")
        curl_status=$?
        set -e
        if [[ "$curl_status" -ne 0 ]]; then
          code="000"
        fi
      fi
      if [[ "$code" == "200" ]]; then
        if [[ "$path" == "/health" ]] && ! python3 - "$body" <<'PY'
import json
import sys

payload = json.loads(open(sys.argv[1], encoding="utf-8").read())
if payload.get("status") != "ok":
    raise SystemExit("health payload status is not ok")
PY
        then
          rm -f "$body"
          echo "smoke ${base}${path} returned an unexpected payload" >&2
          return 1
        fi
        break
      fi
      if [[ "$attempt" -lt "$attempts" ]]; then
        sleep "$pause"
      fi
    done
    if [[ "$code" != "200" ]]; then
      rm -f "$body"
      echo "smoke ${base}${path} failed with HTTP ${code}" >&2
      return 1
    fi
    summary "smoke ${base}${path} -> 200"
    rm -f "$body"
  done
}

restore_previous() {
  if [[ -z "${PREVIOUS:-}" || "$PREVIOUS" == "$REVISION" ]]; then
    echo "no previous revision is available to receive traffic" >&2
    return 1
  fi
  summary "restore traffic to ${PREVIOUS}"
  shift_traffic "${PREVIOUS}=100"
}

cmd_gate() {
  require_env EVENT_NAME REPOSITORY
  git fetch --no-tags origin main
  MAIN_SHA=$(git rev-parse origin/main)
  export MAIN_SHA
  ON_MAIN=false
  if [[ "$EVENT_NAME" == "workflow_dispatch" && "${INPUT_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    local lowered
    lowered=$(printf '%s' "$INPUT_SHA" | tr '[:upper:]' '[:lower:]')
    if git merge-base --is-ancestor "$lowered" origin/main; then
      ON_MAIN=true
    fi
  fi
  export ON_MAIN
  python3 "$OPS_PY" deploy-gate
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    local deploy sha reason
    deploy=$(awk -F= '/^deploy=/{value=substr($0,8)} END{print value}' "$GITHUB_OUTPUT")
    sha=$(awk -F= '/^sha=/{value=substr($0,5)} END{print value}' "$GITHUB_OUTPUT")
    reason=$(awk -F= '/^reason=/{value=substr($0,8)} END{print value}' "$GITHUB_OUTPUT")
    summary "部署门禁 deploy=${deploy} sha=${sha} reason=${reason}"
  fi
}

cmd_preflight() {
  require_env EVENT_NAME
  prepare_names
  if stale_main; then
    summary "跳过过期提交 ${GIT_SHA}；main 已前进，未创建新修订版"
    write_output action skip reason stale revision "$REVISION" image ""
    return 0
  fi
  local service_json revision_json image percent err
  service_json=$(mktemp)
  revision_json=$(mktemp)
  err=$(mktemp)
  describe_service > "$service_json"
  if describe_revision "$REVISION" > "$revision_json" 2>"$err"; then
    image=$(python3 "$OPS_PY" container-image "$revision_json")
    IMAGE="$image" python3 "$OPS_PY" validate-image
    percent=$(python3 "$OPS_PY" revision-percent "$service_json" "$REVISION")
    if [[ "$percent" == "100" ]]; then
      summary "跳过重复部署 ${REVISION}，该修订版已承接 100% 流量"
      write_output action skip reason duplicate revision "$REVISION" image "$image"
      return 0
    fi
    summary "复用已存在且未承接流量的修订版 ${REVISION}"
    write_output action promote reason existing revision "$REVISION" image "$image"
    return 0
  fi
  if ! grep -Eq 'NOT_FOUND|not found|was not found' "$err"; then
    cat "$err" >&2
    exit 1
  fi
  summary "将构建 ${GIT_SHA} 并创建 ${REVISION}"
  write_output action build reason build revision "$REVISION" image ""
}

update_service_image() {
  # Image, revision suffix, and the candidate tag only.
  # Do not pass --set-env-vars, --set-secrets, --clear-env-vars, --clear-secrets,
  # --to-latest, or a service YAML replace.
  gcloud_cmd run services update "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --image "$IMAGE" \
    --no-traffic \
    --revision-suffix "$GIT_SHA" \
    --tag candidate
}

cmd_rollout() {
  require_env EVENT_NAME ROLLOUT_MODE IMAGE
  prepare_names
  python3 "$OPS_PY" validate-image
  if stale_main; then
    summary "流量切换前发现提交已过期，保留 0% 修订版且不提升流量"
    remove_candidate_tag || true
    return 0
  fi

  local before after percent candidate canonical
  before=$(mktemp)
  after=$(mktemp)
  describe_service > "$before"
  PREVIOUS=$(python3 "$OPS_PY" primary-revision "$before")

  if [[ "$ROLLOUT_MODE" == "build" ]]; then
    update_service_image
    describe_service > "$after"
    if ! python3 "$OPS_PY" compare-runtime "$before" "$after"; then
      remove_candidate_tag || true
      exit 1
    fi
    if [[ "$(python3 "$OPS_PY" container-image "$after")" != "$IMAGE" ]]; then
      echo "Cloud Run revision image does not match the built digest" >&2
      remove_candidate_tag || true
      exit 1
    fi
    percent=$(python3 "$OPS_PY" revision-percent "$after" "$REVISION")
    if [[ "$percent" != "0" ]]; then
      echo "new revision ${REVISION} received ${percent}% traffic before smoke" >&2
      restore_previous || true
      remove_candidate_tag || true
      exit 1
    fi
  elif [[ "$ROLLOUT_MODE" == "promote" ]]; then
    local revision_json live_image
    revision_json=$(mktemp)
    describe_revision "$REVISION" > "$revision_json"
    live_image=$(python3 "$OPS_PY" container-image "$revision_json")
    if [[ "$live_image" != "$IMAGE" ]]; then
      echo "existing revision image does not match the pinned digest" >&2
      exit 1
    fi
    gcloud_cmd run services update-traffic "$CLOUD_RUN_SERVICE" \
      --project "$GCP_PROJECT_ID" \
      --region "$GCP_REGION" \
      --update-tags "candidate=${REVISION}"
    describe_service > "$after"
    percent=$(python3 "$OPS_PY" revision-percent "$after" "$REVISION")
    if [[ "$percent" == "100" ]]; then
      remove_candidate_tag || true
      summary "修订版 ${REVISION} 已承接全部流量"
      return 0
    fi
  else
    echo "unknown ROLLOUT_MODE ${ROLLOUT_MODE}" >&2
    exit 1
  fi

  candidate=$(python3 "$OPS_PY" tagged-url "$after" candidate)
  if ! smoke_url "$candidate"; then
    remove_candidate_tag || true
    exit 1
  fi
  if stale_main; then
    summary "冒烟通过，但 main 已前进，不把 ${REVISION} 提升到 100%"
    remove_candidate_tag || true
    return 0
  fi

  shift_traffic "${REVISION}=100"
  describe_service > "$after"
  percent=$(python3 "$OPS_PY" revision-percent "$after" "$REVISION")
  if [[ "$percent" != "100" ]]; then
    echo "revision ${REVISION} has ${percent}% after promotion" >&2
    restore_previous || true
    exit 1
  fi
  canonical=$(python3 "$OPS_PY" service-url "$after")
  if ! smoke_url "$canonical"; then
    restore_previous || true
    remove_candidate_tag || true
    exit 1
  fi
  if ! remove_candidate_tag; then
    summary "流量已在 ${REVISION}；移除 candidate 标签失败，需要人工清理标签"
  fi
  summary "部署完成 revision=${REVISION} image=${IMAGE} traffic=100 service=${canonical}"
}

usage() {
  echo "usage: deploy-cloudrun.sh gate|preflight|rollout" >&2
  exit 2
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    gate) cmd_gate ;;
    preflight) cmd_preflight ;;
    rollout) cmd_rollout ;;
    *) usage ;;
  esac
fi
