#!/bin/bash

set -euo pipefail

PROMO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DYLD_INSERT_LIBRARIES="$PROMO_ROOT/.audio/eve-thermal-shim.dylib"

exec "/Users/kanafranklin/.cache/puppeteer/chrome-headless-shell/mac-137.0.7151.119/chrome-headless-shell-mac-x64/chrome-headless-shell" --single-process "$@"
