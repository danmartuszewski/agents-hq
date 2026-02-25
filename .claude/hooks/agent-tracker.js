#!/usr/bin/env node
// Agent Tracker - receives Claude Code hook events via stdin JSON
// and POSTs agent state updates to the Agents HQ dashboard.

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

  const agentType = data.agent_type || 'unknown';
  const agentId = data.agent_id || data.session_id || '';
  const toolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  const lastMsg = (data.last_assistant_message || '').substring(0, 200);

  // Use agent_type as readable dashboard ID
  const safeId = agentType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

  let body;

  switch (HOOK_EVENT) {
    case 'SubagentStart':
      body = {
        status: 'active',
        currentTask: 'Starting up',
        currentTool: null,
        agentType,
        agentId
      };
      break;

    case 'SubagentStop':
      body = {
        status: 'offline',
        currentTask: null,
        currentTool: null,
        lastMessage: lastMsg
      };
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
        currentTask: taskSummary || undefined
      };
      break;

    case 'PostToolUse':
      body = {
        status: 'active',
        currentTool: null
      };
      break;

    default:
      process.exit(0);
  }

  // POST to dashboard
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
