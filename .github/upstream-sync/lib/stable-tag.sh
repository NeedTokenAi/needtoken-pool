#!/usr/bin/env bash
# 从 stdin 的 tag 列表里选出最高的稳定语义化版本。
# 只接受 vMAJOR.MINOR.PATCH。rc/beta/alpha 这类预发布标签会被丢掉。
# 可选参数 min_tag（同样必须是 vMAJOR.MINOR.PATCH）：仅接受 >= min_tag 的稳定版。
# 依赖 GNU sort -V（GitHub Actions ubuntu-latest 自带）。

semver_gte() {
  local candidate=$1 floor=$2
  [[ $candidate =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ $floor =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ $(printf '%s\n%s\n' "$floor" "$candidate" | LC_ALL=C sort -V | head -n 1) == "$floor" ]]
}

select_stable_tag() {
  local min_tag=${1:-}
  local picked
  picked=$(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | LC_ALL=C sort -V | tail -n 1 || true)
  if [[ -z $picked ]]; then
    return 0
  fi
  if [[ -n $min_tag ]]; then
    if ! [[ $min_tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf 'invalid min_tag %q (expected vMAJOR.MINOR.PATCH)\n' "$min_tag" >&2
      return 1
    fi
    if ! semver_gte "$picked" "$min_tag"; then
      return 0
    fi
  fi
  printf '%s\n' "$picked"
}
