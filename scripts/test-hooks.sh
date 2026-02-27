#!/bin/bash
# Extended test of the hook integration - simulates a realistic multi-agent session.
# Run this while the dashboard server is running.

DASHBOARD_URL="${AGENTS_HQ_URL:-http://localhost:3000}"
HOOKS="$(dirname "$0")/../.claude/hooks/agent-tracker.js"

CWD_1="/home/user/projects/my-api"
CWD_2="/home/user/projects/frontend-app"

send() {
  echo "$2" | node "$HOOKS" "$1"
}

echo "Testing hook integration against $DASHBOARD_URL"
echo "Simulating agents across two projects: my-api and frontend-app"
echo ""

# === Phase 1: Team boots up ===
echo "--- Phase 1: Team starting up ---"

echo "  [+] researcher starting (my-api)..."
send SubagentStart "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"cwd\":\"$CWD_1\",\"session_id\":\"sess-001\"}"
sleep 1

echo "  [+] planner starting (my-api)..."
send SubagentStart "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"cwd\":\"$CWD_1\",\"session_id\":\"sess-001\"}"
sleep 1

echo "  [+] coder starting (my-api)..."
send SubagentStart "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"cwd\":\"$CWD_1\",\"session_id\":\"sess-001\"}"
sleep 1

echo "  [+] tester starting (my-api)..."
send SubagentStart "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"cwd\":\"$CWD_1\",\"session_id\":\"sess-001\"}"
sleep 1

echo "  [+] reviewer starting (my-api)..."
send SubagentStart "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"cwd\":\"$CWD_1\",\"session_id\":\"sess-001\"}"
sleep 1

echo "  [+] researcher #2 starting (frontend-app)..."
send SubagentStart "{\"agent_id\":\"r-002\",\"agent_type\":\"researcher\",\"cwd\":\"$CWD_2\",\"session_id\":\"sess-002\"}"
sleep 1

echo "  [+] coder #2 starting (frontend-app)..."
send SubagentStart "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"cwd\":\"$CWD_2\",\"session_id\":\"sess-002\"}"
sleep 1

# === Phase 2: Research phase ===
echo ""
echo "--- Phase 2: Research phase ---"

echo "  [*] researcher: WebSearch - auth libraries"
send PreToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"tool_input\":{\"query\":\"best authentication libraries Node.js 2025\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] planner: Read - existing auth module"
send PreToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/src/auth/index.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] researcher #2: WebSearch - React patterns"
send PreToolUse "{\"agent_id\":\"r-002\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"tool_input\":{\"query\":\"React authentication patterns 2025\"},\"cwd\":\"$CWD_2\"}"
sleep 1

echo "  [*] researcher: WebSearch done"
send PostToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] researcher: Read - package.json"
send PreToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"package.json\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] planner: Read done"
send PostToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] planner: Grep - auth usage patterns"
send PreToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"authenticate|authorize\",\"file_path\":\"/src\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder: Read - config files"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/src/config/database.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] researcher: Read done"
send PostToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] researcher #2: WebSearch done"
send PostToolUse "{\"agent_id\":\"r-002\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"cwd\":\"$CWD_2\"}"
sleep 0.5

# === Phase 3: Implementation ===
echo ""
echo "--- Phase 3: Implementation ---"

echo "  [*] coder: Write - new auth middleware"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/src/middleware/auth.ts\",\"description\":\"JWT authentication middleware\"},\"cwd\":\"$CWD_1\"}"
sleep 2

echo "  [*] coder #2: Write - auth context"
send PreToolUse "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/src/contexts/AuthContext.tsx\",\"description\":\"React auth context provider\"},\"cwd\":\"$CWD_2\"}"
sleep 1

echo "  [*] researcher: WebSearch - JWT best practices"
send PreToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"tool_input\":{\"query\":\"JWT token rotation best practices security\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] planner: Grep done"
send PostToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Grep\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] planner: Read - route definitions"
send PreToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/src/routes/api.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder: Write done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Edit - update route handler"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/src/routes/api.ts\",\"description\":\"Add auth middleware to protected routes\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] reviewer: Read - new auth middleware"
send PreToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/src/middleware/auth.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] researcher: WebSearch done"
send PostToolUse "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"tool_name\":\"WebSearch\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [-] researcher finished"
send SubagentStop "{\"agent_id\":\"r-001\",\"agent_type\":\"researcher\",\"last_assistant_message\":\"Researched JWT auth patterns. Recommend using jose library with RS256 signing and 15-min token expiry with refresh tokens.\",\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder: Edit done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Write - user model updates"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/src/models/user.ts\",\"description\":\"Add refresh token fields to User model\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder #2: Write done"
send PostToolUse "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"cwd\":\"$CWD_2\"}"
sleep 0.5

echo "  [*] planner: Read done"
send PostToolUse "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [-] planner finished"
send SubagentStop "{\"agent_id\":\"p-001\",\"agent_type\":\"planner\",\"last_assistant_message\":\"Identified 12 routes needing auth protection. Created implementation plan with middleware chain order.\",\"cwd\":\"$CWD_1\"}"
sleep 1

# === Phase 4: Testing ===
echo ""
echo "--- Phase 4: Testing ---"

echo "  [*] coder: Write done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Write - test file"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/src/__tests__/auth.test.ts\",\"description\":\"Auth middleware unit tests\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] tester: Bash - run existing tests first"
send PreToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test -- --coverage\"},\"cwd\":\"$CWD_1\"}"
sleep 2

echo "  [*] reviewer: Read done"
send PostToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] reviewer: Grep - security patterns"
send PreToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"password|secret|key\",\"file_path\":\"/src\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder #2: Edit - login component"
send PreToolUse "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/src/components/Login.tsx\",\"description\":\"Add auth context to login form\"},\"cwd\":\"$CWD_2\"}"
sleep 1

echo "  [*] coder: Write done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Write\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] tester: Bash done"
send PostToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] tester: Bash - run auth tests"
send PreToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test -- auth.test.ts --verbose\"},\"cwd\":\"$CWD_1\"}"
sleep 2

echo "  [*] reviewer: Grep done"
send PostToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Grep\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] reviewer: Read - test results"
send PreToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/coverage/lcov-report/index.html\"},\"cwd\":\"$CWD_1\"}"
sleep 1

# === Phase 5: Fixes and iteration ===
echo ""
echo "--- Phase 5: Fixes ---"

echo "  [*] tester: Bash done"
send PostToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Edit - fix token validation bug"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/src/middleware/auth.ts\",\"description\":\"Fix token expiry check off-by-one error\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] coder #2: Edit done"
send PostToolUse "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"cwd\":\"$CWD_2\"}"
sleep 0.5

echo "  [*] tester: Bash - re-run failed tests"
send PreToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test -- auth.test.ts --bail\"},\"cwd\":\"$CWD_1\"}"
sleep 2

echo "  [*] coder: Edit done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Edit\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] reviewer: Read done"
send PostToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Bash - lint check"
send PreToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npx eslint src/middleware/auth.ts src/routes/api.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] tester: Bash done"
send PostToolUse "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"tool_name\":\"Bash\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [*] coder: Bash done"
send PostToolUse "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"tool_name\":\"Bash\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

# === Phase 6: Winding down ===
echo ""
echo "--- Phase 6: Agents finishing up ---"

echo "  [-] tester finished"
send SubagentStop "{\"agent_id\":\"t-001\",\"agent_type\":\"tester\",\"last_assistant_message\":\"All 28 tests passing. Coverage at 94%. Auth middleware fully tested including edge cases.\",\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [*] reviewer: Read - final review"
send PreToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/src/middleware/auth.ts\"},\"cwd\":\"$CWD_1\"}"
sleep 2

echo "  [*] reviewer: Read done"
send PostToolUse "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"tool_name\":\"Read\",\"cwd\":\"$CWD_1\"}"
sleep 0.5

echo "  [-] researcher #2 finished"
send SubagentStop "{\"agent_id\":\"r-002\",\"agent_type\":\"researcher\",\"last_assistant_message\":\"Found optimal auth patterns for React SPA. Recommend using Auth0 SDK with PKCE flow.\",\"cwd\":\"$CWD_2\"}"
sleep 1

echo "  [-] reviewer finished"
send SubagentStop "{\"agent_id\":\"v-001\",\"agent_type\":\"reviewer\",\"last_assistant_message\":\"Code review complete. No security issues found. Approved for merge.\",\"cwd\":\"$CWD_1\"}"
sleep 1

echo "  [-] coder #2 finished"
send SubagentStop "{\"agent_id\":\"c-002\",\"agent_type\":\"coder\",\"last_assistant_message\":\"Implemented React auth context, login/logout flow, and protected route wrapper.\",\"cwd\":\"$CWD_2\"}"
sleep 1

echo "  [-] coder finished"
send SubagentStop "{\"agent_id\":\"c-001\",\"agent_type\":\"coder\",\"last_assistant_message\":\"Implemented JWT auth middleware, updated 12 routes, added refresh token support. All tests passing.\",\"cwd\":\"$CWD_1\"}"

echo ""
echo "Done. All agents finished across 2 projects."
echo "Check the dashboard at $DASHBOARD_URL"
