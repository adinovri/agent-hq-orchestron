#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${AHQ_DATA_DIR:-$HOME/.config/agent-hq-orchestron}"

echo "Initializing agent-hq-orchestron data directory..."
echo "  Location: $DATA_DIR"

mkdir -p \
  "$DATA_DIR/sessions" \
  "$DATA_DIR/projects" \
  "$DATA_DIR/delegation" \
  "$DATA_DIR/logs"

echo "Created folders:"
echo "  $DATA_DIR/sessions"
echo "  $DATA_DIR/projects"
echo "  $DATA_DIR/delegation"
echo "  $DATA_DIR/logs"
echo ""
echo "Done. Run 'npm run dev' to start the development servers."
