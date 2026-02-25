#!/bin/bash
# Routes Claude Code hook events to the Node.js tracker
exec node "$(dirname "$0")/agent-tracker.js" "$@"
