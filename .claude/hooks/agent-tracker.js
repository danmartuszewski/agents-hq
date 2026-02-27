#!/usr/bin/env node
// Agent Tracker - receives Claude Code hook events via stdin JSON
// and POSTs agent state updates to the Agents HQ dashboard.
//
// Works for both main sessions (no agent_id) and subagents.
// Main sessions use session_id as identity and "lead" as type.

const http = require('http');
const fs = require('fs');
const readline = require('readline');

const DASHBOARD_URL = process.env.AGENTS_HQ_URL || 'http://localhost:3141';
const HOOK_EVENT = process.argv[2] || '';

function parseTranscriptTools(transcriptPath) {
  return new Promise((resolve) => {
    const tools = [];
    if (!transcriptPath) return resolve(tools);
    // Expand ~ to home dir
    const resolved = transcriptPath.replace(/^~/, process.env.HOME || '');
    let stream;
    try {
      stream = fs.createReadStream(resolved, { encoding: 'utf8' });
    } catch {
      return resolve(tools);
    }
    stream.on('error', () => resolve(tools));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') return;
        const content = (obj.message && obj.message.content) || [];
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const detail = extractToolDetail(block.name, block.input || {});
          tools.push({
            tool: block.name,
            timestamp: obj.timestamp || null,
            detail
          });
        }
      } catch {}
    });
    rl.on('close', () => resolve(tools));
  });
}

function extractToolDetail(toolName, toolInput) {
  if (!toolName) return { summary: '', meta: {} };

  switch (toolName) {
    case 'SendMessage': {
      const recipient = toolInput.recipient || toolInput.target_agent_id || '';
      const msgType = toolInput.type || 'message';
      const content = (toolInput.content || '').substring(0, 300);
      const summary = toolInput.summary || content.substring(0, 80);
      return {
        summary: `${msgType} -> ${recipient}: ${summary}`.substring(0, 120),
        meta: { recipient, msgType, content, summary }
      };
    }
    case 'TaskCreate': {
      const subject = (toolInput.subject || '').substring(0, 100);
      const desc = (toolInput.description || '').substring(0, 200);
      return {
        summary: `Create: ${subject}`.substring(0, 120),
        meta: { subject, description: desc }
      };
    }
    case 'TaskUpdate': {
      const taskId = toolInput.taskId || '';
      const status = toolInput.status || '';
      return {
        summary: `Update task ${taskId}${status ? ': ' + status : ''}`.substring(0, 120),
        meta: { taskId, status }
      };
    }
    case 'Read': {
      const fp = toolInput.file_path || '';
      return { summary: fp.substring(0, 120), meta: { file_path: fp } };
    }
    case 'Write': {
      const fp = toolInput.file_path || '';
      return { summary: `Write ${fp}`.substring(0, 120), meta: { file_path: fp } };
    }
    case 'Edit': {
      const fp = toolInput.file_path || '';
      return { summary: `Edit ${fp}`.substring(0, 120), meta: { file_path: fp } };
    }
    case 'Bash': {
      const cmd = (toolInput.command || '').substring(0, 120);
      return { summary: cmd, meta: { command: cmd } };
    }
    case 'Grep': {
      const pattern = toolInput.pattern || '';
      const gPath = toolInput.path || '.';
      return {
        summary: `grep "${pattern}" ${gPath}`.substring(0, 120),
        meta: { pattern, path: gPath }
      };
    }
    case 'Glob': {
      const pattern = toolInput.pattern || '';
      return { summary: `glob ${pattern}`.substring(0, 120), meta: { pattern } };
    }
    case 'WebSearch': {
      const query = toolInput.query || '';
      return { summary: `Search: ${query}`.substring(0, 120), meta: { query } };
    }
    case 'WebFetch': {
      const url = toolInput.url || '';
      return { summary: `Fetch: ${url}`.substring(0, 120), meta: { url } };
    }
    case 'Task': {
      const desc = toolInput.description || toolInput.prompt || '';
      return { summary: `Subagent: ${desc}`.substring(0, 120), meta: { description: desc } };
    }
    default: {
      const fallback = (
        toolInput.command ||
        toolInput.pattern ||
        toolInput.file_path ||
        toolInput.query ||
        toolInput.prompt ||
        toolInput.description ||
        ''
      ).substring(0, 120);
      return { summary: fallback, meta: {} };
    }
  }
}

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
  const cwd = data.cwd || process.cwd();
  const sessionId = data.session_id || '';
  const toolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  const lastMsg = (data.last_assistant_message || '').substring(0, 200);
  const transcriptPath = data.agent_transcript_path || '';

  if (!agentId) process.exit(0);

  const safeId = encodeURIComponent(agentId);

  function sendBody(body) {
    const url = new URL(`/api/agent/${safeId}/status`, DASHBOARD_URL);
    const payload = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }

  let body;

  switch (HOOK_EVENT) {
    case 'SubagentStart':
      body = {
        status: 'active',
        currentTask: 'Starting up',
        currentTool: null,
        agentId,
        cwd,
        sessionId,
        hookEvent: 'SubagentStart'
      };
      if (agentType) body.agentType = agentType;
      sendBody(body);
      break;

    case 'SubagentStop':
      // Parse transcript for tool history before sending offline
      parseTranscriptTools(transcriptPath).then((tools) => {
        body = {
          status: 'offline',
          currentTask: null,
          currentTool: null,
          lastMessage: lastMsg,
          cwd,
          sessionId,
          hookEvent: 'SubagentStop'
        };
        if (agentType) body.agentType = agentType;
        if (tools.length > 0) body.transcriptTools = tools;
        sendBody(body);
      });
      break;

    case 'PreToolUse': {
      const detail = extractToolDetail(toolName, toolInput);
      body = {
        status: 'active',
        currentTool: toolName,
        currentTask: detail.summary || undefined,
        toolDetail: detail,
        hookEvent: 'PreToolUse',
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      sendBody(body);
      break;
    }

    case 'PostToolUse':
      body = {
        status: 'active',
        currentTool: null,
        toolName,
        hookEvent: 'PostToolUse',
        cwd,
        sessionId
      };
      if (agentType) body.agentType = agentType;
      sendBody(body);
      break;

    default:
      process.exit(0);
  }
});
