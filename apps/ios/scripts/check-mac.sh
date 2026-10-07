#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo 'Install Xcode and select it in Xcode > Settings > Locations > Command Line Tools.' >&2
  exit 1
fi
xcodebuild -version
swift test
xcodebuild -project WayPoint.xcodeproj -scheme WayPoint \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build/ios CODE_SIGNING_ALLOWED=NO build
if [ "${1:-}" = '--test' ]; then
  if [ -z "${WAYPOINT_TEST_DESTINATION:-}" ]; then
    echo 'Set WAYPOINT_TEST_DESTINATION to an installed simulator, e.g. platform=iOS Simulator,name=iPhone 17.' >&2
    echo 'Use xcrun simctl list devices available to find its exact name.' >&2
    exit 1
  fi
  xcodebuild -project WayPoint.xcodeproj -scheme WayPoint \
    -configuration Debug -destination "$WAYPOINT_TEST_DESTINATION" \
    -derivedDataPath .build/ios CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
fi
