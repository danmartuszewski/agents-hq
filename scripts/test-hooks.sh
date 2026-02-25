#!/bin/bash
# Extended test of the hook integration - simulates a realistic multi-agent session.
# Run this while the dashboard server is running.

DASHBOARD_URL="${AGENTS_HQ_URL:-http://localhost:3000}"
HOOKS="$(dirname "$0")/../.claude/hooks/agent-tracker.js"

send() {
  echo "$2" | node "$HOOKS" "$1"
}

echo "Testing hook integration against $DASHBOARD_URL"
echo "Simulating a team working on a feature branch..."
echo ""

# === Phase 1: Team boots up ===
echo "--- Phase 1: Team starting up ---"

echo "  [+] researcher starting..."
send SubagentStart '{"agent_id":"r-001","agent_type":"researcher"}'
sleep 1

echo "  [+] planner starting..."
send SubagentStart '{"agent_id":"p-001","agent_type":"planner"}'
sleep 1

echo "  [+] coder starting..."
send SubagentStart '{"agent_id":"c-001","agent_type":"coder"}'
sleep 1

echo "  [+] tester starting..."
send SubagentStart '{"agent_id":"t-001","agent_type":"tester"}'
sleep 1

echo "  [+] reviewer starting..."
send SubagentStart '{"agent_id":"v-001","agent_type":"reviewer"}'
sleep 1

# === Phase 2: Research phase ===
echo ""
echo "--- Phase 2: Research phase ---"

echo "  [*] researcher: WebSearch - auth libraries"
send PreToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"WebSearch","tool_input":{"query":"best authentication libraries Node.js 2025"}}'
sleep 1

echo "  [*] planner: Read - existing auth module"
send PreToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Read","tool_input":{"file_path":"/src/auth/index.ts"}}'
sleep 1

echo "  [*] researcher: WebSearch done"
send PostToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"WebSearch"}'
sleep 0.5

echo "  [*] researcher: Read - package.json"
send PreToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"Read","tool_input":{"file_path":"package.json"}}'
sleep 1

echo "  [*] planner: Read done"
send PostToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Read"}'
sleep 0.5

echo "  [*] planner: Grep - auth usage patterns"
send PreToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Grep","tool_input":{"pattern":"authenticate|authorize","file_path":"/src"}}'
sleep 1

echo "  [*] coder: Read - config files"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Read","tool_input":{"file_path":"/src/config/database.ts"}}'
sleep 1

echo "  [*] researcher: Read done"
send PostToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"Read"}'
sleep 0.5

# === Phase 3: Implementation ===
echo ""
echo "--- Phase 3: Implementation ---"

echo "  [*] coder: Write - new auth middleware"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write","tool_input":{"file_path":"/src/middleware/auth.ts","description":"JWT authentication middleware"}}'
sleep 2

echo "  [*] researcher: WebSearch - JWT best practices"
send PreToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"WebSearch","tool_input":{"query":"JWT token rotation best practices security"}}'
sleep 1

echo "  [*] planner: Grep done"
send PostToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Grep"}'
sleep 0.5

echo "  [*] planner: Read - route definitions"
send PreToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Read","tool_input":{"file_path":"/src/routes/api.ts"}}'
sleep 1

echo "  [*] coder: Write done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write"}'
sleep 0.5

echo "  [*] coder: Edit - update route handler"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Edit","tool_input":{"file_path":"/src/routes/api.ts","description":"Add auth middleware to protected routes"}}'
sleep 1

echo "  [*] reviewer: Read - new auth middleware"
send PreToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read","tool_input":{"file_path":"/src/middleware/auth.ts"}}'
sleep 1

echo "  [*] researcher: WebSearch done"
send PostToolUse '{"agent_id":"r-001","agent_type":"researcher","tool_name":"WebSearch"}'
sleep 0.5

echo "  [-] researcher finished"
send SubagentStop '{"agent_id":"r-001","agent_type":"researcher","last_assistant_message":"Researched JWT auth patterns. Recommend using jose library with RS256 signing and 15-min token expiry with refresh tokens."}'
sleep 1

echo "  [*] coder: Edit done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Edit"}'
sleep 0.5

echo "  [*] coder: Write - user model updates"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write","tool_input":{"file_path":"/src/models/user.ts","description":"Add refresh token fields to User model"}}'
sleep 1

echo "  [*] planner: Read done"
send PostToolUse '{"agent_id":"p-001","agent_type":"planner","tool_name":"Read"}'
sleep 0.5

echo "  [-] planner finished"
send SubagentStop '{"agent_id":"p-001","agent_type":"planner","last_assistant_message":"Identified 12 routes needing auth protection. Created implementation plan with middleware chain order."}'
sleep 1

# === Phase 4: Testing ===
echo ""
echo "--- Phase 4: Testing ---"

echo "  [*] coder: Write done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write"}'
sleep 0.5

echo "  [*] coder: Write - test file"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write","tool_input":{"file_path":"/src/__tests__/auth.test.ts","description":"Auth middleware unit tests"}}'
sleep 1

echo "  [*] tester: Bash - run existing tests first"
send PreToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash","tool_input":{"command":"npm test -- --coverage"}}'
sleep 2

echo "  [*] reviewer: Read done"
send PostToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read"}'
sleep 0.5

echo "  [*] reviewer: Grep - security patterns"
send PreToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Grep","tool_input":{"pattern":"password|secret|key","file_path":"/src"}}'
sleep 1

echo "  [*] coder: Write done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Write"}'
sleep 0.5

echo "  [*] tester: Bash done"
send PostToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash"}'
sleep 0.5

echo "  [*] tester: Bash - run auth tests"
send PreToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash","tool_input":{"command":"npm test -- auth.test.ts --verbose"}}'
sleep 2

echo "  [*] reviewer: Grep done"
send PostToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Grep"}'
sleep 0.5

echo "  [*] reviewer: Read - test results"
send PreToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read","tool_input":{"file_path":"/coverage/lcov-report/index.html"}}'
sleep 1

# === Phase 5: Fixes and iteration ===
echo ""
echo "--- Phase 5: Fixes ---"

echo "  [*] tester: Bash done"
send PostToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash"}'
sleep 0.5

echo "  [*] coder: Edit - fix token validation bug"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Edit","tool_input":{"file_path":"/src/middleware/auth.ts","description":"Fix token expiry check off-by-one error"}}'
sleep 1

echo "  [*] tester: Bash - re-run failed tests"
send PreToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash","tool_input":{"command":"npm test -- auth.test.ts --bail"}}'
sleep 2

echo "  [*] coder: Edit done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Edit"}'
sleep 0.5

echo "  [*] reviewer: Read done"
send PostToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read"}'
sleep 0.5

echo "  [*] coder: Bash - lint check"
send PreToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Bash","tool_input":{"command":"npx eslint src/middleware/auth.ts src/routes/api.ts"}}'
sleep 1

echo "  [*] tester: Bash done"
send PostToolUse '{"agent_id":"t-001","agent_type":"tester","tool_name":"Bash"}'
sleep 0.5

echo "  [*] coder: Bash done"
send PostToolUse '{"agent_id":"c-001","agent_type":"coder","tool_name":"Bash"}'
sleep 0.5

# === Phase 6: Winding down ===
echo ""
echo "--- Phase 6: Agents finishing up ---"

echo "  [-] tester finished"
send SubagentStop '{"agent_id":"t-001","agent_type":"tester","last_assistant_message":"All 28 tests passing. Coverage at 94%. Auth middleware fully tested including edge cases."}'
sleep 1

echo "  [*] reviewer: Read - final review"
send PreToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read","tool_input":{"file_path":"/src/middleware/auth.ts"}}'
sleep 2

echo "  [*] reviewer: Read done"
send PostToolUse '{"agent_id":"v-001","agent_type":"reviewer","tool_name":"Read"}'
sleep 0.5

echo "  [-] reviewer finished"
send SubagentStop '{"agent_id":"v-001","agent_type":"reviewer","last_assistant_message":"Code review complete. No security issues found. Approved for merge."}'
sleep 1

echo "  [-] coder finished"
send SubagentStop '{"agent_id":"c-001","agent_type":"coder","last_assistant_message":"Implemented JWT auth middleware, updated 12 routes, added refresh token support. All tests passing."}'

echo ""
echo "Done. All agents finished."
echo "Check the dashboard at $DASHBOARD_URL"
