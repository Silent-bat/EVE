#!/usr/bin/env bash
# Complete a real Google sign-in from a desktop browser on this machine.
#
# This is the only way to verify Gmail auth end-to-end without the phone. It
# works because GOOGLE_REDIRECT_URI points at this machine's own API
# (http://localhost:8080/v1/google/callback) — Google rejects private-IP
# redirect URIs, so the callback must come back through localhost either way.
#
# The OAuth state token expires after 10 minutes, so this fetches a fresh URL
# and opens it immediately rather than printing one to use later.
#
# Usage: scripts/browser-login.sh
set -uo pipefail

API=${EVE_API_URL:-http://localhost:8080}

if ! curl -sf -m 10 "$API/health" >/dev/null; then
  echo "API is not answering on $API — start it with 'pnpm api:dev'."
  exit 1
fi

payload=$(curl -sf -m 20 "$API/v1/auth/google-url")
if [ -z "$payload" ]; then
  echo "could not reach $API/v1/auth/google-url"
  exit 1
fi

configured=$(printf '%s' "$payload" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).configured')
if [ "$configured" != "true" ]; then
  reason=$(printf '%s' "$payload" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).reason || "unknown"')
  echo "Google OAuth is not configured: $reason"
  exit 1
fi

url=$(printf '%s' "$payload" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).url')

echo "opening Google sign-in (this consent link is valid for 10 minutes)..."
open "$url" 2>/dev/null || echo "open this URL manually:\n$url"
echo
echo "after you approve, the browser should show: 'Google login complete.'"
echo "then confirm the account is connected with:"
echo "  node --env-file=../../.env scripts/debug-user.mjs"
