#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run dev --workspace=@agent-hq-orchestron/api &
API_PID=$!

npm run dev --workspace=@agent-hq-orchestron/web &
WEB_PID=$!

trap "kill $API_PID $WEB_PID 2>/dev/null; exit" INT TERM

echo "API (port 8080) and Web (port 3000) started."
echo "Press Ctrl+C to stop."

wait $API_PID $WEB_PID
