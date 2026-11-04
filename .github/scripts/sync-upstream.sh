#!/usr/bin/env bash
# Pin one upstream ref to a SHA and open a single ordinary merge PR.
# This workflow has no GCP credentials. Conflict markers are never pushed.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OPS_PY="${SCRIPT_DIR}/needtoken_ops.py"
UPSTREAM_REPO="${UPSTREAM_REPO:-Wei-Shaw/sub2api}"
ORIGIN_REPO="${ORIGIN_REPO:-NeedTokenAi/needtoken-pool}"

log() {
  printf '%s\n' "$*"
}

summary() {
  log "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

configure_git_identity() {
  git config user.name "needtoken-sync[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
}

merge_or_conflict() {
  local pinned="$1"
  local conflict_file="$2"
  if git merge --no-ff --no-commit "$pinned"; then
    if [[ ! -f .git/MERGE_HEAD ]]; then
      return 20
    fi
    if git grep -E '^<<<<<<< ' -- . >/dev/null 2>&1; then
      git merge --abort
      echo "conflict markers" > "$conflict_file"
      return 2
    fi
    return 0
  fi
  if [[ -f .git/MERGE_HEAD ]]; then
    git diff --name-only --diff-filter=U > "$conflict_file" || true
    git merge --abort
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "worktree not clean after merge abort" >&2
      return 2
    fi
    if git grep -E '^<<<<<<< ' -- . >/dev/null 2>&1; then
      echo "conflict markers remain after abort" >&2
      return 2
    fi
    return 1
  fi
  return 2
}

push_sync_branch() {
  local sha="$1"
  local ref
  ref=$(GIT_SHA="$sha" PUSH_REF="refs/heads/sync/upstream/${sha}" python3 "$OPS_PY" assert-refspec)
  if [[ -z "${SYNC_GITHUB_TOKEN:-}" ]]; then
    echo "SYNC_GITHUB_TOKEN is required so the sync push retriggers CI" >&2
    return 3
  fi
  local remote="${ORIGIN_PUSH_URL:-https://github.com/${ORIGIN_REPO}.git}"
  # Push this one branch refspec. Never push tags or --all.
  git -c "http.extraheader=AUTHORIZATION: bearer ${SYNC_GITHUB_TOKEN}" \
    push "$remote" "HEAD:${ref}"
}

integrate_upstream() {
  local sha="$1"
  local pinned="$2"
  local conflict_file="$3"
  configure_git_identity
  local rc=0
  # Called from `||`, where set -e is disabled. Check every status explicitly.
  # 1 = conflicts, 2 = markers or a dirty abort, 3 = push/commit failure.
  merge_or_conflict "$pinned" "$conflict_file" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    return "$rc"
  fi
  if ! git commit \
    -m "Merge upstream ${UPSTREAM_REPO}@${sha}" \
    -m "Ordinary merge of pinned upstream SHA ${sha}."; then
    git merge --abort || true
    return 3
  fi
  if ! push_sync_branch "$sha"; then
    return 3
  fi
}

json_get() {
  local expression="$1"
  python3 -c 'import json,sys; value=json.load(sys.stdin); print(value'"$expression"')'
}

enable_automerge() {
  local number="$1"
  if [[ -z "${SYNC_GITHUB_TOKEN:-}" ]]; then
    echo "SYNC_GITHUB_TOKEN is required to merge with a merge commit" >&2
    return 1
  fi
  if [[ "${UPSTREAM_AUTO_MERGE:-true}" != "true" ]]; then
    summary "PR #${number} 已打开。UPSTREAM_AUTO_MERGE 不是 true，请用 merge commit 合并。"
    return 0
  fi
  if ! GH_TOKEN="$SYNC_GITHUB_TOKEN" gh pr merge "$number" --repo "$ORIGIN_REPO" --merge --auto; then
    echo "could not enable merge-commit auto-merge for PR #${number}" >&2
    return 1
  fi
  summary "PR #${number} 将在 CI 通过后以 merge commit 合并。"
}

create_pr_and_automerge() {
  local body pr_url number
  body=$(python3 "$OPS_PY" pr-body)
  pr_url=$(GH_TOKEN="$SYNC_GITHUB_TOKEN" gh pr create \
    --repo "$ORIGIN_REPO" \
    --base main \
    --head "sync/upstream/${GIT_SHA}" \
    --title "sync: upstream ${UPSTREAM_LABEL} @ ${GIT_SHA:0:12}" \
    --body "$body")
  number=$(GH_TOKEN="$SYNC_GITHUB_TOKEN" gh pr view "$pr_url" --repo "$ORIGIN_REPO" --json number --jq .number)
  summary "opened ${pr_url}"
  enable_automerge "$number"
}

publish_conflict() {
  local conflict_file="$1"
  local body title existing
  body=$(python3 "$OPS_PY" conflict-body "$conflict_file")
  title="upstream sync conflict at ${GIT_SHA}"
  existing=$(gh issue list --repo "$ORIGIN_REPO" --state open --limit 20 --search "in:title ${title}" --json number --jq '.[0].number // ""')
  if [[ -n "$existing" ]]; then
    summary "冲突报告已存在于 issue #${existing}。冲突标记未提交，分支未推送。"
    return 0
  fi
  gh issue create --repo "$ORIGIN_REPO" --title "$title" --body "$body" >/dev/null
  summary "已为 Codex 创建冲突报告。冲突标记未提交，sync/upstream/${GIT_SHA} 未推送。"
}

maybe_comment_other() {
  local number="$1"
  local marker="<!-- upstream-sync-newer:${GIT_SHA} -->"
  if [[ -z "${SYNC_GITHUB_TOKEN:-}" || -z "$number" ]]; then
    summary "已有其他 sync PR，本次不打开第二个。更新的 SHA 是 ${GIT_SHA}。"
    return 0
  fi
  local comments
  comments=$(GH_TOKEN="$SYNC_GITHUB_TOKEN" gh api --paginate "repos/${ORIGIN_REPO}/issues/${number}/comments" --jq '.[].body' || true)
  if printf '%s\n' "$comments" | grep -F "$marker" >/dev/null; then
    summary "已有 sync PR #${number}，已记录过更新的 SHA ${GIT_SHA}。"
    return 0
  fi
  GH_TOKEN="$SYNC_GITHUB_TOKEN" gh pr comment "$number" --repo "$ORIGIN_REPO" --body "$(cat <<EOF
${marker}
上游已解析到新的固定 SHA \`${GIT_SHA}\`（${UPSTREAM_LABEL}）。
当前仍只保留这一个 sync PR。合并或关闭它之后，下一次同步才会打开新的 PR。
EOF
)"
  summary "已有 sync PR #${number}。已评论更新的 SHA ${GIT_SHA}，没有打开第二个 PR。"
}

resolve_upstream_sha() {
  local plan kind label git_ref ls lines
  plan=$(python3 "$OPS_PY" parse-channel)
  kind=$(printf '%s' "$plan" | json_get '["kind"]')
  label=$(printf '%s' "$plan" | json_get '["label"]')
  git_ref=$(printf '%s' "$plan" | json_get '["git_ref"]')
  if [[ "$kind" == "release" ]]; then
    label=$(gh api "repos/${UPSTREAM_REPO}/releases/latest" --jq .tag_name)
    if [[ ! "$label" =~ ^v[0-9] ]]; then
      echo "latest release tag is unexpected: ${label}" >&2
      exit 1
    fi
    git_ref="refs/tags/${label}"
  fi
  UPSTREAM_LABEL="$label"
  UPSTREAM_GIT_REF="$git_ref"
  export UPSTREAM_LABEL UPSTREAM_GIT_REF
  local remote_url="https://github.com/${UPSTREAM_REPO}.git"
  ls=$(git ls-remote "$remote_url" "${git_ref}^{}" || true)
  if [[ -z "$ls" ]]; then
    ls=$(git ls-remote "$remote_url" "${git_ref}")
  fi
  lines=$(printf '%s\n' "$ls" | awk 'NF{c++} END{print c+0}')
  if [[ "$lines" != "1" ]]; then
    echo "ref ${git_ref} did not resolve to exactly one object" >&2
    exit 1
  fi
  GIT_SHA=$(printf '%s\n' "$ls" | awk 'NR==1 { print $1 }')
  if [[ ! "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "resolved object is not a commit SHA" >&2
    exit 1
  fi
  export GIT_SHA
}

main() {
  : "${UPSTREAM_CHANNEL:?UPSTREAM_CHANNEL is required; see docs/ops/upstream-sync.md}"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
  if [[ "$ORIGIN_REPO" != "NeedTokenAi/needtoken-pool" ]]; then
    echo "refusing to sync a repository other than NeedTokenAi/needtoken-pool" >&2
    exit 1
  fi
  export UPSTREAM_CHANNEL
  resolve_upstream_sha
  git fetch --no-tags origin main
  MAIN_SHA=$(git rev-parse origin/main)
  export MAIN_SHA
  local contained=false
  if git merge-base --is-ancestor "$GIT_SHA" origin/main; then
    contained=true
  fi
  local open_json remote_line remote_exists=false
  open_json=$(gh pr list --repo "$ORIGIN_REPO" --state open --limit 100 --json number,headRefName,url)
  remote_line=$(git -c "http.extraheader=AUTHORIZATION: bearer ${GITHUB_TOKEN}" \
    ls-remote "https://github.com/${ORIGIN_REPO}.git" "refs/heads/sync/upstream/${GIT_SHA}" || true)
  if [[ -n "$remote_line" ]]; then
    remote_exists=true
  fi
  local decision action pr_number
  decision=$(python3 "$OPS_PY" plan-sync <<EOF
{"sha":"${GIT_SHA}","contained":${contained},"remote_branch_exists":${remote_exists},"open_prs":${open_json}}
EOF
)
  action=$(printf '%s' "$decision" | json_get '["action"]')
  pr_number=$(printf '%s' "$decision" | json_get '["pr_number"]')
  case "$action" in
    skip-contained)
      summary "跳过：${GIT_SHA} 已经在 main（${UPSTREAM_LABEL}）。"
      return 0
      ;;
    skip-other-open)
      maybe_comment_other "$pr_number"
      return 0
      ;;
    ensure-pr)
      if [[ -z "$pr_number" ]]; then
        create_pr_and_automerge
      else
        enable_automerge "$pr_number"
      fi
      return 0
      ;;
    merge-and-create)
      ;;
    *)
      echo "unknown sync action ${action}" >&2
      return 1
      ;;
  esac

  # Fetch the single resolved ref. Do not fetch every tag.
  git fetch --no-tags --no-recurse-submodules \
    "https://github.com/${UPSTREAM_REPO}.git" \
    "+${UPSTREAM_GIT_REF}:refs/remotes/upstream/pinned"
  local fetched
  fetched=$(git rev-parse 'refs/remotes/upstream/pinned^{commit}')
  if [[ "$fetched" != "$GIT_SHA" ]]; then
    echo "upstream ref moved after pin; refusing ${fetched}" >&2
    return 1
  fi
  git checkout -B "sync/upstream/${GIT_SHA}" origin/main
  local conflict_file rc
  conflict_file=$(mktemp)
  rc=0
  integrate_upstream "$GIT_SHA" "$fetched" "$conflict_file" || rc=$?
  if [[ "$rc" -eq 1 ]]; then
    publish_conflict "$conflict_file"
    return 0
  fi
  if [[ "$rc" -eq 20 ]]; then
    summary "合并时发现 ${GIT_SHA} 已经包含在分支中，未推送。"
    return 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    return "$rc"
  fi
  create_pr_and_automerge
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
