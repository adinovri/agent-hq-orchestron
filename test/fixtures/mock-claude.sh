#!/usr/bin/env bash
# Deterministic JSONL emitter that mimics Claude CLI output.
# Emits: init event, assistant message, result event to stdout.
# Reads --session-id from args if provided; otherwise generates a UUID.

SESSION_ID=""
PROMPT_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="$2"
      shift 2
      ;;
    -p|--prompt)
      PROMPT_ARG="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo 'mock-session-uuid')"
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

# Emit init
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"${SESSION_ID}\",\"timestamp\":\"${TS}\"}"

sleep 0.1

# Emit assistant message
echo "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Mock response to: ${PROMPT_ARG:-hello}\"}]},\"session_id\":\"${SESSION_ID}\",\"timestamp\":\"${TS}\"}"

sleep 0.1

# Emit result
echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"Mock task completed\",\"session_id\":\"${SESSION_ID}\",\"usage\":{\"input_tokens\":10,\"output_tokens\":20},\"cost_usd\":0.0001,\"timestamp\":\"${TS}\"}"
