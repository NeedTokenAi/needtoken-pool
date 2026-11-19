#!/usr/bin/env bash
# 把上游一个固定稳定提交用普通 merge commit 合到分支上，并开 PR。
# 不编译、不测试、不执行合并进来的代码。没有生产云凭证。
# 冲突时不推送，避免把冲突标记送上 fork，更不会推到 main。
set -euo pipefail

REPO=${GITHUB_REPOSITORY:?}
UPSTREAM_REPO=${UPSTREAM_REPO:-Wei-Shaw/sub2api}
SYNC_AUTH_MODE=${SYNC_AUTH_MODE:-github_token}
CI_DISPATCH_WORKFLOW=${CI_DISPATCH_WORKFLOW:-}
CI_SUMMARY_TEXT=${CI_SUMMARY_TEXT:-CI（shell / test / frontend / golangci-lint / release-helpers）与 Security Scan（backend-security / frontend-security）}
MAX_AUTO_MERGE_FILES=${UPSTREAM_AUTO_MERGE_MAX_FILES:-300}

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
# shellcheck source=lib/high-risk-paths.sh
source "$script_dir/lib/high-risk-paths.sh"

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
  note "上游目前尚无满足 \`>= ${min_tag}\` 的稳定版 tag，本次跳过。"
  exit 0
fi

tag=$(printf '%s\n' "$resolved" | sed -n 's/^tag=//p')
upstream_sha=$(printf '%s\n' "$resolved" | sed -n 's/^sha=//p')

[[ $channel == stable-tags || $channel == releases ]] || {
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

open_conflict_issue() {
  local files=$1 merge_log=$2
  local existing body
  existing=$(gh issue list --repo "$REPO" --state open --limit 100 --json number,url,title \
    --jq ".[] | select(.title | contains(\"${upstream_sha}\")) | .url" | head -n 1)
  if [[ -n $existing ]]; then
    log "conflict issue already open: ${existing}"
    note ""
    note "合并冲突仍在。已有 issue: ${existing}"
    return 0
  fi
  body=$(mktemp)
  {
    printf '%s\n' "上游同步无法自动合并，需要人工 / Codex 解决冲突。"
    printf '%s\n' ""
    printf '%s\n' "- 我们的 main: \`${our_sha}\`"
    printf '%s\n' "- 上游: \`${UPSTREAM_REPO}\` \`${tag}\` \`${upstream_sha}\`"
    printf '%s\n' "- 通道: \`${channel}\`"
    printf '%s\n' "- 分支（未推送）: \`${branch}\`"
    printf '%s\n' ""
    printf '%s\n' "冲突文件："
    printf '%s\n' ""
    printf '%s\n' '```'
    printf '%s\n' "${files:-（git 没有留下未合并路径；见下面的 merge 输出）}"
    printf '%s\n' '```'
    printf '%s\n' ""
    printf '%s\n' "merge 输出："
    printf '%s\n' ""
    printf '%s\n' '```'
    printf '%s\n' "$merge_log"
    printf '%s\n' '```'
    printf '%s\n' ""
    printf '%s\n' "不要把带冲突标记的分支推到 main，也不要 force-push。请从当前 main 合并该上游提交，解决冲突后另开 PR，并用 merge commit 合并（不要 squash，不要 rebase）。"
  } >"$body"
  gh issue create --repo "$REPO" --title "上游同步冲突：${tag} ${upstream_sha}" --body-file "$body"
  rm -f "$body"
}

ensure_ci() {
  local head=$1
  if [[ $SYNC_AUTH_MODE == pat ]]; then
    log "PR opened with SYNC_GITHUB_TOKEN; pull_request should start ci"
    note ""
    note "使用 SYNC_GITHUB_TOKEN 开了 PR，\`pull_request\` 会自动触发 CI。"
    return 0
  fi
  if [[ -n $CI_DISPATCH_WORKFLOW ]]; then
    gh workflow run "$CI_DISPATCH_WORKFLOW" --ref "$head"
    log "GITHUB_TOKEN cannot trigger pull_request workflows; dispatched ${CI_DISPATCH_WORKFLOW} on ${head}"
    note ""
    note "没有 SYNC_GITHUB_TOKEN。已对 \`${head}\` 执行 \`workflow_dispatch\` 触发 \`${CI_DISPATCH_WORKFLOW}\`。"
    return 0
  fi
  log "GITHUB_TOKEN cannot trigger pull_request workflows and no CI_DISPATCH_WORKFLOW is configured"
  note ""
  note "未配置 \`SYNC_GITHUB_TOKEN\`，默认 \`GITHUB_TOKEN\` 开出的 PR 不会自动触发 \`pull_request\` 工作流。请在仓库 Secrets 配置 \`SYNC_GITHUB_TOKEN\` 后重新运行或手动触发 CI。"
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
    printf '%s\n' "- 预检结果：**高危（需人工审阅）** — 变更文件数 \`${total_count}\` 超过自动合并阈值 \`${MAX_AUTO_MERGE_FILES}\`"
    return 0
  fi
  if [[ $high_count -gt 0 ]]; then
    printf '%s\n' "- 预检结果：**高危（需人工审阅）** — 命中 \`${high_count}\` 个高危路径（总变更 \`${total_count}\` 个文件），CI 通过后也不会自动合并："
    printf '%s\n' ""
    printf '%s\n' '```'
    printf '%s\n' "$high_risk_list" | head -n 30
    if [[ $high_count -gt 30 ]]; then
      printf '...（共 %d 个高危文件）\n' "$high_count"
    fi
    printf '%s\n' '```'
    return 0
  fi
  printf '%s\n' "- 预检结果：**低风险（可自动合并）** — 变更 \`${total_count}\` 个文件，未命中高危路径。待全部必需 CI 通过后，\`auto-merge-upstream\` 将在 \`main\` 上重新校验并以 **Merge Commit** 自动合并（随后触发 Cloudflare Workers Builds）。"
}

create_pr() {
  local head=$1 risk_summary=$2
  local existing body url
  existing=$(gh pr list --repo "$REPO" --base main --head "$head" --state open --json url \
    --jq '.[0].url // empty')
  if [[ -n $existing ]]; then
    log "PR already open: ${existing}"
    note ""
    note "PR: ${existing}"
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

请使用 **Create a merge commit**。不要 Squash，不要 Rebase。Squash 会丢掉这次合并的两个父提交，下一次同步无法判断上游提交是否已经在 main 里。

## 风险门禁与自动构建

${risk_summary}

（注：PR 描述里的预检结果仅供参考，\`auto-merge-upstream\` 会在 CI 全部成功后基于 GitHub API 重新计算全部变更路径与提交结构，fail-closed 判定。）

## CI

同步任务本身不编译、不执行合并进来的代码。请等 ${CI_SUMMARY_TEXT} 在这个 SHA 上通过后再合并。

合入 \`main\` 后将由 Cloudflare Workers Builds 自动构建并发布；涉及数据库迁移、代理巡检或鉴权变更时，请先在隔离环境验证。
EOF
  url=$(gh pr create --repo "$REPO" --base main --head "$head" --title "sync: upstream ${UPSTREAM_REPO} ${tag}" --body-file "$body")
  rm -f "$body"
  log "opened ${url}"
  note ""
  note "PR: ${url}"
  ensure_ci "$head"
}

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  if git merge-base --is-ancestor "$our_sha" "origin/${branch}" \
    && git merge-base --is-ancestor "$upstream_sha" "origin/${branch}"; then
    log "remote ${branch} already contains main and upstream; opening a PR without pushing"
    risk_summary=$(build_risk_preview "$our_sha" "origin/${branch}")
    create_pr "$branch" "$risk_summary"
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
GIT_MERGE_AUTOEDIT=no git merge --no-ff "$upstream_sha" -m "$merge_msg" >"$merge_log" 2>&1
merge_rc=$?
set -e
cat "$merge_log"

if [[ $merge_rc -ne 0 ]]; then
  files=$(git diff --name-only --diff-filter=U || true)
  git merge --abort >/dev/null 2>&1 || git reset --hard origin/main
  git checkout --detach origin/main
  git branch -D "$branch" >/dev/null 2>&1 || true
  open_conflict_issue "$files" "$(cat "$merge_log")"
  rm -f "$merge_log"
  note ""
  note "合并冲突，没有推送分支。需要按 issue 里的文件列表在本地解决。"
  exit 1
fi
rm -f "$merge_log"

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

risk_summary=$(build_risk_preview "$our_sha" HEAD)

git push origin "refs/heads/${branch}:refs/heads/${branch}"
create_pr "$branch" "$risk_summary"
