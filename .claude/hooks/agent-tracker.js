#!/usr/bin/env node
// Agent Tracker - receives Claude Code hook events via stdin JSON
// and POSTs agent state updates to the Agents HQ dashboard.
//
// Works for both main sessions (no agent_id) and subagents.
// Main sessions use session_id as identity and "lead" as type.

const http = require('http');

const DASHBOARD_URL = process.env.AGENTS_HQ_URL || 'http://localhost:3000';
const HOOK_EVENT = process.argv[2] || '';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const isSubagent = !!data.agent_id;
  const agentType = data.agent_type || (isSubagent ? null : 'lead');
  const agentId = data.agent_id || data.session_id || '';
  // Hooks run in the project directory, so process.cwd() is a reliable fallback
  const cwd = data.cwd || process.cwd();
  const sessionId = data.session_id || '';
  const toolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  const lastMsg = (data.last_assistant_message || '').substring(0, 200);

  if (!agentId) process.exit(0);

  // URL-encode the raw ID to make it path-safe without losing uniqueness
  const safeId = encodeURIComponent(agentId);

  let body;

  switch (HOOK_EVENT) {
    case 'SubagentStart':
      body = {
        status: 'active',
        currentTask: 'Starting up',
        currentTool: null,
        agentId,
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      break;

    case 'SubagentStop':
      body = {
        status: 'offline',
        currentTask: null,
        currentTool: null,
        lastMessage: lastMsg,
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      break;

    case 'PreToolUse':
      // Extract a short task description from tool_input
      const taskSummary = (
        toolInput.command ||
        toolInput.pattern ||
        toolInput.file_path ||
        toolInput.query ||
        toolInput.prompt ||
        toolInput.description ||
        ''
      ).substring(0, 120);

      body = {
        status: 'active',
        currentTool: toolName,
        currentTask: taskSummary || undefined,
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      break;

    case 'PostToolUse':
      body = {
        status: 'active',
        currentTool: null,
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      break;

    default:
      process.exit(0);
  }

  // POST to dashboard using agent_id (or session_id for main) as the URL param
  const url = new URL(`/api/agent/${safeId}/status`, DASHBOARD_URL);
  const payload = JSON.stringify(body);

  const req = http.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  });

  req.on('error', () => {}); // silently ignore connection errors
  req.write(payload);
  req.end(() => process.exit(0));

  // Timeout safety - don't block Claude Code
  setTimeout(() => process.exit(0), 2000);
});
