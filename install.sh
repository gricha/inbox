#!/usr/bin/env bash
# Installs Inbox: the app from the latest GitHub release, or from source until there is one (or with --source).
#   curl -fsSL -H "Authorization: Bearer $(gh auth token)" https://raw.githubusercontent.com/gricha/inbox/main/install.sh | bash
# Settings: INBOX_APPS (where the app goes), INBOX_DIR (the source checkout), INBOX_BIN (where `desk` is linked).
set -euo pipefail

REPO=gricha/inbox
OS=$(uname -s)
ARCH=$(uname -m)
BIN=${INBOX_BIN:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
die() {
  printf 'inbox install: %s\n' "$*" >&2
  exit 1
}

# gh reads the private repo with your login, and the desk itself needs it.
need_gh() {
  command -v gh >/dev/null || die "needs the GitHub CLI: https://cli.github.com, then gh auth login"
  gh auth status >/dev/null 2>&1 || die "gh isn't logged in: run gh auth login"
}

need_node() {
  command -v node >/dev/null || die "needs Node 22.18 or newer: https://nodejs.org"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' ||
    die "needs Node 22.18 or newer, found $(node -v)"
}

# The latest release's file for this machine, or nothing when there's no release or no build for it.
release_asset() {
  local tag ver
  tag=$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null </dev/null) || return 0
  ver=${tag#v}
  case "$OS-$ARCH" in
    Darwin-arm64) echo "Inbox-$ver-arm64.dmg" ;;
    Darwin-x86_64) echo "Inbox-$ver.dmg" ;;
    Linux-x86_64) echo "Inbox-$ver.AppImage" ;;
  esac
}

install_dmg() {
  local dmg=$1 apps=${INBOX_APPS:-/Applications} mnt
  [ -w "$apps" ] || apps=$HOME/Applications
  mkdir -p "$apps"
  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
  rm -rf "$apps/Inbox.app"
  cp -R "$mnt/Inbox.app" "$apps/"
  hdiutil detach -quiet "$mnt"
  # It's ad-hoc signed, not notarized: without this macOS refuses to open it.
  xattr -dr com.apple.quarantine "$apps/Inbox.app" 2>/dev/null || true
  say "Installed $apps/Inbox.app. Open it from there; it updates itself from the sidebar."
}

install_appimage() {
  local file=$1 apps=${INBOX_APPS:-$HOME/.local/bin}
  mkdir -p "$apps"
  install -m 755 "$file" "$apps/Inbox.AppImage"
  say "Installed $apps/Inbox.AppImage. Run it to start; it updates itself from the sidebar."
}

from_release() {
  local name=$1 tmp
  tmp=$(mktemp -d)
  say "Downloading $name"
  gh release download --repo "$REPO" --pattern "$name" --dir "$tmp" </dev/null
  case "$OS" in
    Darwin) install_dmg "$tmp/$name" ;;
    Linux) install_appimage "$tmp/$name" ;;
  esac
  rm -rf "$tmp"
}

# The checkout, its packages, and `desk` on your PATH; the app runs with npm run app.
from_source() {
  local dir=${INBOX_DIR:-$HOME/.local/share/inbox}
  need_node
  command -v git >/dev/null || die "needs git"
  if [ -d "$dir/.git" ]; then
    say "Updating $dir"
    git -C "$dir" pull --ff-only --quiet </dev/null
  else
    say "Cloning $REPO into $dir"
    mkdir -p "$(dirname "$dir")"
    gh repo clone "$REPO" "$dir" -- --quiet </dev/null
  fi
  (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error </dev/null)
  mkdir -p "$BIN"
  ln -sf "$dir/bin/desk" "$BIN/desk"
  say "Installed from source in $dir, with desk linked at $BIN/desk."
  case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to run desk." ;; esac
  say "Start the app: cd $dir && npm run app"
}

main() {
  local name
  case "$OS" in Darwin | Linux) ;; *) die "on Windows, run the installer from https://github.com/$REPO/releases" ;; esac
  need_gh
  name=$([ "${1:-}" = --source ] || release_asset)
  if [ -n "$name" ]; then
    from_release "$name"
  else
    [ "${1:-}" = --source ] || say "No release for this machine yet: installing from source."
    from_source
  fi
}

main "$@"
