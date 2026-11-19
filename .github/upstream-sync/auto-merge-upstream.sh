#!/usr/bin/env bash
# 上游同步 PR 的非高危路径自动合并门禁（仅在受信任的 main 分支工作流中运行）。
# 不 checkout 也不执行 PR 分支代码；所有校验基于 GitHub API 与不可变 HEAD_SHA 完成。
set -euo pipefail

REPO=${GITHUB_REPOSITORY:?}
HEAD_BRANCH=${HEAD_BRANCH:?}
HEAD_SHA=${HEAD_SHA:-}
REQUIRED_CHECKS=${REQUIRED_CHECKS:?}
CONDITIONAL_CHECKS=${CONDITIONAL_CHECKS:-}
UPSTREAM_AUTO_MERGE=${UPSTREAM_AUTO_MERGE:-true}
MAX_AUTO_MERGE_FILES=${UPSTREAM_AUTO_MERGE_MAX_FILES:-300}
IGNORE_CHECK_NAME=${IGNORE_CHECK_NAME:-Auto-merge upstream sync PR}

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/high-risk-paths.sh
source "$script_dir/lib/high-risk-paths.sh"

log() { printf '%s\n' "$*"; }
note() {
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] || return 0
  printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
}

case "${UPSTREAM_AUTO_MERGE,,}" in
  false | 0 | no | off)
    log "UPSTREAM_AUTO_MERGE=${UPSTREAM_AUTO_MERGE}; auto-merge disabled"
    note "已通过 \`UPSTREAM_AUTO_MERGE=${UPSTREAM_AUTO_MERGE}\` 关闭上游同步自动合并。"
    exit 0
    ;;
  true | 1 | yes | on | "") ;;
  *)
    echo "unexpected UPSTREAM_AUTO_MERGE=${UPSTREAM_AUTO_MERGE}" >&2
    exit 1
    ;;
esac

[[ $MAX_AUTO_MERGE_FILES =~ ^[0-9]+$ && $MAX_AUTO_MERGE_FILES -gt 0 ]] || {
  echo "unexpected UPSTREAM_AUTO_MERGE_MAX_FILES=${MAX_AUTO_MERGE_FILES}" >&2
  exit 1
}

if ! [[ $HEAD_BRANCH =~ ^sync/upstream/([0-9a-f]{40})$ ]]; then
  log "branch ${HEAD_BRANCH} is not a sync/upstream/<40-sha> branch; skipping"
  exit 0
fi
expected_upstream_sha=${BASH_REMATCH[1]}

pr_json=$(gh pr list --repo "$REPO" --base main --head "$HEAD_BRANCH" --state open --limit 5 \
  --json number,url,headRefOid,baseRefName,isDraft)
pr_count=$(jq 'length' <<<"$pr_json")
if [[ $pr_count -eq 0 ]]; then
  log "no open PR targeting main for ${HEAD_BRANCH}; skipping"
  exit 0
fi
if [[ $pr_count -ne 1 ]]; then
  echo "expected 1 open PR for ${HEAD_BRANCH}, found ${pr_count}" >&2
  exit 1
fi

pr_number=$(jq -r '.[0].number' <<<"$pr_json")
pr_url=$(jq -r '.[0].url' <<<"$pr_json")
pr_head_sha=$(jq -r '.[0].headRefOid' <<<"$pr_json")
pr_base=$(jq -r '.[0].baseRefName' <<<"$pr_json")
pr_is_draft=$(jq -r '.[0].isDraft' <<<"$pr_json")

[[ $pr_base == main ]] || {
  log "PR #${pr_number} base is ${pr_base}, not main; skipping"
  exit 0
}
if [[ $pr_is_draft == true ]]; then
  log "PR #${pr_number} is draft; skipping"
  exit 0
fi

if [[ -z $HEAD_SHA ]]; then
  HEAD_SHA=$pr_head_sha
fi
[[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || {
  echo "invalid HEAD_SHA=${HEAD_SHA}" >&2
  exit 1
}
if [[ $pr_head_sha != "$HEAD_SHA" ]]; then
  log "PR #${pr_number} head moved (${pr_head_sha} != ${HEAD_SHA}); waiting for checks on latest SHA"
  exit 0
fi

note "### 上游同步自动合并门禁"
note ""
note "- PR: ${pr_url} (\`#${pr_number}\`)"
note "- 分支: \`${HEAD_BRANCH}\`"
note "- SHA: \`${HEAD_SHA}\`"

parents_json=$(gh api "repos/${REPO}/commits/${HEAD_SHA}" --jq '[.parents[].sha]')
parent_count=$(jq 'length' <<<"$parents_json")
if [[ $parent_count -ne 2 ]]; then
  log "refusing auto-merge: commit ${HEAD_SHA} has ${parent_count} parent(s), expected 2 (merge commit)"
  note "- 结果：**拒绝**（头提交不是双父 merge commit，实际父提交数：\`${parent_count}\`）"
  exit 0
fi
parent0=$(jq -r '.[0]' <<<"$parents_json")
parent1=$(jq -r '.[1]' <<<"$parents_json")
if [[ $parent1 != "$expected_upstream_sha" ]]; then
  log "refusing auto-merge: second parent ${parent1} != branch upstream sha ${expected_upstream_sha}"
  note "- 结果：**拒绝**（第二父提交与分支上游 SHA 不一致）"
  exit 0
fi
base_compare=$(gh api "repos/${REPO}/compare/${parent0}...main" --jq '.status')
if [[ $base_compare != identical && $base_compare != ahead ]]; then
  log "refusing auto-merge: first parent ${parent0} is not an ancestor of main (status=${base_compare})"
  note "- 结果：**拒绝**（第一父提交不在 main 祖先链上，status=\`${base_compare}\`）"
  exit 0
fi

pr_changed_files=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.changed_files')
[[ $pr_changed_files =~ ^[0-9]+$ ]] || {
  echo "unexpected changed_files=${pr_changed_files}" >&2
  exit 1
}
files_tmp=$(mktemp)
trap 'rm -f "$files_tmp"' EXIT
gh api --paginate "repos/${REPO}/pulls/${pr_number}/files" --jq '.[].filename' >"$files_tmp"
fetched_count=$(awk 'NF{c++} END{print c+0}' "$files_tmp")

expected_checks=()
while IFS= read -r chk; do
  [[ -n $chk ]] || continue
  expected_checks+=("$chk")
done <<<"$REQUIRED_CHECKS"

if [[ -n $CONDITIONAL_CHECKS ]]; then
  while IFS='|' read -r pattern cond_chk; do
    [[ -n $pattern && -n $cond_chk ]] || continue
    matched=0
    while IFS= read -r f; do
      [[ -n $f ]] || continue
      if [[ $pattern == */ ]]; then
        if [[ $f == "$pattern"* ]]; then
          matched=1
          break
        fi
      else
        if [[ $f == "$pattern" ]]; then
          matched=1
          break
        fi
      fi
    done <"$files_tmp"
    if [[ $matched -eq 1 ]]; then
      already=0
      for existing_chk in "${expected_checks[@]}"; do
        if [[ $existing_chk == "$cond_chk" ]]; then
          already=1
          break
        fi
      done
      if [[ $already -eq 0 ]]; then
        expected_checks+=("$cond_chk")
      fi
    fi
  done <<<"$CONDITIONAL_CHECKS"
fi

check_runs_json=$(gh api --paginate "repos/${REPO}/commits/${HEAD_SHA}/check-runs" --jq '.check_runs[]' | jq -s '
  group_by(.name)
  | map(max_by(.id))
')

in_progress=$(jq -r --arg ignore "$IGNORE_CHECK_NAME" '
  .[] | select(.name != $ignore and .status != "completed") | "\(.name) (\(.status))"
' <<<"$check_runs_json")
if [[ -n $in_progress ]]; then
  log "CI checks still running on ${HEAD_SHA}; waiting:"
  printf '%s\n' "$in_progress"
  note "- 结果：**等待中**（仍有 CI 检查未完成）"
  exit 0
fi

failed_checks=$(jq -r --arg ignore "$IGNORE_CHECK_NAME" '
  .[] | select(.name != $ignore and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral"))
  | "\(.name) (\(.conclusion // "null"))"
' <<<"$check_runs_json")
if [[ -n $failed_checks ]]; then
  log "CI checks failed on ${HEAD_SHA}; refusing auto-merge:"
  printf '%s\n' "$failed_checks"
  note "- 结果：**拒绝**（存在未通过的 CI 检查）"
  exit 0
fi

missing_or_unpassed=()
for req in "${expected_checks[@]}"; do
  concl=$(jq -r --arg name "$req" '.[] | select(.name == $name) | .conclusion // empty' <<<"$check_runs_json")
  if [[ $concl != success ]]; then
    missing_or_unpassed+=("${req} (${concl:-missing})")
  fi
done
if [[ ${#missing_or_unpassed[@]} -gt 0 ]]; then
  log "required CI checks not all passed on ${HEAD_SHA}; waiting/refusing:"
  printf '  - %s\n' "${missing_or_unpassed[@]}"
  note "- 结果：**等待中 / 未满足必需检查**"
  exit 0
fi

status_json=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/status")
status_count=$(jq -r '.total_count // 0' <<<"$status_json")
status_state=$(jq -r '.state // "pending"' <<<"$status_json")
if [[ $status_count -gt 0 && $status_state != success ]]; then
  log "legacy commit status is ${status_state} (count=${status_count}); not merging"
  note "- 结果：**等待/拒绝**（commit status=\`${status_state}\`）"
  exit 0
fi

post_risk_comment() {
  local reason=$1 matched_files=$2
  local marker='<!-- needtoken-upstream-risk-gate -->'
  local existing_comment_id comment_body
  existing_comment_id=$(gh api --paginate "repos/${REPO}/issues/${pr_number}/comments" --jq '.[]' \
    | jq -s -r --arg m "$marker" '.[] | select(.body | contains($m)) | .id' | tail -n 1)

  comment_body=$(mktemp)
  {
    printf '%s\n' "$marker"
    printf '%s\n' "### 上游同步风险门禁：需人工审阅（未自动合并）"
    printf '%s\n' ""
    printf '%s\n' "- SHA: \`${HEAD_SHA}\`"
    printf '%s\n' "- 拦截原因: ${reason}"
    if [[ -n $matched_files ]]; then
      local total_matched
      total_matched=$(printf '%s\n' "$matched_files" | awk 'NF{c++} END{print c+0}')
      printf '%s\n' "- 命中高危路径（共 \`${total_matched}\` 个）："
      printf '%s\n' ""
      printf '%s\n' '```'
      printf '%s\n' "$matched_files" | head -n 50
      if [[ $total_matched -gt 50 ]]; then
        printf '...（其余 %d 个省略）\n' "$((total_matched - 50))"
      fi
      printf '%s\n' '```'
    fi
    printf '%s\n' ""
    printf '%s\n' "请人工确认变更后使用 **Create a merge commit** 合并（**严禁 Squash / Rebase**）。合并进 \`main\` 后将由 Cloudflare Workers Builds 自动构建发布。"
  } >"$comment_body"

  if [[ -n $existing_comment_id ]]; then
    gh api -X PATCH "repos/${REPO}/issues/comments/${existing_comment_id}" -F "body=@${comment_body}" >/dev/null
  else
    gh api -X POST "repos/${REPO}/issues/${pr_number}/comments" -F "body=@${comment_body}" >/dev/null
  fi
  rm -f "$comment_body"
}

if [[ $pr_changed_files -eq 0 ]]; then
  log "refusing auto-merge: PR reports 0 changed files (fail-closed)"
  post_risk_comment "PR 报告变更文件数为 0（fail-closed）" ""
  note "- 结果：**拦截**（变更文件数为 0）"
  exit 0
fi

if [[ $fetched_count -ne $pr_changed_files ]]; then
  log "refusing auto-merge: fetched ${fetched_count} files != PR changed_files ${pr_changed_files} (possible API truncation)"
  post_risk_comment "PR 文件列表数量不一致（拉取 ${fetched_count} vs 报告 ${pr_changed_files}，疑似超过 GitHub API 返回上限，fail-closed）" ""
  note "- 结果：**拦截**（文件列表被截断）"
  exit 0
fi

if [[ $pr_changed_files -gt $MAX_AUTO_MERGE_FILES ]]; then
  log "refusing auto-merge: changed_files ${pr_changed_files} > max ${MAX_AUTO_MERGE_FILES}"
  post_risk_comment "变更文件数 \`${pr_changed_files}\` 超过自动合并阈值 \`${MAX_AUTO_MERGE_FILES}\`" ""
  note "- 结果：**拦截**（变更文件数 ${pr_changed_files} 超过阈值 ${MAX_AUTO_MERGE_FILES}）"
  exit 0
fi

high_risk_hits=$(filter_high_risk_paths <"$files_tmp" || true)
if [[ -n $high_risk_hits ]]; then
  log "refusing auto-merge: high-risk paths touched"
  printf '%s\n' "$high_risk_hits"
  post_risk_comment "命中高危路径规则，禁止自动合并" "$high_risk_hits"
  note "- 结果：**拦截**（命中高危路径，已在 PR 评论列出清单）"
  exit 0
fi

log "all checks passed and zero high-risk paths touched (${pr_changed_files} files); merging PR #${pr_number} via merge commit"
gh api -X PUT "repos/${REPO}/pulls/${pr_number}/merge" \
  -f merge_method=merge \
  -f sha="$HEAD_SHA" >/dev/null

gh api -X DELETE "repos/${REPO}/git/refs/heads/${HEAD_BRANCH}" >/dev/null 2>&1 || true

note "- 结果：**已自动合并（Merge Commit）** — 变更 \`${pr_changed_files}\` 个低风险文件，全部 CI 已通过，将触发 Cloudflare Workers Builds。"
