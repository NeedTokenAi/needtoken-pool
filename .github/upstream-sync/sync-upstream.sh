#!/usr/bin/env bash
# 把上游一个固定稳定提交用普通 merge commit 合到分支上，并开 PR（默认仅通知 Ops 与 AI 研判，不自动合并）。
# 不编译、不测试、不执行合并进来的代码。没有生产云凭证。
# 冲突时不推送，也不因仓库禁用 Issues 而中断结构化报告与 Ops Webhook 通知。
set -euo pipefail

REPO=${GITHUB_REPOSITORY:?}
MODULE_NAME=${NEEDTOKEN_MODULE:-pool}
UPSTREAM_REPO=${UPSTREAM_REPO:-Wei-Shaw/sub2api}
SYNC_AUTH_MODE=${SYNC_AUTH_MODE:-github_token}
CI_DISPATCH_WORKFLOW=${CI_DISPATCH_WORKFLOW:-}
CI_SUMMARY_TEXT=${CI_SUMMARY_TEXT:-CI（shell / test / frontend / golangci-lint / release-helpers）、Security Scan 与 ops-impact-check}
MAX_AUTO_MERGE_FILES=${UPSTREAM_AUTO_MERGE_MAX_FILES:-300}
REPORT_PATH=${SYNC_REPORT_PATH:-upstream-sync-report.json}

[[ $UPSTREAM_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "unexpected UPSTREAM_REPO" >&2
  exit 1
}
[[ $SYNC_AUTH_MODE == pat || $SYNC_AUTH_MODE == github_token ]] || {
  echo "unexpected SYNC_AUTH_MODE" >&2
  exit 1
}
[[ $MAX_AUTO_MERGE_FILES =~ ^[0-9]+$ && $MAX_AUTO_MERGE_FILES -gt 0 ]] || {
  echo "unexpected UPSTREAM_AUTO_MERGE_MAX_FILES" >&2
  exit 1
}

cd "$(git rev-parse --show-toplevel)"
upstream_url=${UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO}.git}
script_dir=$(cd "$(dirname "$0")" && pwd)
resolver=${RESOLVE_UPSTREAM:-$script_dir/resolve-upstream.sh}
reviewer=${IMPACT_REVIEWER:-$script_dir/ops-impact-review.mjs}
# shellcheck source=lib/high-risk-paths.sh
source "$script_dir/lib/high-risk-paths.sh"

run_url=""
if [[ -n ${GITHUB_SERVER_URL:-} && -n ${GITHUB_RUN_ID:-} ]]; then
  run_url="${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}"
fi

log() { printf '%s\n' "$*"; }
note() {
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] || return 0
  printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
}

resolved=$("$resolver")
status=$(printf '%s\n' "$resolved" | sed -n 's/^status=//p')
status=${status:-ok}
channel=$(printf '%s\n' "$resolved" | sed -n 's/^channel=//p')
min_tag=$(printf '%s\n' "$resolved" | sed -n 's/^min_tag=//p')

if [[ $status == no_eligible_tag ]]; then
  log "no eligible upstream stable tag for ${UPSTREAM_REPO} >= ${min_tag:-none} via ${channel}"
  note "### 上游同步"
  note ""
  note "- 上游: \`${UPSTREAM_REPO}\`"
  note "- 通道: \`${channel}\`"
  note "- 最低版本底线: \`${min_tag}\`"
  note ""
  note "上游目前尚无满足条件（含跳过名单过滤）的稳定版 tag，本次跳过。"
  exit 0
fi

tag=$(printf '%s\n' "$resolved" | sed -n 's/^tag=//p')
upstream_sha=$(printf '%s\n' "$resolved" | sed -n 's/^sha=//p')

[[ $channel == stable-tags || $channel == releases || $channel == manual-tag ]] || {
  echo "resolver returned unexpected channel" >&2
  exit 1
}
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "resolver returned unexpected tag" >&2
  exit 1
}
[[ $upstream_sha =~ ^[0-9a-f]{40}$ ]] || {
  echo "resolver returned unexpected sha" >&2
  exit 1
}

git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
our_sha=$(git rev-parse origin/main)
[[ $our_sha =~ ^[0-9a-f]{40}$ ]] || {
  echo "origin/main is not a sha" >&2
  exit 1
}

git fetch --no-tags "$upstream_url" "$upstream_sha"
git cat-file -e "${upstream_sha}^{commit}"

note "### 上游同步"
note ""
note "- 通道: \`${channel}\`"
note "- 上游: \`${UPSTREAM_REPO}\` \`${tag}\` \`${upstream_sha}\`"
note "- 我们的 main: \`${our_sha}\`"

if git merge-base --is-ancestor "$upstream_sha" origin/main; then
  log "upstream ${tag} ${upstream_sha} is already contained in main ${our_sha}"
  note ""
  note "该上游提交已经在 main 里，本次不需要开 PR。"
  exit 0
fi

open_sync=$(gh pr list --repo "$REPO" --base main --state open --limit 100 \
  --json number,headRefName,url \
  --jq '.[] | select(.headRefName | startswith("sync/upstream/")) | "\(.number)\t\(.url)\t\(.headRefName)"')
if [[ -n $open_sync ]]; then
  log "an upstream sync PR is already open:"
  printf '%s\n' "$open_sync"
  note ""
  note "已有打开的同步 PR，本次不再开第二个："
  note ""
  note '```'
  note "$open_sync"
  note '```'
  exit 0
fi

branch="sync/upstream/${upstream_sha}"
export GIT_AUTHOR_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL

report_conflict() {
  local files=$1 merge_log_file=$2
  local merge_log
  merge_log=$(cat "$merge_log_file")

  if command -v node >/dev/null 2>&1 && [[ -f $reviewer ]]; then
    node "$reviewer" \
      --mode conflict \
      --module "$MODULE_NAME" \
      --repo "$REPO" \
      --upstream-repo "$UPSTREAM_REPO" \
      --tag "$tag" \
      --base-sha "$our_sha" \
      --head-sha "$upstream_sha" \
      --conflict-files "$files" \
      --merge-log-file "$merge_log_file" \
      --run-url "$run_url" \
      --out-json "$REPORT_PATH" || true
  fi

  note ""
  note "#### 合并冲突文件"
  note ""
  note '```'
  note "${files:-（git 没有留下未合并路径；见日志）}"
  note '```'
  note ""
  note "未推送冲突分支；结构化冲突报告已写入 \`${REPORT_PATH}\`（并尝试通知 Ops 后台）。"

  local existing body
  if existing=$(gh issue list --repo "$REPO" --state open --limit 100 --json number,url,title \
    --jq ".[] | select(.title | contains(\"${upstream_sha}\")) | .url" 2>/dev/null | head -n 1); then
    if [[ -n $existing ]]; then
      log "conflict issue already open: ${existing}"
      note "已有冲突 issue: ${existing}"
      return 0
    fi
    body=$(mktemp)
    {
      printf '%s\n' "上游同步无法自动合并，需要人工 / AI 辅助解决冲突。"
      printf '%s\n' ""
      printf '%s\n' "- 我们的 main: \`${our_sha}\`"
      printf '%s\n' "- 上游: \`${UPSTREAM_REPO}\` \`${tag}\` \`${upstream_sha}\`"
      printf '%s\n' "- 通道: \`${channel}\`"
      printf '%s\n' "- 分支（未推送）: \`${branch}\`"
      printf '%s\n' ""
      printf '%s\n' "冲突文件："
      printf '%s\n' '```'
      printf '%s\n' "${files:-（无）}"
      printf '%s\n' '```'
      printf '%s\n' ""
      printf '%s\n' "merge 输出："
      printf '%s\n' '```'
      printf '%s\n' "$merge_log"
      printf '%s\n' '```'
      printf '%s\n' ""
      printf '%s\n' "请从最新 main 执行 \`git merge --no-ff ${upstream_sha}\` 解决冲突后提 PR，并以 **Create a merge commit** 合并。"
    } >"$body"
    gh issue create --repo "$REPO" --title "上游同步冲突：${tag} ${upstream_sha}" --body-file "$body" >/dev/null 2>&1 || true
    rm -f "$body"
  else
    log "GitHub Issues unavailable or disabled for ${REPO}; conflict report written to ${REPORT_PATH}"
  fi
}

ensure_ci() {
  local head=$1
  if [[ $SYNC_AUTH_MODE == pat ]]; then
    log "PR opened with SYNC_GITHUB_TOKEN; pull_request should start ci"
    note ""
    note "使用 SYNC_GITHUB_TOKEN 开了 PR，\`pull_request\` 会自动触发 CI 与 Ops 影响/AI 研判。"
    return 0
  fi
  if [[ -n $CI_DISPATCH_WORKFLOW ]]; then
    gh workflow run "$CI_DISPATCH_WORKFLOW" --ref "$head" || true
    log "GITHUB_TOKEN cannot trigger pull_request workflows; dispatched ${CI_DISPATCH_WORKFLOW} on ${head}"
    note ""
    note "没有 SYNC_GITHUB_TOKEN。已对 \`${head}\` 执行 \`workflow_dispatch\` 触发 \`${CI_DISPATCH_WORKFLOW}\`。"
    return 0
  fi
  log "GITHUB_TOKEN cannot trigger pull_request workflows and no CI_DISPATCH_WORKFLOW is configured"
  note ""
  note "未配置 \`SYNC_GITHUB_TOKEN\`，默认 \`GITHUB_TOKEN\` 开出的 PR 不会自动触发 \`pull_request\` 工作流。请在仓库 Secrets 配置 \`SYNC_GITHUB_TOKEN\`。"
}

build_risk_preview() {
  local base_ref=$1 head_ref=$2
  local changed_file_list high_risk_list total_count high_count
  changed_file_list=$(git diff --name-only "$base_ref" "$head_ref")
  total_count=$(printf '%s\n' "$changed_file_list" | awk 'NF{c++} END{print c+0}')
  high_risk_list=$(printf '%s\n' "$changed_file_list" | filter_high_risk_paths || true)
  high_count=$(printf '%s\n' "$high_risk_list" | awk 'NF{c++} END{print c+0}')

  if [[ $total_count -eq 0 ]]; then
    printf '%s\n' "- 预检结果：**需人工审阅**（未检测到文件差异，fail-closed）"
    return 0
  fi
  if [[ $total_count -gt $MAX_AUTO_MERGE_FILES ]]; then
    printf '%s\n' "- 预检结果：**高危（需人工审阅）** — 变更文件数 \`${total_count}\` 超过阈值 \`${MAX_AUTO_MERGE_FILES}\`"
    return 0
  fi
  if [[ $high_count -gt 0 ]]; then
    printf '%s\n' "- 预检结果：**高危（需人工审阅）** — 命中 \`${high_count}\` 个高危/二开保护路径（总变更 \`${total_count}\` 个文件）："
    printf '%s\n' ""
    printf '%s\n' '```'
    printf '%s\n' "$high_risk_list" | head -n 30
    if [[ $high_count -gt 30 ]]; then
      printf '...（共 %d 个高危文件）\n' "$high_count"
    fi
    printf '%s\n' '```'
    return 0
  fi
  printf '%s\n' "- 预检结果：**常规变更** — 变更 \`${total_count}\` 个文件，未命中高危路径。请等待 CI 与 AI 风险研判完成后在 Ops 控制台审批 **Merge Commit**。"
}

notify_pr_opened() {
  local pr_url=$1 pr_number=$2 head_sha=$3
  if command -v node >/dev/null 2>&1 && [[ -f $reviewer ]]; then
    node "$reviewer" \
      --mode opened \
      --module "$MODULE_NAME" \
      --repo "$REPO" \
      --upstream-repo "$UPSTREAM_REPO" \
      --tag "$tag" \
      --base-sha "$our_sha" \
      --head-sha "$head_sha" \
      --pr-number "$pr_number" \
      --pr-url "$pr_url" \
      --run-url "$run_url" \
      --out-json "$REPORT_PATH" || true
  fi
}

create_pr() {
  local head=$1 risk_summary=$2 head_sha=$3
  local existing body url pr_num
  existing=$(gh pr list --repo "$REPO" --base main --head "$head" --state open --json url,number \
    --jq '.[0] | select(.) | "\(.number)\t\(.url)"')
  if [[ -n $existing ]]; then
    pr_num=$(printf '%s' "$existing" | cut -f1)
    url=$(printf '%s' "$existing" | cut -f2)
    log "PR already open: ${url}"
    note ""
    note "PR: ${url}"
    notify_pr_opened "$url" "$pr_num" "$head_sha"
    ensure_ci "$head"
    return 0
  fi
  body=$(mktemp)
  cat >"$body" <<EOF
把上游 \`${UPSTREAM_REPO}\` 的 \`${tag}\`（\`${upstream_sha}\`）用普通 merge commit 合入 main。

- 通道: \`${channel}\`（不是 \`/releases/latest\`）
- 开分支时的 main: \`${our_sha}\`
- 头分支: \`${head}\`

## 合并方式

请使用 **Create a merge commit**（推荐在 NeedToken Ops「版本与发布治理」中核对 AI 研判后一键审批合并，并自动记录 Cloudflare 黄金还原点）。**严禁 Squash 或 Rebase**。

## 风险预检

${risk_summary}

## CI 与 AI 风险研判

请等待 ${CI_SUMMARY_TEXT} 在这个 SHA 上通过并输出中文研判报告后再审批合入 \`main\`。
EOF
  url=$(gh pr create --repo "$REPO" --base main --head "$head" --title "sync: upstream ${UPSTREAM_REPO} ${tag}" --body-file "$body")
  rm -f "$body"
  pr_num=${url##*/}
  log "opened ${url}"
  note ""
  note "PR: ${url}"
  notify_pr_opened "$url" "$pr_num" "$head_sha"
  ensure_ci "$head"
}

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  if git merge-base --is-ancestor "$our_sha" "origin/${branch}" \
    && git merge-base --is-ancestor "$upstream_sha" "origin/${branch}"; then
    log "remote ${branch} already contains main and upstream; opening a PR without pushing"
    head_sha=$(git rev-parse "origin/${branch}")
    risk_summary=$(build_risk_preview "$our_sha" "origin/${branch}")
    create_pr "$branch" "$risk_summary" "$head_sha"
    exit 0
  fi
  echo "remote ${branch} exists but is not a merge of current main and ${upstream_sha}; refusing to force-push" >&2
  note ""
  note "远程分支 \`${branch}\` 已存在，且不是当前 main 与该上游提交的合并。没有 force-push。请人工删掉废弃分支后再跑。"
  exit 1
fi

git checkout --no-track -B "$branch" origin/main
merge_msg="merge: upstream ${UPSTREAM_REPO} ${tag} (${upstream_sha})"
merge_log=$(mktemp)
set +e
GIT_MERGE_AUTOEDIT=no git merge --no-ff --no-commit "$upstream_sha" >"$merge_log" 2>&1
merge_rc=$?
set -e
cat "$merge_log"

if [[ $merge_rc -ne 0 ]]; then
  files=$(git diff --name-only --diff-filter=U || true)
  git merge --abort >/dev/null 2>&1 || git reset --hard origin/main
  git checkout --detach origin/main
  git branch -D "$branch" >/dev/null 2>&1 || true
  report_conflict "$files" "$merge_log"
  rm -f "$merge_log"
  exit 1
fi
rm -f "$merge_log"

# 上游发布流水线打完 tag 后才回写 VERSION，容器构建排除 .git 后只能读取该文件，
# 因此在合并提交中将 VERSION 显式对齐到当前同步的目标版本号。
target_version=${tag#v}
version_file="backend/cmd/server/VERSION"
if [[ -f $version_file ]]; then
  current_version=$(tr -d '\r\n' <"$version_file")
  if [[ $current_version != "$target_version" ]]; then
    printf '%s\n' "$target_version" >"$version_file"
    git add "$version_file"
  fi
fi

GIT_MERGE_AUTOEDIT=no git commit --no-edit -m "$merge_msg"

git diff --quiet
git diff --cached --quiet
[[ $(git rev-parse 'HEAD^1') == "$our_sha" ]] || {
  echo "merge commit first parent is not our main" >&2
  exit 1
}
[[ $(git rev-parse 'HEAD^2') == "$upstream_sha" ]] || {
  echo "merge commit second parent is not the upstream sha" >&2
  exit 1
}
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
if [[ $(git rev-parse origin/main) != "$our_sha" ]]; then
  log "origin/main moved during sync; not pushing ${branch}"
  note ""
  note "同步过程中 main 又更新了，没有推送。下次调度会重试。"
  exit 0
fi

head_sha=$(git rev-parse HEAD)
risk_summary=$(build_risk_preview "$our_sha" HEAD)

git push origin "refs/heads/${branch}:refs/heads/${branch}"
create_pr "$branch" "$risk_summary" "$head_sha"
