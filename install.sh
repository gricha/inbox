#!/usr/bin/env bash
# Installs Inbox, or updates it in place: the app from the latest GitHub release (from source until there is one, or with
# --source), a GitHub CLI login for it to read GitHub with, and `desk` on your PATH. Then it opens the app.
#   curl -fsSL https://raw.githubusercontent.com/gricha/inbox/main/install.sh | bash
# Settings: INBOX_APPS (where the app goes), INBOX_DIR (the source checkout), INBOX_BIN (where `desk` goes), INBOX_NO_OPEN=1
# (don't open it). INBOX_API, INBOX_DOWNLOADS and INBOX_GIT point it at another release or clone (for testing it).
set -euo pipefail

REPO=gricha/inbox
API=${INBOX_API:-https://api.github.com}
DOWNLOADS=${INBOX_DOWNLOADS:-https://github.com/$REPO/releases/download}
GIT=${INBOX_GIT:-https://github.com/$REPO.git}
OS=$(uname -s)
ARCH=$(uname -m)
BIN=${INBOX_BIN:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
die() {
  printf 'inbox install: %s\n' "$*" >&2
  exit 1
}

# Piped into bash, stdin is this script: questions and logins read the terminal, when there is one.
has_tty() { (: </dev/tty) 2>/dev/null; }
ask() {
  local answer
  has_tty || return 1
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in [nN]*) return 1 ;; esac
}

# The app reads GitHub with gh's login. The token stays gh's: nothing here reads it. Without one the app's first page says
# what to run, so this never stops the install.
github() {
  if ! command -v gh >/dev/null; then
    if [ "$OS" = Darwin ] && command -v brew >/dev/null && ask "Inbox reads GitHub through the GitHub CLI (gh). Install it with Homebrew?"; then
      brew install gh </dev/null || {
        say "brew install gh failed: install it from https://cli.github.com, then run: gh auth login"
        return
      }
    else
      say "Inbox reads GitHub through the GitHub CLI (gh), which isn't installed."
      if [ "$OS" = Darwin ]; then say "  Install it: brew install gh (or https://cli.github.com), then run: gh auth login"; else say "  Install it from https://cli.github.com, then run: gh auth login"; fi
      return
    fi
  fi
  if gh auth status >/dev/null 2>&1 </dev/null; then
    say "GitHub: signed in."
  elif has_tty; then
    say "Signing in to GitHub (gh auth login)."
    gh auth login --web </dev/tty || say "gh auth login didn't finish: run it yourself, then press Retry in the app."
  else
    say "Not signed in to GitHub: run gh auth login, then press Retry in the app."
  fi
}

need_node() {
  command -v node >/dev/null || die "needs Node 22.18 or newer: https://nodejs.org"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' </dev/null ||
    die "needs Node 22.18 or newer, found $(node -v)"
}

# "<tag> <file>": the latest release and its file for this machine, or nothing when there's no release or no build for it.
release_asset() {
  local json tag name
  json=$(curl -fsSL "$API/repos/$REPO/releases/latest" 2>/dev/null </dev/null) || return 0
  tag=$(printf '%s\n' "$json" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/') || true
  [ -n "$tag" ] || return 0
  case "$OS-$ARCH" in
    Darwin-arm64) name="Inbox-${tag#v}-arm64.dmg" ;;
    Darwin-x86_64) name="Inbox-${tag#v}.dmg" ;;
    Linux-x86_64) name="Inbox-${tag#v}.AppImage" ;;
    *) return 0 ;;
  esac
  printf '%s\n' "$json" | grep -q "\"name\": *\"$name\"" && echo "$tag $name"
  return 0
}

# A launcher that runs the CLI the app bundles, in the app's own Node.
cli_from_app() {
  local app=$1
  mkdir -p "$BIN"
  rm -f "$BIN/desk"
  cat >"$BIN/desk" <<EOF
#!/bin/sh
# desk, from $app (written by Inbox's install.sh).
ELECTRON_RUN_AS_NODE=1 exec "$app/Contents/MacOS/Inbox" --disable-warning=ExperimentalWarning "$app/Contents/Resources/app.asar/src/cli.ts" "\$@"
EOF
  chmod 755 "$BIN/desk"
  CLI=1
}

install_dmg() {
  local dmg=$1 apps=${INBOX_APPS:-/Applications} mnt
  [ -w "$apps" ] || [ -n "${INBOX_APPS:-}" ] || apps=$HOME/Applications
  mkdir -p "$apps"
  # An update: the running app quits first, so the one opened at the end is the new one.
  if pgrep -f "$apps/Inbox.app/Contents/MacOS/Inbox" >/dev/null; then
    osascript -e 'tell application id "dev.inbox.app" to quit' </dev/null >/dev/null 2>&1 || true
    sleep 2
  fi
  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg" </dev/null
  rm -rf "$apps/Inbox.app"
  cp -R "$mnt/Inbox.app" "$apps/"
  hdiutil detach -quiet "$mnt" </dev/null
  # It's ad-hoc signed, not notarized: without this macOS refuses to open it.
  xattr -dr com.apple.quarantine "$apps/Inbox.app" 2>/dev/null || true
  cli_from_app "$apps/Inbox.app"
  say "Installed $apps/Inbox.app, with desk at $BIN/desk. It updates itself from the sidebar."
  APP=$apps/Inbox.app
}

install_appimage() {
  local file=$1 apps=${INBOX_APPS:-$HOME/.local/bin}
  mkdir -p "$apps"
  install -m 755 "$file" "$apps/Inbox.AppImage"
  say "Installed $apps/Inbox.AppImage. It updates itself from the sidebar."
  APP=$apps/Inbox.AppImage
}

from_release() {
  local tag=$1 name=$2 tmp
  tmp=$(mktemp -d)
  say "Downloading $name"
  curl -fL --progress-bar -o "$tmp/$name" "$DOWNLOADS/$tag/$name" </dev/null
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
    git clone --quiet "$GIT" "$dir" </dev/null
  fi
  (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error </dev/null)
  mkdir -p "$BIN"
  ln -sf "$dir/bin/desk" "$BIN/desk"
  CLI=1
  say "Installed from source in $dir, with desk at $BIN/desk. Start the app there with npm run app."
  SOURCE=$dir
}

# $BIN on your PATH, through your shell's startup file, once.
on_path() {
  local rc line="export PATH=\"$BIN:\$PATH\""
  case ":$PATH:" in *":$BIN:"*) return ;; esac
  case "${SHELL:-}" in */zsh) rc=$HOME/.zshrc ;; */bash) rc=$HOME/.bashrc ;; *) rc=$HOME/.profile ;; esac
  grep -qsF "$line" "$rc" || printf '\n# Inbox: desk\n%s\n' "$line" >>"$rc"
  say "Added $BIN to your PATH in $rc: open a new terminal to run desk."
}

open_app() {
  [ -z "${INBOX_NO_OPEN:-}" ] || return 0
  say "Opening Inbox."
  if [ -n "${SOURCE:-}" ]; then
    (cd "$SOURCE" && nohup npm run app </dev/null >/dev/null 2>&1 &)
  elif [ "$OS" = Darwin ]; then
    open "$APP"
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    (nohup "$APP" </dev/null >/dev/null 2>&1 &)
  else
    say "No display here: run $APP from your desktop."
  fi
}

main() {
  local found=""
  case "$OS" in Darwin | Linux) ;; *) die "on Windows, run the installer from https://github.com/$REPO/releases" ;; esac
  [ "${1:-}" = --source ] || found=$(release_asset)
  github
  if [ -n "$found" ]; then
    # shellcheck disable=SC2086 # "<tag> <file>"
    from_release $found
  else
    [ "${1:-}" = --source ] || say "No release for this machine yet: installing from source."
    from_source
  fi
  [ -z "${CLI:-}" ] || on_path
  open_app
}

main "$@"
