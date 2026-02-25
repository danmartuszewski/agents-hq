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
const CONFIG_PATH = path.join(__dirname, 'config', 'agents.json');

// Dynamic config: starts from file, grows as new agents appear
let dynamicConfig = [];

// Color palette for dynamically registered agents
const DYNAMIC_COLORS = [
  '#f5a623', '#4a90d9', '#50e3c2', '#7b68ee', '#ff6b6b',
  '#4cd964', '#b8b8b8', '#e6a8d7', '#ff9f43', '#00d2d3',
  '#6c5ce7', '#fd79a8', '#00cec9', '#e17055', '#74b9ff'
];
let colorIndex = 0;

function loadConfig() {
  try {
    dynamicConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    dynamicConfig = [];
  }
}

function getOrCreateAgent(id, agentType) {
  let agent = dynamicConfig.find(a => a.id === id);
  if (agent) return { agent, isNew: false };

  // Auto-register new agent
  const name = agentType || id;
  const abbreviation = name.substring(0, 3).toUpperCase();
  const color = DYNAMIC_COLORS[colorIndex % DYNAMIC_COLORS.length];
  colorIndex++;

  // Assign grid position based on count
  const existing = dynamicConfig.length;
  const row = Math.floor(existing / 4);
  const col = (existing % 4) * 3 + 2;

  agent = {
    id,
    name: `@${name}`,
    abbreviation,
    department: 'SUBAGENT',
    color,
    gridPosition: { row, col },
    dynamic: true
  };

  dynamicConfig.push(agent);
  return { agent, isNew: true };
}

app.use(express.static('public'));
app.use(express.json());

// Serve agent config (dynamic)
app.get('/api/config', (req, res) => {
  res.json(dynamicConfig);
});

// Get all agent states
app.get('/api/agents', (req, res) => {
  const states = readAllStates();
  res.json(states);
});

// Update agent status via HTTP
app.post('/api/agent/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, currentTask, currentTool, agentType, agentId, lastMessage } = req.body;
  const filePath = path.join(STATE_DIR, `${id}.json`);

  // Ensure agent exists in config (auto-register if needed)
  const { agent, isNew } = getOrCreateAgent(id, agentType);

  let existing = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {}
  }

  const updated = {
    ...existing,
    id,
    status: status || existing.status || 'offline',
    currentTask: currentTask !== undefined ? currentTask : existing.currentTask,
    currentTool: currentTool !== undefined ? currentTool : existing.currentTool,
    lastActivity: new Date().toISOString()
  };

  if (agentId) updated.claudeAgentId = agentId;
  if (lastMessage) updated.lastMessage = lastMessage;

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

  // If this is a newly registered agent, broadcast the updated config
  if (isNew) {
    broadcast({ type: 'config_update', config: dynamicConfig });
  }

  res.json(updated);
});

// Clear all agent states (useful for fresh starts)
app.post('/api/reset', (req, res) => {
  if (fs.existsSync(STATE_DIR)) {
    for (const file of fs.readdirSync(STATE_DIR)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(STATE_DIR, file));
      }
    }
  }
  // Reload config from file (drops dynamic agents)
  loadConfig();
  colorIndex = 0;
  broadcast({ type: 'init', config: dynamicConfig, states: {} });
  res.json({ ok: true });
});

function readAllStates() {
  const states = {};
  if (!fs.existsSync(STATE_DIR)) return states;
  for (const file of fs.readdirSync(STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf8'));
      states[data.id] = data;
    } catch (e) {
      // skip malformed files
    }
  }
  return states;
}

// WebSocket: send full state on connect, then diffs
wss.on('connection', (ws) => {
  const states = readAllStates();
  ws.send(JSON.stringify({ type: 'init', config: dynamicConfig, states }));
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

// Init
loadConfig();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agents HQ running at http://localhost:${PORT}`);
  console.log(`Hooks should POST to http://localhost:${PORT}/api/agent/:id/status`);
});
