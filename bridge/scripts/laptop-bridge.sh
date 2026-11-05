#!/usr/bin/env bash
# Run on the LAPTOP: start the bridge that lets the agent drive ego lite.
#
#   source bridge/.state/tokens.env      # copy the token the relay printed
#   bridge/scripts/laptop-bridge.sh wss://<relay-host> "$EGO_BRIDGE_TOKEN"
#
# No inbound port is opened on the laptop: the bridge dials out to the relay.
set -euo pipefail

cd "$(dirname "$0")/.."

RELAY="${1:-${EGO_BRIDGE_RELAY:-}}"
TOKEN="${2:-${EGO_BRIDGE_TOKEN:-}}"

if [ -z "$RELAY" ] || [ -z "$TOKEN" ]; then
  cat >&2 <<'EOF'
usage: bridge/scripts/laptop-bridge.sh <relay-url> <bridge-token>
  relay-url examples:
    ws://127.0.0.1:8080/bridge        (relay running on this laptop)
    wss://<preview-host>/bridge       (relay running in the cloud sandbox)
EOF
  exit 2
fi

if ! command -v ego-browser >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ego-browser is not on PATH.
  1. Install ego lite: https://lite.ego.app/  (macOS or Windows)
  2. Finish onboarding in the app; it registers ego-browser on PATH.
  3. Open a NEW terminal and check: ego-browser nodejs -e "console.log('ready')"
EOF
  exit 2
fi

echo "[laptop] ego-browser: $(command -v ego-browser)"
echo "[laptop] dialling $RELAY"
exec node laptop/bridge.mjs --relay "$RELAY" --token "$TOKEN" --verbose
