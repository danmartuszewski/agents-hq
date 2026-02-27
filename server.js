const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const STATE_DIR = path.join(__dirname, 'state', 'agents');

// Agent registry: keyed by agentId, grows as agents report in
let agentRegistry = {};

// Per-agent tool timing: { agentId: { tool, startTime } }
const agentToolTimers = {};

// Inter-agent message log (ring buffer, max 200)
const messageLog = [];
const MAX_MESSAGES = 200;

// Consistent color per agent type
const typeColorMap = {};
const TYPE_COLORS = [
  '#f5a623', '#4a90d9', '#50e3c2', '#7b68ee', '#ff6b6b',
  '#4cd964', '#b8b8b8', '#e6a8d7', '#ff9f43', '#00d2d3',
  '#6c5ce7', '#fd79a8', '#00cec9', '#e17055', '#74b9ff'
];
let typeColorIndex = 0;

function getColorForType(agentType) {
  if (!typeColorMap[agentType]) {
    typeColorMap[agentType] = TYPE_COLORS[typeColorIndex % TYPE_COLORS.length];
    typeColorIndex++;
  }
  return typeColorMap[agentType];
}

function extractProjectName(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd) || 'unknown';
}

function getOrCreateAgent(agentId, agentType, cwd, sessionId) {
  let agent = agentRegistry[agentId];
  const project = extractProjectName(cwd);
  const color = getColorForType(agentType);
  const abbreviation = agentType.substring(0, 3).toUpperCase();

  if (agent) {
    // Only compare project/cwd when the incoming event actually provides cwd
    let projectChanged = false;
    if (cwd) {
      projectChanged = agent.project !== project || agent.cwd !== cwd;
      agent.project = project;
      agent.cwd = cwd;
    }
    if (sessionId) agent.sessionId = sessionId;
    return { agent, isNew: false, projectChanged };
  }

  agent = {
    agentId,
    agentType,
    project,
    cwd: cwd || '',
    sessionId: sessionId || '',
    color,
    abbreviation
  };

  agentRegistry[agentId] = agent;
  return { agent, isNew: true, projectChanged: false };
}

function getRegistryArray() {
  return Object.values(agentRegistry);
}

app.use(express.static('public'));
app.use(express.json());

// Serve agent registry
app.get('/api/config', (req, res) => {
  res.json(getRegistryArray());
});

// Get all agent states
app.get('/api/agents', (req, res) => {
  const states = readAllStates();
  res.json(states);
});

// Get message history
app.get('/api/messages', (req, res) => {
  res.json(messageLog);
});

// Update agent status via HTTP
app.post('/api/agent/:id/status', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { status, currentTask, currentTool, agentType, agentId, lastMessage, cwd, sessionId, hookEvent, toolDetail, toolName: postToolName } = req.body;
  // Sanitize for filename: keep uniqueness but make filesystem-safe
  const safeFilename = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(STATE_DIR, `${safeFilename}.json`);

  // Ensure agent exists in registry (auto-register if needed)
  // But don't create new entries for agents going offline - they're already gone
  const type = agentType || 'unknown';
  const existsInRegistry = !!agentRegistry[id];
  if (!existsInRegistry && status === 'offline') {
    return res.json({ ok: true, skipped: true });
  }
  // Don't register with "unknown" type if we have no type info and agent doesn't exist yet
  if (!existsInRegistry && type === 'unknown') {
    return res.json({ ok: true, skipped: true });
  }
  const { agent, isNew, projectChanged } = getOrCreateAgent(id, type, cwd, sessionId);

  // Tool timing
  let lastToolDuration = null;
  if (hookEvent === 'PreToolUse' && currentTool) {
    agentToolTimers[id] = { tool: currentTool, startTime: Date.now() };
  } else if (hookEvent === 'PostToolUse') {
    const timer = agentToolTimers[id];
    if (timer) {
      lastToolDuration = Date.now() - timer.startTime;
      delete agentToolTimers[id];
    }
  }

  let existing = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {}
  }

  // Session start tracking
  let sessionStart = existing.sessionStart || null;
  if (status === 'active' && !sessionStart) {
    sessionStart = new Date().toISOString();
  }
  if (status === 'offline') {
    sessionStart = null;
  }

  const updated = {
    ...existing,
    agentId: id,
    agentType: agent.agentType,
    project: agent.project,
    cwd: agent.cwd,
    sessionId: agent.sessionId,
    status: status || existing.status || 'offline',
    currentTask: currentTask !== undefined ? currentTask : existing.currentTask,
    currentTool: currentTool !== undefined ? currentTool : existing.currentTool,
    lastActivity: new Date().toISOString(),
    sessionStart
  };

  if (lastMessage) updated.lastMessage = lastMessage;
  if (toolDetail) updated.toolDetail = toolDetail;
  if (lastToolDuration !== null) updated.lastToolDuration = lastToolDuration;
  if (hookEvent === 'PostToolUse' && postToolName) updated.lastCompletedTool = postToolName;

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

  // Detect inter-agent messages (SendMessage via PreToolUse)
  if (hookEvent === 'PreToolUse' && currentTool === 'SendMessage' && toolDetail && toolDetail.meta) {
    const msgEntry = {
      time: new Date().toISOString(),
      fromId: id,
      toId: toolDetail.meta.recipient || '',
      type: toolDetail.meta.msgType || 'message',
      summary: toolDetail.meta.summary || '',
      content: (toolDetail.meta.content || '').substring(0, 300)
    };
    messageLog.push(msgEntry);
    if (messageLog.length > MAX_MESSAGES) messageLog.shift();

    broadcast({ type: 'agent_message', message: msgEntry });
  }

  // Broadcast updated config if agent is new or project changed
  if (isNew || projectChanged) {
    broadcast({ type: 'config_update', config: getRegistryArray() });
  }

  res.json(updated);
});

// Remove offline agents (keeps active/idle ones)
app.post('/api/cleanup/offline-agents', (req, res) => {
  const states = readAllStates();
  let removed = 0;
  for (const [id, state] of Object.entries(states)) {
    if (state.status === 'offline') {
      const filename = state._filename || `${id}.json`;
      try { fs.unlinkSync(path.join(STATE_DIR, filename)); } catch {}
      delete agentRegistry[id];
      removed++;
    }
  }
  if (removed > 0) {
    broadcast({ type: 'init', config: getRegistryArray(), states: readAllStates() });
  }
  res.json({ ok: true, removed });
});

// Remove inactive projects (all agents in a project are offline)
app.post('/api/cleanup/offline-projects', (req, res) => {
  const states = readAllStates();
  // Group by project
  const projects = {};
  for (const [id, state] of Object.entries(states)) {
    const agent = agentRegistry[id];
    const project = (agent && agent.project) || state.project || 'unknown';
    if (!projects[project]) projects[project] = [];
    projects[project].push({ id, state });
  }
  let removed = 0;
  for (const [project, agents] of Object.entries(projects)) {
    const allOffline = agents.every(a => a.state.status === 'offline');
    if (allOffline) {
      for (const { id, state } of agents) {
        const filename = state._filename || `${id}.json`;
        try { fs.unlinkSync(path.join(STATE_DIR, filename)); } catch {}
        delete agentRegistry[id];
        removed++;
      }
    }
  }
  if (removed > 0) {
    broadcast({ type: 'init', config: getRegistryArray(), states: readAllStates() });
  }
  res.json({ ok: true, removed });
});

// Clear all agent states
app.post('/api/reset', (req, res) => {
  if (fs.existsSync(STATE_DIR)) {
    for (const file of fs.readdirSync(STATE_DIR)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(STATE_DIR, file));
      }
    }
  }
  agentRegistry = {};
  Object.keys(typeColorMap).forEach(k => delete typeColorMap[k]);
  typeColorIndex = 0;
  messageLog.length = 0;
  broadcast({ type: 'init', config: [], states: {} });
  res.json({ ok: true });
});

function readAllStates() {
  const states = {};
  if (!fs.existsSync(STATE_DIR)) return states;
  for (const file of fs.readdirSync(STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf8'));
      const id = data.agentId || data.id;
      if (!id) continue; // skip malformed files
      data.agentId = id; // normalize
      data._filename = file; // preserve actual filename for writes
      states[id] = data;
    } catch (e) {
      // skip malformed files
    }
  }
  return states;
}

// WebSocket: send full state on connect, then diffs
wss.on('connection', (ws) => {
  const states = readAllStates();
  // Strip internal _filename before sending to client
  for (const s of Object.values(states)) delete s._filename;
  ws.send(JSON.stringify({ type: 'init', config: getRegistryArray(), states }));
  // Also send message history
  ws.send(JSON.stringify({ type: 'message_history', messages: messageLog }));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Watch state directory for changes
fs.mkdirSync(STATE_DIR, { recursive: true });

const watcher = chokidar.watch(STATE_DIR, {
  ignoreInitial: true,
  usePolling: true,
  interval: 300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
});

function handleFileChange(filePath) {
  if (!filePath.endsWith('.json')) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    broadcast({ type: 'update', agent: data });
  } catch (e) {
    // skip
  }
}

watcher.on('change', handleFileChange);
watcher.on('add', handleFileChange);
watcher.on('error', (err) => console.error('Watcher error:', err));

// Heartbeat sweep: infer idle/offline for agents with no explicit stop event
const IDLE_AFTER_MS = 60 * 1000;     // 60s no activity -> idle
const OFFLINE_AFTER_MS = 5 * 60 * 1000; // 5min no activity -> offline

setInterval(() => {
  const now = Date.now();
  const states = readAllStates();
  let changed = false;

  for (const [id, state] of Object.entries(states)) {
    if (state.status === 'offline') continue;
    const elapsed = now - new Date(state.lastActivity).getTime();

    let newStatus = null;
    if (elapsed >= OFFLINE_AFTER_MS && state.status !== 'offline') {
      newStatus = 'offline';
    } else if (elapsed >= IDLE_AFTER_MS && state.status === 'active') {
      newStatus = 'idle';
    }

    if (newStatus) {
      state.status = newStatus;
      state.currentTool = null;
      if (newStatus === 'offline') state.sessionStart = null;
      const filename = state._filename || `${id}.json`;
      delete state._filename;
      const filePath = path.join(STATE_DIR, filename);
      try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
        changed = true;
      } catch {}
    }
  }
}, 10000); // check every 10s

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agents HQ running at http://localhost:${PORT}`);
  console.log(`Hooks should POST to http://localhost:${PORT}/api/agent/:id/status`);
});
