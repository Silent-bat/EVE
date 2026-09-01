#!/usr/bin/env bash
# Measures ParticleField's frame cost on a connected Android device.
#
# Why a script: gfxinfo is only meaningful with the app FOREGROUNDED. A
# backgrounded app reports "Total frames rendered: 0" and percentiles in the
# thousands of ms, which reads like catastrophic jank rather than like no data.
# Every attempt so far has been invalidated that way, so this checks focus first
# and refuses rather than printing numbers that mean nothing.
#
# Usage:  apps/mobile/scripts/measure-field.sh [package] [seconds]
# Then:   leave EVE on a screen showing the field (home dock or voice screen)
#         for the whole sample window. Do not switch away.
#
# Baseline to beat, measured on the TECNO CK6 with the View-based field:
#   median 27ms, 90th 40ms, ~2200 frames/30s, against a 16.7ms budget at 60Hz.
set -uo pipefail

PKG="${1:-com.eve.agent}"
SECS="${2:-30}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

if [ ! -x "$ADB" ]; then
  echo "adb not found at $ADB — set ADB=/path/to/adb" >&2
  exit 1
fi

if ! "$ADB" shell pm path --user 0 "$PKG" >/dev/null 2>&1; then
  # This device needs --user 0; without it pm silently lists nothing.
  echo "$PKG is not installed (checked with pm path --user 0)" >&2
  exit 1
fi

focus() {
  "$ADB" shell dumpsys activity activities 2>/dev/null |
    grep -m1 topResumedActivity | sed 's/.*u0 //; s/ .*//'
}

CURRENT="$(focus)"
case "$CURRENT" in
  "$PKG"/*) ;;
  *)
    echo "EVE is not in the foreground — currently: ${CURRENT:-unknown}"
    echo "Open $PKG on a screen with the particle field, then re-run."
    echo "Refusing to sample: a backgrounded app reports 0 frames and garbage"
    echo "percentiles, which is worse than no measurement at all."
    exit 2
    ;;
esac

echo "Sampling $PKG for ${SECS}s — keep the field on screen."
"$ADB" shell dumpsys gfxinfo "$PKG" reset >/dev/null 2>&1
sleep "$SECS"

AFTER="$(focus)"
case "$AFTER" in
  "$PKG"/*) ;;
  *)
    echo "Focus moved to ${AFTER:-unknown} during the sample — discarding." >&2
    exit 2
    ;;
esac

echo
"$ADB" shell dumpsys gfxinfo "$PKG" 2>/dev/null |
  grep -E "Total frames rendered|Janky frames|percentile|Number Missed Vsync|Number High input latency"

echo
echo "Reference points:"
echo "  View-based field  : median 27ms, 90th 40ms, ~2200 frames/30s"
echo "  60Hz frame budget : 16.7ms"
echo
echo "If 'Total frames rendered' is 0, the field was not actually drawing —"
echo "check that the screen you left open contains the ParticleField, and that"
echo "the GL path loaded (logcat for '[ParticleField] GL setup failed')."
