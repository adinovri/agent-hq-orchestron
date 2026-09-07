#!/usr/bin/env bash
set -euo pipefail

# Default data dir MUST match packages/shared/src/config.ts defaultDataDir()
# → ~/.orchestron. Older scaffold used ~/.config/agent-hq-orchestron/ and
# the AHQ_DATA_DIR env var; both are still honored as backward-compat but
# fresh installs land in the same place the API reads on boot.
DATA_DIR="${ORCHESTRON_DATA_DIR:-${AHQ_DATA_DIR:-$HOME/.orchestron}}"

echo "Initializing agent-hq-orchestron data directory..."
echo "  Location: $DATA_DIR"

mkdir -p \
  "$DATA_DIR/sessions" \
  "$DATA_DIR/projects" \
  "$DATA_DIR/delegation" \
  "$DATA_DIR/logs" \
  "$DATA_DIR/mcp-configs" \
  "$DATA_DIR/metrics" \
  "$DATA_DIR/notes" \
  "$DATA_DIR/schedules" \
  "$DATA_DIR/hooks" \
  "$DATA_DIR/cache"

echo "Created folders under $DATA_DIR:"
echo "  sessions/ projects/ delegation/ logs/ mcp-configs/"
echo "  metrics/ notes/ schedules/ hooks/ cache/"
echo ""
echo "Done. Run 'npm run dev' to start the development servers."
