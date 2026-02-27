#!/bin/bash
# Usage: ./report-status.sh <agent-id> <status> [task] [tool] [agent-type] [cwd]
# Example: ./report-status.sh c-001 active "Reviewing strategy" "Read" coder /projects/my-api

AGENT_ID="${1:?Usage: report-status.sh <agent-id> <status> [task] [tool] [agent-type] [cwd]}"
STATUS="${2:?Status required: active|idle|offline}"
TASK="${3:-}"
TOOL="${4:-}"
AGENT_TYPE="${5:-unknown}"
CWD="${6:-}"

STATE_DIR="$(dirname "$0")/../state/agents"
mkdir -p "$STATE_DIR"

FILE="$STATE_DIR/${AGENT_ID}.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Extract project name from cwd (last path segment)
if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
else
  PROJECT="unknown"
fi

cat > "$FILE" << EOF
{
  "agentId": "${AGENT_ID}",
  "agentType": "${AGENT_TYPE}",
  "project": "${PROJECT}",
  "cwd": "${CWD}",
  "sessionId": "",
  "status": "${STATUS}",
  "currentTask": $([ -n "$TASK" ] && echo "\"$TASK\"" || echo "null"),
  "currentTool": $([ -n "$TOOL" ] && echo "\"$TOOL\"" || echo "null"),
  "lastActivity": "${TIMESTAMP}"
}
EOF

echo "Updated ${AGENT_ID} (${AGENT_TYPE}/${PROJECT}) → ${STATUS}"
