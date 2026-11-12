#!/usr/bin/env bash
# npm run release:publish v0.2.4: builds a tag for macOS, Windows and Linux on this Mac and publishes its GitHub Release.
# Stopgap while GitHub Actions is blocked by billing; --build-only builds and stops.
set -euo pipefail

tag=${1:?usage: npm run release:publish vX.Y.Z [-- --build-only]}
only=${2:-}
repo=gricha/inbox
root=$(git rev-parse --show-toplevel)
cd "$root"

[ "$(uname)" = Darwin ] || { echo "release:publish builds the Mac app: run it on macOS" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag isn't a tag: npm run release ${tag#v} first" >&2; exit 1; }
version=$(git show "$tag:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
[ "v$version" = "$tag" ] || { echo "$tag, but its package.json says $version" >&2; exit 1; }
if [ -z "$only" ] && gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  echo "$tag is already released" >&2
  exit 1
fi

wt=$root/.claude/worktrees/release-$tag
rm -rf "$wt"
git worktree add --quiet --detach "$wt" "$tag"
trap 'git -C "$root" worktree remove --force "$wt"' EXIT
cp -cR node_modules "$wt/node_modules"
cd "$wt"

npm run -s check
npm run -s build
npx electron-builder --mac --arm64 --x64 --publish never
# Apart: arch flags apply to every platform named, and Windows and Linux are x64 only (package.json's build).
npx electron-builder --win --linux --publish never

shopt -s nullglob
assets=(release/*.dmg release/*.zip release/*.AppImage release/*.tar.gz release/*.exe release/*.blockmap release/latest*.yml)
printf '%s\n' "${assets[@]}"
if [ "$only" = --build-only ]; then
  rm -rf "$root/release" && cp -R release "$root/release"
  echo "Built $tag into release/; nothing pushed or published"
  exit 0
fi

git -C "$root" push origin "$tag^{commit}:refs/heads/main" "refs/tags/$tag"
gh release create "$tag" "${assets[@]}" -R "$repo" --verify-tag --title "Inbox $version" --generate-notes
echo "Published https://github.com/$repo/releases/tag/$tag"
