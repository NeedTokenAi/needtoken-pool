#!/usr/bin/env bash
# 校验 needtoken-pool 上游同步脚本、稳定版选择、高危路径判定与自动合并门禁。
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/stable-tag.sh
source "$root/lib/stable-tag.sh"
# shellcheck source=lib/high-risk-paths.sh
source "$root/lib/high-risk-paths.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# 1. stable-tag + min_tag 校验
got=$(printf '%s\n' v0.2.19 v0.2.20 v0.2.23 v0.2.24-rc.1 | select_stable_tag v0.2.20)
[[ $got == v0.2.23 ]] || fail "expected v0.2.23, got $got"

if printf '%s\n' v0.2.19 v0.2.20-rc.1 | select_stable_tag v0.2.20 | grep -q .; then
  fail "tags below min_tag must not be selected"
fi

# 2. 高危路径分类器
for p in \
  ".github/workflows/backend-ci.yml" \
  ".agents/rules/needtoken-fork.md" \
  "cloudflare/wrangler.jsonc" \
  "deploy/docker-compose.yml" \
  "Dockerfile" \
  "backend/migrations/234_add_column.sql" \
  "backend/ent/schema/account.go" \
  "backend/internal/middleware/auth.go" \
  "backend/internal/config/config.go" \
  "backend/internal/service/proxy_probe.go" \
  "backend/internal/service/subscription_service.go" \
  "backend/internal/handler/auth_handler.go" \
  "backend/internal/server/routes/admin.go" \
  "backend/internal/service/openai_responses_orphan_precheck_test.go" \
  "backend/cmd/server/VERSION"; do
  is_high_risk_path "$p" || fail "expected high-risk: $p"
done

for p in \
  "README.md" \
  "frontend/src/views/DashboardView.vue" \
  "backend/internal/pkg/i18n/messages.go"; do
  if is_high_risk_path "$p"; then
    fail "expected low-risk: $p"
  fi
done

# 3. auto-merge-upstream 端到端 mock（含 CLA Assistant skipped 非阻塞 + 全部必需 CI 通过）
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

UPSTREAM_SHA="dddddddddddddddddddddddddddddddddddddddd"
BASE_SHA="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
HEAD_SHA="ffffffffffffffffffffffffffffffffffffffff"
HEAD_BRANCH="sync/upstream/${UPSTREAM_SHA}"

cat >"$tmp/gh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${MOCK_LOG:?}"
cmd=${1:-}
shift || true
if [[ $cmd == pr && ${1:-} == list ]]; then
  cat "${MOCK_PR_LIST:?}"
  exit 0
fi
if [[ $cmd == api ]]; then
  method="GET"
  jqfilter=""
  endpoint=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      -X) method=$2; shift 2 ;;
      --jq) jqfilter=$2; shift 2 ;;
      --paginate) shift ;;
      -f | -F) shift 2 ;;
      *) [[ -z $endpoint ]] && endpoint=$1; shift ;;
    esac
  done
  case "${method}:${endpoint}" in
    GET:repos/*/commits/*/check-runs) out=$(cat "${MOCK_CHECK_RUNS:?}") ;;
    GET:repos/*/commits/*/status) out='{"total_count":0,"state":"pending"}' ;;
    GET:repos/*/commits/*) out=$(cat "${MOCK_COMMIT:?}") ;;
    GET:repos/*/compare/*) out='{"status":"identical"}' ;;
    GET:repos/*/pulls/*/files) out=$(cat "${MOCK_FILES:?}") ;;
    GET:repos/*/pulls/*) out=$(cat "${MOCK_PR_DETAIL:?}") ;;
    GET:repos/*/issues/*/comments) out='[]' ;;
    POST:repos/*/issues/*/comments) printf '{"id":1}\n'; exit 0 ;;
    PUT:repos/*/pulls/*/merge) printf '{"merged":true}\n'; exit 0 ;;
    DELETE:repos/*/git/refs/heads/*) exit 0 ;;
    *) echo "unexpected api: ${method} ${endpoint}" >&2; exit 1 ;;
  esac
  if [[ -n $jqfilter ]]; then jq -r "$jqfilter" <<<"$out"; else printf '%s\n' "$out"; fi
  exit 0
fi
exit 1
EOS
chmod +x "$tmp/gh"

cat >"$tmp/pr_list.json" <<EOF
[{"number":20,"url":"https://example.test/pr/20","headRefOid":"${HEAD_SHA}","baseRefName":"main","isDraft":false}]
EOF
cat >"$tmp/commit.json" <<EOF
{"parents":[{"sha":"${BASE_SHA}"},{"sha":"${UPSTREAM_SHA}"}]}
EOF
printf '{"changed_files":1}\n' >"$tmp/pr_detail.json"
printf '[{"filename":"frontend/src/views/DashboardView.vue"}]\n' >"$tmp/files.json"
cat >"$tmp/check_runs.json" <<'EOF'
{"check_runs":[
  {"id":1,"name":"shell","status":"completed","conclusion":"success"},
  {"id":2,"name":"test","status":"completed","conclusion":"success"},
  {"id":3,"name":"frontend","status":"completed","conclusion":"success"},
  {"id":4,"name":"golangci-lint","status":"completed","conclusion":"success"},
  {"id":5,"name":"release-helpers","status":"completed","conclusion":"success"},
  {"id":6,"name":"backend-security","status":"completed","conclusion":"success"},
  {"id":7,"name":"frontend-security","status":"completed","conclusion":"success"},
  {"id":8,"name":"cla-check","status":"completed","conclusion":"skipped"}
]}
EOF

: >"$tmp/gh.log"
env PATH="$tmp:$PATH" \
  GITHUB_REPOSITORY=NeedTokenAi/needtoken-pool \
  HEAD_BRANCH="$HEAD_BRANCH" HEAD_SHA="$HEAD_SHA" \
  REQUIRED_CHECKS=$'shell\ntest\nfrontend\ngolangci-lint\nrelease-helpers\nbackend-security\nfrontend-security' \
  MOCK_LOG="$tmp/gh.log" MOCK_PR_LIST="$tmp/pr_list.json" MOCK_COMMIT="$tmp/commit.json" \
  MOCK_PR_DETAIL="$tmp/pr_detail.json" MOCK_FILES="$tmp/files.json" MOCK_CHECK_RUNS="$tmp/check_runs.json" \
  bash "$root/auto-merge-upstream.sh" >/dev/null

grep -q "PUT repos/NeedTokenAi/needtoken-pool/pulls/20/merge -f merge_method=merge -f sha=${HEAD_SHA}" "$tmp/gh.log" \
  || fail "expected merge commit API call when all checks pass and cla-check is skipped"

# 命中迁移路径 -> 拦截自动合并
printf '[{"filename":"backend/migrations/235_alter.sql"}]\n' >"$tmp/files.json"
: >"$tmp/gh.log"
env PATH="$tmp:$PATH" \
  GITHUB_REPOSITORY=NeedTokenAi/needtoken-pool \
  HEAD_BRANCH="$HEAD_BRANCH" HEAD_SHA="$HEAD_SHA" \
  REQUIRED_CHECKS=$'shell\ntest\nfrontend\ngolangci-lint\nrelease-helpers\nbackend-security\nfrontend-security' \
  MOCK_LOG="$tmp/gh.log" MOCK_PR_LIST="$tmp/pr_list.json" MOCK_COMMIT="$tmp/commit.json" \
  MOCK_PR_DETAIL="$tmp/pr_detail.json" MOCK_FILES="$tmp/files.json" MOCK_CHECK_RUNS="$tmp/check_runs.json" \
  bash "$root/auto-merge-upstream.sh" >/dev/null
if grep -q "pulls/20/merge" "$tmp/gh.log"; then
  fail "migration file must block auto-merge"
fi

echo "needtoken-pool upstream-sync ok"
