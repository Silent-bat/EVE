#!/usr/bin/env bash
# Wire a connected Android device up for EVE development and launch the app.
#
# Two things make login work on device, and both are easy to lose:
#
#   1. The app resolves its API URL from Metro's host. When the device reaches
#      Metro over loopback, the API resolves to 127.0.0.1:8080 and only works
#      while `adb reverse` is alive — which dies on every disconnect. Pointing
#      the dev client at Metro's LAN address instead makes the app talk to the
#      API over wifi, so an adb drop no longer breaks it.
#
#   2. The browser sign-in fallback still needs `adb reverse tcp:8080`, because
#      Google rejects private-IP redirect URIs, so the callback has to come back
#      through the phone's own localhost.
#
# Usage: scripts/dev-device.sh [--wait]
set -uo pipefail

API_PORT=8080
METRO_PORT=8081
PACKAGE=com.eve.agent
SCHEME=eve

if ! command -v adb >/dev/null 2>&1; then
  export PATH="$PATH:$HOME/Library/Android/sdk/platform-tools"
fi

if [ "${1:-}" = "--wait" ]; then
  echo "waiting for a device (enable wireless debugging or plug in USB)..."
  adb wait-for-device
fi

device=$(adb devices | awk '/\tdevice$/ {print $1; exit}')
if [ -z "$device" ]; then
  echo "no device connected. Enable Wireless debugging on the phone, then:"
  echo "  adb pair <ip>:<pair-port>   # first time only"
  echo "  adb connect <ip>:<port>"
  exit 1
fi
echo "device: $device"

lan_ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -z "$lan_ip" ]; then
  echo "could not determine this machine's LAN IP; falling back to loopback."
  lan_ip=localhost
fi

# Needed for the browser sign-in callback even when the app itself uses the LAN
# address, so set it regardless.
adb reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >/dev/null || true
adb reverse "tcp:$API_PORT" "tcp:$API_PORT" >/dev/null || true
echo "reverse tunnels:"
adb reverse --list | sed 's/^/  /'

if ! curl -sf -m 10 "http://$lan_ip:$API_PORT/health" >/dev/null; then
  echo "warning: API is not answering on http://$lan_ip:$API_PORT — start it with 'pnpm api:dev'."
fi
if ! curl -sf -m 10 "http://$lan_ip:$METRO_PORT/status" >/dev/null; then
  echo "warning: Metro is not answering on http://$lan_ip:$METRO_PORT — start it with 'pnpm mobile:dev'."
fi

metro_url="http://$lan_ip:$METRO_PORT"
encoded=$(printf '%s' "$metro_url" | sed 's|:|%3A|g; s|/|%2F|g')

adb shell am force-stop "$PACKAGE"
adb shell am start -a android.intent.action.VIEW \
  -d "$SCHEME://expo-development-client/?url=$encoded" \
  "$PACKAGE" >/dev/null 2>&1

echo "launched $PACKAGE against $metro_url"
echo "the app will call the API at http://$lan_ip:$API_PORT"
echo
echo "to watch sign-in:"
echo "  adb logcat -s ReactNativeJS:V | grep -i 'eve\\]\\|google\\|sign'"
