#!/usr/bin/env bash
# The version a release cuts: the one asked for (x.y.z, a leading v allowed), or the next patch past package.json's.
# Refuses one that isn't past package.json's, or that's already a tag. Used by every job of the release workflow.
set -euo pipefail
current=$(node -p 'require("./package.json").version')
version=${1#v}
if [ -z "$version" ]; then
  IFS=. read -r a b c <<<"$current"
  version="$a.$b.$((c + 1))"
fi
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "$version isn't x.y.z" >&2; exit 1; }
[ "$version" != "$current" ] && [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)" = "$version" ] ||
  { echo "$version isn't past $current" >&2; exit 1; }
if git ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1; then
  echo "v$version is already a tag" >&2
  exit 1
fi
echo "$version"
