#!/usr/bin/env bash
# Start the relay locally (sandbox / first run on the laptop).
#
#   bridge/scripts/dev-relay.sh                 # http://0.0.0.0:8080
#   PORT=9000 bridge/scripts/dev-relay.sh
#
# Prints the two tokens to export. The bridge token goes on the laptop; the
# agent token stays in the sandbox.
set -euo pipefail

cd "$(dirname "$0")/../.."

export PORT="${PORT:-8080}"
export HOST="${HOST:-0.0.0.0}"
export EGO_BRIDGE_TOKEN="${EGO_BRIDGE_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
export EGO_AGENT_TOKEN="${EGO_AGENT_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
export EGO_BRIDGE_SHOTS="${EGO_BRIDGE_SHOTS:-$PWD/bridge/.state/shots}"

mkdir -p bridge/.state
cat > bridge/.state/tokens.env <<EOF
# generated $(date -u +%FT%TZ) — do not commit
export EGO_BRIDGE_TOKEN=$EGO_BRIDGE_TOKEN
export EGO_AGENT_TOKEN=$EGO_AGENT_TOKEN
export EGO_RELAY_URL=http://127.0.0.1:$PORT
EOF
chmod 600 bridge/.state/tokens.env

cat <<EOF
[dev-relay] writing bridge/.state/tokens.env
[dev-relay] laptop bridge token : $EGO_BRIDGE_TOKEN
[dev-relay] agent token         : $EGO_AGENT_TOKEN
[dev-relay] relay url           : http://127.0.0.1:$PORT   (bridge: ws://<host>:$PORT/bridge)
EOF

exec node bridge/relay/server.mjs
