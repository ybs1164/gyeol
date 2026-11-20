#!/usr/bin/env bash
set -euo pipefail
port=$(sed -n 's/^PORT=\([0-9]*\)$/\1/p' /etc/gyeol/server.env)
port=${port:-8787}
exec /opt/gyeol/runtime/bin/node /opt/gyeol/current/smoke.mjs "http://127.0.0.1:$port" "$@"
