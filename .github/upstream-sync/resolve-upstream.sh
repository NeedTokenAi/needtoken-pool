#!/usr/bin/env bash
# 把 UPSTREAM_CHANNEL 解析成一个固定的上游稳定 tag 和 commit SHA。
# 不调用 /releases/latest：那个指针可以改，且 target_commitish 可能是分支名而非提交。
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/stable-tag.sh
source "$root/lib/stable-tag.sh"

CHANNEL=${UPSTREAM_CHANNEL:-stable-tags}
REPO=${UPSTREAM_REPO:-Wei-Shaw/sub2api}
MIN_TAG=${UPSTREAM_MIN_TAG:-}

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

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

if [[ $CHANNEL == stable-tags ]]; then
  gh api --paginate "repos/${REPO}/git/matching-refs/tags/v" --jq '.[].ref' \
    | sed 's#^refs/tags/##' >"$tmp"
else
  gh api --paginate "repos/${REPO}/releases?per_page=100" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name' >"$tmp"
fi

tag=$(select_stable_tag "$MIN_TAG" <"$tmp")
if [[ -z $tag ]]; then
  if [[ -n $MIN_TAG ]]; then
    printf 'status=no_eligible_tag\n'
    printf 'channel=%s\n' "$CHANNEL"
    printf 'min_tag=%s\n' "$MIN_TAG"
    exit 0
  fi
  echo "no stable semver tag found for ${REPO} via ${CHANNEL}" >&2
  exit 1
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
