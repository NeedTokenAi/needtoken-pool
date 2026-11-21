#!/usr/bin/env bash
# 把 UPSTREAM_CHANNEL（或显式 TARGET_TAG）解析成一个固定的上游稳定 tag 和 commit SHA。
# 不调用 /releases/latest：那个指针可以改，且 target_commitish 可能是分支名而非提交。
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/stable-tag.sh
source "$root/lib/stable-tag.sh"

CHANNEL=${UPSTREAM_CHANNEL:-stable-tags}
REPO=${UPSTREAM_REPO:-Wei-Shaw/sub2api}
MIN_TAG=${UPSTREAM_MIN_TAG:-}
TARGET_TAG=${UPSTREAM_TARGET_TAG:-}
SKIP_TAGS=${UPSTREAM_SKIP_TAGS:-}

case "$CHANNEL" in
  stable-tags | releases) ;;
  *)
    printf 'unsupported UPSTREAM_CHANNEL=%s (expected stable-tags or releases)\n' "$CHANNEL" >&2
    exit 1
    ;;
esac

if [[ -n $MIN_TAG ]] && ! [[ $MIN_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'unsupported UPSTREAM_MIN_TAG=%q (expected vMAJOR.MINOR.PATCH)\n' "$MIN_TAG" >&2
  exit 1
fi

is_skipped_tag() {
  local candidate=$1 item
  [[ -n $SKIP_TAGS ]] || return 1
  local IFS=','
  for item in $SKIP_TAGS; do
    item=${item//[[:space:]]/}
    [[ -n $item && $item == "$candidate" ]] && return 0
  done
  return 1
}

if [[ -n $TARGET_TAG ]]; then
  if ! [[ $TARGET_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'unsupported UPSTREAM_TARGET_TAG=%q (expected vMAJOR.MINOR.PATCH)\n' "$TARGET_TAG" >&2
    exit 1
  fi
  tag=$TARGET_TAG
  CHANNEL="manual-tag"
else
  tmp=$(mktemp)
  filtered=$(mktemp)
  trap 'rm -f "$tmp" "$filtered"' EXIT

  if [[ $CHANNEL == stable-tags ]]; then
    gh api --paginate "repos/${REPO}/git/matching-refs/tags/v" --jq '.[].ref' \
      | sed 's#^refs/tags/##' >"$tmp"
  else
    gh api --paginate "repos/${REPO}/releases?per_page=100" \
      --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name' >"$tmp"
  fi

  : >"$filtered"
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    if is_skipped_tag "$line"; then
      continue
    fi
    printf '%s\n' "$line" >>"$filtered"
  done <"$tmp"

  tag=$(select_stable_tag "$MIN_TAG" <"$filtered")
  if [[ -z $tag ]]; then
    printf 'status=no_eligible_tag\n'
    printf 'channel=%s\n' "$CHANNEL"
    printf 'min_tag=%s\n' "$MIN_TAG"
    exit 0
  fi
fi

[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'refusing unexpected tag %q\n' "$tag" >&2
  exit 1
}

obj_type=$(gh api "repos/${REPO}/git/ref/tags/${tag}" --jq '.object.type')
obj_sha=$(gh api "repos/${REPO}/git/ref/tags/${tag}" --jq '.object.sha')
if [[ $obj_type == tag ]]; then
  peel_type=$(gh api "repos/${REPO}/git/tags/${obj_sha}" --jq '.object.type')
  peel_sha=$(gh api "repos/${REPO}/git/tags/${obj_sha}" --jq '.object.sha')
  obj_type=$peel_type
  obj_sha=$peel_sha
fi

[[ $obj_type == commit ]] || {
  printf 'tag %s resolved to %s, want commit\n' "$tag" "$obj_type" >&2
  exit 1
}
[[ $obj_sha =~ ^[0-9a-f]{40}$ ]] || {
  printf 'tag %s resolved to invalid sha %q\n' "$tag" "$obj_sha" >&2
  exit 1
}

printf 'status=ok\n'
printf 'channel=%s\n' "$CHANNEL"
printf 'tag=%s\n' "$tag"
printf 'sha=%s\n' "$obj_sha"
