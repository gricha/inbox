#!/bin/sh
# Builds the app, runs it in the booted Simulator against the mock desk, and writes a PNG of each state into ios/.shots/,
# in light and dark. Look at them after any change to the app: ios/README.md says what to look for.
#
#   ios/shots.sh                  every state
#   ios/shots.sh inbox item-pr    only these
#
# SHOTS_UDID picks a simulator (default: the booted one); SHOTS_PORT the mock's port (default 47841).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
PORT=${SHOTS_PORT:-47841}
DESK="http://localhost:$PORT"
OUT="$HERE/.shots"
BUNDLE=dev.inbox.ios
PATH="/opt/homebrew/bin:$PATH"

UDID=${SHOTS_UDID:-$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-]\{36\}\)) (Booted).*/\1/p' | head -1)}
[ -n "$UDID" ] || { echo "No booted simulator: open Simulator (or xcrun simctl boot \"iPhone 17 Pro\") first." >&2; exit 1; }

# A desk already on the port (a mock started by hand, with whatever was done to it since) would be shot in the mock's place.
if curl -fs "$DESK/health" >/dev/null 2>&1; then
  echo "Something already answers on port $PORT: stop it first (or set SHOTS_PORT), so the shots are of a fresh mock." >&2
  exit 1
fi

echo "Building…"
mkdir -p "$HERE/.build"
xcodebuild -project "$HERE/Inbox.xcodeproj" -scheme Inbox -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$HERE/.build" build >"$HERE/.build/shots-build.log" 2>&1 ||
  { tail -30 "$HERE/.build/shots-build.log" >&2; exit 1; }
xcrun simctl install "$UDID" "$HERE/.build/Build/Products/Debug-iphonesimulator/Inbox.app"

# The mock desk, for as long as this script runs. Its dates are relative to its start, so ages read the same every run.
(cd "$ROOT" && MOCK_PORT=$PORT MOCK_NO_POLL=1 exec node --disable-warning=ExperimentalWarning web/mock/server.ts) >/dev/null 2>&1 &
MOCK=$!
cleanup() {
  kill "$MOCK" 2>/dev/null || true
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl status_bar "$UDID" clear >/dev/null 2>&1 || true
  xcrun simctl ui "$UDID" appearance light >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
i=0
until curl -fs "$DESK/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || { echo "The mock desk didn't start on port $PORT (is it taken, or is npm install needed?)." >&2; exit 1; }
  sleep 0.2
done

mkdir -p "$OUT"
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 >/dev/null 2>&1 || true

# name, then the launch arguments that reach it (Store.applyLaunchArguments, DEBUG builds only).
shot() {
  name=$1
  shift
  for look in light dark; do
    xcrun simctl ui "$UDID" appearance "$look"
    xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl launch "$UDID" "$BUNDLE" "$@" >/dev/null
    sleep "${SHOTS_WAIT:-3}"
    xcrun simctl io "$UDID" screenshot "$OUT/$name-$look.png" >/dev/null 2>&1
    echo "  $name-$look.png"
  done
}

wanted() {
  [ -z "$ONLY" ] && return 0
  for w in $ONLY; do [ "$w" = "$1" ] && return 0; done
  return 1
}
ONLY="$*"

wanted connect && shot connect -connect
wanted connect-error && shot connect-error -connect -connectAddress "https://desk.tail1234.ts.net" \
  -connectError "That pairing code isn't valid: run desk pair again for a new one."
wanted inbox && shot inbox -deskURL "$DESK"
wanted inbox-scrolled && shot inbox-scrolled -deskURL "$DESK" -scrollTo standard
wanted inbox-empty && shot inbox-empty -deskURL "$DESK" -empty
wanted blocked && shot blocked -deskURL "$DESK" -page blocked
wanted merging && shot merging -deskURL "$DESK" -page merging
wanted archive && shot archive -deskURL "$DESK" -page archive
wanted item-pr && shot item-pr -deskURL "$DESK" -open "acme/api#4127"
wanted item-issue && shot item-issue -deskURL "$DESK" -open "acme/worker#860"
wanted question && shot question -deskURL "$DESK" -open "inquiry:q1c0ffee"
wanted session && shot session -deskURL "$DESK" -open "session:5f1c2a90-7d3e-4b8a-9c11-2e6f0a4b7d21"
wanted settings && shot settings -deskURL "$DESK" -settings
# A desk that isn't there: nothing listens on port 9.
wanted offline && shot offline -deskURL "http://localhost:9"

echo "Wrote $OUT"
