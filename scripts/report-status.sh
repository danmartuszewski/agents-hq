#!/bin/bash
# Usage: ./report-status.sh <agent-id> <status> [task] [tool]
# Example: ./report-status.sh ceo active "Reviewing strategy" "Read"

AGENT_ID="${1:?Usage: report-status.sh <agent-id> <status> [task] [tool]}"
STATUS="${2:?Status required: active|idle|offline}"
TASK="${3:-}"
TOOL="${4:-}"

STATE_DIR="$(dirname "$0")/../state/agents"
mkdir -p "$STATE_DIR"

FILE="$STATE_DIR/${AGENT_ID}.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$FILE" << EOF
{
  "id": "${AGENT_ID}",
  "status": "${STATUS}",
  "currentTask": $([ -n "$TASK" ] && echo "\"$TASK\"" || echo "null"),
  "currentTool": $([ -n "$TOOL" ] && echo "\"$TOOL\"" || echo "null"),
  "lastActivity": "${TIMESTAMP}"
}
EOF

echo "Updated ${AGENT_ID} → ${STATUS}"
