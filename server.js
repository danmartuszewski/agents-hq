const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { mountVoice } = require('./voice');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => requestAllowed(req) });

const STATE_DIR = path.join(__dirname, 'state', 'agents');
const ACTIVITY_LOG_PATH = path.join(__dirname, 'state', 'activity-log.json');
const MAX_ACTIVITY_LOG = 500;

// Secrets the user sets from the UI (e.g. the OpenAI key). Stored server-side in
// a gitignored local file, never sent back to the browser (only a masked hint).
const SECRETS_PATH = path.join(__dirname, 'state', 'secrets.json');
let runtimeSecrets = {};
try { runtimeSecrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) || {}; } catch { runtimeSecrets = {}; }
function saveSecrets() {
  try { fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true }); } catch {}
  try { fs.writeFileSync(SECRETS_PATH, JSON.stringify(runtimeSecrets), { mode: 0o600 }); } catch {}
}
// UI-set key takes precedence; the env var still works as a fallback.
function getOpenAIKey() { return runtimeSecrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY || ''; }
function maskKey(k) { return k ? `${k.slice(0, 3)}…${k.slice(-4)}` : ''; }

// Agent registry: keyed by agentId, grows as agents report in
let agentRegistry = {};

// Voice-bridge sweep-proof routing records. Held in server memory (not in state
// files) so the 5-minute offline sweep — which clears finishedTurn/finishedSince
// from idle sessions, exactly the away-from-keyboard case — cannot erase them.
// Memory-only across restarts is accepted (documented in the plan).
let lastSpokenAgent = null;    // { agentId, at }   — set when a summary starts playing
let lastFinishedAgent = null;  // { agentId, at, summaryText } — set at Stop-hook ingest
function getVoiceRecords() { return { lastSpokenAgent, lastFinishedAgent }; }

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

// Persistent global activity log
let activityLog = [];
function loadActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_LOG_PATH)) {
      activityLog = JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8'));
    }
  } catch { activityLog = []; }
}
function saveActivityLog() {
  try { fs.writeFileSync(ACTIVITY_LOG_PATH, JSON.stringify(activityLog)); } catch {}
}
function appendActivityLog(entry) {
  activityLog.push(entry);
  if (activityLog.length > MAX_ACTIVITY_LOG) activityLog.splice(0, activityLog.length - MAX_ACTIVITY_LOG);
  saveActivityLog();
}
loadActivityLog();

function rebuildRegistryFromDisk() {
  if (!fs.existsSync(STATE_DIR)) return;
  for (const file of fs.readdirSync(STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf8'));
      const id = data.agentId || data.id;
      const type = data.agentType;
      if (!id || !type) continue;
      getOrCreateAgent(id, type, data.cwd, data.sessionId);
    } catch {}
  }
}
rebuildRegistryFromDisk();

// Append to per-agent event log stored in state file
function appendAgentEventLog(filePath, entry) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return; }
  if (!data.eventLog) data.eventLog = [];
  data.eventLog.push(entry);
  if (data.eventLog.length > 200) data.eventLog.splice(0, data.eventLog.length - 200);
  // Also persist tool counts
  if (entry.tool) {
    if (!data.toolCounts) data.toolCounts = {};
    data.toolCounts[entry.tool] = (data.toolCounts[entry.tool] || 0) + 1;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Same-browser guard for the whole dashboard (HTTP + WebSocket). A foreign
// Origin means another site is driving the dashboard from your browser (CSRF);
// a non-loopback Host while bound to loopback means DNS rebinding. When HOST is
// deliberately set to a LAN address the Host check is skipped — the name the
// dashboard is reached by can't be known — but cross-site requests stay blocked.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const BOUND_LOOPBACK = LOOPBACK_HOSTS.has((process.env.HOST || '127.0.0.1').toLowerCase());
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}
function requestAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (BOUND_LOOPBACK && !LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== host) return false; } catch { return false; }
  }
  return true;
}
app.use((req, res, next) => {
  if (requestAllowed(req)) return next();
  res.status(403).json({ error: 'forbidden-origin' });
});

// Always revalidate static assets (ETag makes this cheap) so a redeploy of
// app.js / style.css is picked up immediately instead of a stale cached copy.
app.use(express.static('public', { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
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
  const { status, currentTask, currentTool, agentType, agentId, lastMessage, cwd, sessionId, parentAgentId, hookEvent, toolDetail, toolName: postToolName, transcriptTools, awaitingUser, awaitingMessage, finishedMessage, voiceTurn } = req.body;
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
    delete agentToolTimers[id];
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

  if (parentAgentId) updated.parentAgentId = parentAgentId;
  if (lastMessage) updated.lastMessage = lastMessage;
  if (toolDetail) updated.toolDetail = toolDetail;
  if (lastToolDuration !== null) updated.lastToolDuration = lastToolDuration;
  if (hookEvent === 'PostToolUse' && postToolName) updated.lastCompletedTool = postToolName;

  // Track whether Claude's last turn ended (Stop hook). Used to distinguish
  // "needs attention" (permission/question mid-task) from "finished + idle wait"
  // when a Notification fires.
  if (hookEvent === 'Stop') {
    updated.finishedTurn = true;
    updated.finishedSince = new Date().toISOString();
    // Final assistant text for the client's text-to-speech queue.
    if (finishedMessage) updated.finishedMessage = finishedMessage;
    // Sweep-proof voice routing record (survives the offline sweep that clears
    // the state-file flags for idle sessions).
    lastFinishedAgent = { agentId: id, at: Date.now(), summaryText: (finishedMessage || '').slice(0, 4000) };
    // Pending-queue fallback: normally queued voice utterances flush when this
    // agent's spoken summary finishes playing (advanceCurrent). If no summary
    // will ever play (speech disabled, no tab open), flush after a grace period —
    // but never while a summary for it is still queued/playing, which the
    // injected turn's UserPromptSubmit would drop.
    if (voice.isEnabled()) setTimeout(() => {
      // Only a real queued/playing SUMMARY counts as busy: protected items
      // (voice-system lines, replays, click-listens) are drop-exempt and never
      // trigger the flush on completion, so counting them would strand the
      // pending utterance until its TTL.
      const isSummary = (i) => i && i.agentId === id && !i.voiceSystem && !i.replay && !i.userListen;
      const busyTts = isSummary(ttsCurrentItem) || ttsQueue.some(isSummary);
      if (!busyTts) { try { voice.flushPending(id); } catch {} }
    }, 45000);
    // Voice-stale badge: a voice-injected turn landed that the still-open TUI's
    // in-memory conversation never saw. Set the flag; it is cleared on reopen or
    // manual dismiss, not by later events (see the escalation branch below).
    if (voiceTurn === true) updated.voiceStale = true;
  } else if (
    hookEvent === 'PreToolUse' ||
    hookEvent === 'UserPromptSubmit' ||
    hookEvent === 'SubagentStart'
  ) {
    if (updated.finishedTurn) {
      updated.finishedTurn = false;
      delete updated.finishedSince;
      delete updated.finishedMessage;
    }
    // If a TERMINAL-originated turn (no voiceTurn marker) starts on a voice-stale
    // session, the human typed into a TUI that never saw the injected turns —
    // escalate rather than silently clear, so the divergence is surfaced.
    if (updated.voiceStale && voiceTurn !== true && hookEvent === 'UserPromptSubmit') {
      updated.voiceStaleEscalated = true;
    }
    // The agent is active again — any still-queued summary for it is now stale.
    dropQueuedForAgent(id);
  }

  // Attention required (Claude Code Notification hook) — main session only,
  // Claude is asking the user for permission or has been idle waiting on input.
  if (hookEvent === 'Notification' || awaitingUser === true) {
    updated.awaitingUser = true;
    updated.awaitingMessage = awaitingMessage || updated.awaitingMessage || '';
    updated.awaitingSince = existing.awaitingUser ? (existing.awaitingSince || new Date().toISOString()) : new Date().toISOString();
    // Classify: permission asks always "attention". Idle waits after Stop are "finished".
    const msg = (awaitingMessage || '').toLowerCase();
    const isPermission = msg.includes('permission');
    const wasFinished = !!existing.finishedTurn;
    if (isPermission) {
      updated.awaitingKind = 'attention';
    } else if (wasFinished) {
      updated.awaitingKind = 'finished';
    } else {
      updated.awaitingKind = 'attention';
    }
  } else if (
    awaitingUser === false ||
    hookEvent === 'UserPromptSubmit' ||
    hookEvent === 'PreToolUse' ||
    hookEvent === 'PostToolUse'
  ) {
    // User resolved the prompt (or agent moved on) — clear the flag.
    if (updated.awaitingUser) {
      updated.awaitingUser = false;
      delete updated.awaitingMessage;
      delete updated.awaitingSince;
      delete updated.awaitingKind;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

  // Persist log entries
  const oldStatus = existing.status || 'offline';
  const newStatus = updated.status;
  const now = new Date().toISOString();
  if (oldStatus !== newStatus || (hookEvent === 'PreToolUse' && currentTool)) {
    const logEntry = { time: now, agentId: id, oldStatus, newStatus, tool: currentTool || null, task: (toolDetail && toolDetail.summary) || currentTask || null };
    appendActivityLog(logEntry);
    appendAgentEventLog(filePath, logEntry);
  }
  if (hookEvent === 'Notification') {
    const logEntry = { time: now, agentId: id, type: 'attention', message: awaitingMessage || '' };
    appendActivityLog(logEntry);
    appendAgentEventLog(filePath, logEntry);
  }

  // Persist retroactive subagent tool history from transcript
  if (hookEvent === 'SubagentStop' && transcriptTools && transcriptTools.length > 0) {
    // Append transcript tools to agent's event log and tool counts
    let data = {};
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
    if (!data.eventLog) data.eventLog = [];
    if (!data.toolCounts) data.toolCounts = {};
    for (const t of transcriptTools) {
      const entry = { time: t.timestamp || now, agentId: id, oldStatus: 'active', newStatus: 'active', tool: t.tool, task: t.detail ? t.detail.summary : null };
      data.eventLog.push(entry);
      data.toolCounts[t.tool] = (data.toolCounts[t.tool] || 0) + 1;
    }
    if (data.eventLog.length > 200) data.eventLog.splice(0, data.eventLog.length - 200);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    // Also add summary to global activity log
    appendActivityLog({ time: now, agentId: id, type: 'transcript', toolCount: transcriptTools.length });
    broadcast({ type: 'subagent_tools', agentId: id, tools: transcriptTools });
  }

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

// ============================================================
// Text-to-speech. The server owns the queue (ordering, priority, drop-stale)
// and renders each line to an audio file with macOS `say -o`; the browser
// plays the file via an <audio> element + Media Session API, so the Mac's
// hardware media keys (and Now Playing) control it and it plays in the
// background. The server advances the queue when the client reports "done".
// ============================================================
const TTS_DIR = path.join(os.tmpdir(), 'agents-hq-tts');
try {
  fs.mkdirSync(TTS_DIR, { recursive: true });
  for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
} catch {}

const ttsQueue = [];        // [{ id, agentId, text, voice, rate, label, preview, priority, audioFile, audioUrl }]
let ttsCurrentItem = null;  // item currently handed to the browser to play
let ttsSpeaking = false;    // a current item is assigned (rendered + playing)
let ttsPaused = false;      // playback paused (browser <audio> paused), queue held
let ttsHold = false;        // voice reply-window hold: block queue advancement while
                            // the auto-listen mic is open (window ⇄ TTS are mutually
                            // exclusive audio states, so the mic never hears TTS)
let ttsRendering = false;   // a `say -o` render is in progress
let ttsWatchdog = null;     // stall guard if no client ever reports "done"
let ttsSeq = 0;

// Set by the voice reply-window (client) via /api/voice/hold, or synchronously by
// the server when a reply finishes while auto-reply is armed (see advanceCurrent).
// A safety timer auto-releases the hold if the client dies mid-window so the queue
// can never get permanently stuck.
let ttsHoldTimer = null;
const TTS_HOLD_SAFETY_MS = 90000;
function setTtsHold(v) {
  ttsHold = !!v;
  if (ttsHoldTimer) { clearTimeout(ttsHoldTimer); ttsHoldTimer = null; }
  if (ttsHold) {
    ttsHoldTimer = setTimeout(() => { ttsHoldTimer = null; ttsHold = false; broadcastTtsState(); playNextTts(); }, TTS_HOLD_SAFETY_MS);
  } else {
    playNextTts();
  }
  broadcastTtsState();
}

// Whether a client has the "answer after each reply" mode armed. When true, the
// server holds the TTS queue the instant a reply finishes — before the next item
// can start — so the reopened mic never hears the following message.
let autoReplyArmed = false;
function setAutoReplyArmed(v) { autoReplyArmed = !!v; }

const TTS_WATCHDOG_MS = 180000;   // drain a stuck current item after 3 min

// Callbacks fired when a specific TTS item reaches a terminal state (played,
// skipped, or watchdog). Used by the voice bridge to anchor the confirmation
// cancel-window and the pending-queue flush to actual playback completion.
const ttsDoneCallbacks = new Map();   // ttsItemId -> fn
function fireTtsDone(item) {
  if (!item || !ttsDoneCallbacks.has(item.id)) return;
  const cb = ttsDoneCallbacks.get(item.id);
  ttsDoneCallbacks.delete(item.id);
  try { cb(); } catch {}
}

// Voice input switched off: drop its queued status lines and their callbacks.
function dropVoiceSystemItems() {
  const before = ttsQueue.length;
  for (let i = ttsQueue.length - 1; i >= 0; i--) {
    if (ttsQueue[i].voiceSystem) { ttsDoneCallbacks.delete(ttsQueue[i].id); ttsQueue.splice(i, 1); }
  }
  if (ttsQueue.length !== before) broadcastTtsState();
}

// ---- Spoken history: every agent line that actually played is recorded with
// its FINAL prepared speech text (post-summary) + voice/rate. Replaying is then
// deterministic: same (engine, voice, rate, text) → same content-hash → the
// cached audio file is reused; only evicted entries re-render, and nothing is
// ever re-summarized. Persisted so history survives server restarts (the audio
// cache lives in tmpdir and may not).
const SPOKEN_HISTORY_PATH = path.join(__dirname, 'state', 'spoken-history.json');
const SPOKEN_HISTORY_MAX = 100;
let spokenHistory = [];   // newest first: { id, agentId, at, label, preview, speakText, voice, rate, outputKey, pauseOtherMedia }
let spokenHistorySeq = 0;
try {
  const loaded = JSON.parse(fs.readFileSync(SPOKEN_HISTORY_PATH, 'utf8'));
  if (Array.isArray(loaded)) {
    // Shape-validate: a hand-edited or torn file must not brick the endpoints.
    spokenHistory = loaded
      .filter(e => e && typeof e === 'object' && typeof e.agentId === 'string' && typeof e.speakText === 'string')
      .slice(0, SPOKEN_HISTORY_MAX);
  }
} catch {}
let spokenHistorySaveTimer = null;
function saveSpokenHistory() {
  if (spokenHistorySaveTimer) return;
  spokenHistorySaveTimer = setTimeout(() => {
    spokenHistorySaveTimer = null;
    try { fs.writeFileSync(SPOKEN_HISTORY_PATH, JSON.stringify(spokenHistory)); } catch {}
  }, 1500);
}
// Removing an agent (cleanup / reset) also removes what was spoken for it.
function purgeSpokenHistory(pred) {
  const before = spokenHistory.length;
  spokenHistory = spokenHistory.filter(e => !pred(e));
  if (spokenHistory.length !== before) saveSpokenHistory();
}
app.post('/api/speak/history/clear', (req, res) => {
  purgeSpokenHistory(() => true);
  res.json({ ok: true });
});
function flushSpokenHistory() {
  if (!spokenHistorySaveTimer) return;
  clearTimeout(spokenHistorySaveTimer);
  spokenHistorySaveTimer = null;
  try { fs.writeFileSync(SPOKEN_HISTORY_PATH, JSON.stringify(spokenHistory)); } catch {}
}
// Identity of the output an entry was spoken FROM — lets the Listen button
// verify the newest history entry matches the output on screen (an output that
// was muted/stopped/dropped has no entry while an older turn does).
function spokenOutputKey(raw) {
  if (!raw) return '';
  return crypto.createHash('sha1').update(String(raw).slice(0, 6000)).digest('hex').slice(0, 16);
}
function recordSpokenHistory(item, speakText) {
  if (!item.agentId || item.voiceSystem || item.replay || !speakText) return;
  spokenHistory.unshift({
    id: `h${Date.now().toString(36)}${(++spokenHistorySeq).toString(36)}`,
    agentId: item.agentId,
    at: Date.now(),
    label: item.label || '',
    preview: (item.preview || speakText).slice(0, 140),
    speakText: speakText.slice(0, 6000),
    // Full original output, so the reader popup can DISPLAY a past message,
    // not just replay its audio. (Entries recorded before this field existed
    // fall back to speakText in the viewer.)
    rawText: String(item.rawText || item.text || '').slice(0, 6000),
    voice: item.voice || '',
    rate: item.rate || 0,
    outputKey: spokenOutputKey(item.rawText || item.text),
    pauseOtherMedia: !!item.pauseOtherMedia
  });
  if (spokenHistory.length > SPOKEN_HISTORY_MAX) spokenHistory.length = SPOKEN_HISTORY_MAX;
  saveSpokenHistory();
}

// Enqueue a PROTECTED voice-system utterance (confirmation / "queued" / error
// line). Marked `voiceSystem` so dropQueuedForAgent and the Phase 2 queue-freeze
// skip it. Priority-enqueued so it is heard before the model reply it precedes.
// onDonePlaying fires once the item finishes playing (its /api/speak/done).
function speakVoiceSystem(text, opts = {}) {
  const clean = String(text || '').slice(0, 600);
  if (!clean.trim()) return null;
  const item = {
    id: ++ttsSeq,
    agentId: typeof opts.agentId === 'string' ? opts.agentId : '',
    text: clean,
    rawText: '',
    lead: '',
    summarize: false,
    pauseOtherMedia: false,
    voice: '',
    rate: 0,
    label: (opts.label || 'voice').toString().slice(0, 80),
    preview: clean.slice(0, 140),
    priority: true,
    voiceSystem: true
  };
  if (typeof opts.onDonePlaying === 'function') ttsDoneCallbacks.set(item.id, opts.onDonePlaying);
  // Insert behind earlier priority items but ahead of normal items.
  let idx = 0;
  while (idx < ttsQueue.length && ttsQueue[idx].priority) idx++;
  ttsQueue.splice(idx, 0, item);
  playNextTts();
  broadcastTtsState();
  return item.id;
}

// Cache of valid voice names so an unknown/stale voice falls back to default
// instead of failing the utterance silently.
let validVoiceNames = new Set();
function parseSayVoices(out) {
  const voices = [];
  out.split('\n').forEach(line => {
    // Format: "Name(may have spaces)  ll[l][_RR]  # sample sentence"
    const m = line.match(/^(.+?)\s+([a-z]{2,3}(?:_[A-Z]{2})?)\s+#/);
    if (m) voices.push({ name: m[1].trim(), lang: m[2] });
  });
  return voices;
}
function loadValidVoices() {
  let child;
  try { child = spawn('say', ['-v', '?']); } catch { return; }
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('error', () => {});
  child.on('close', () => { validVoiceNames = new Set(parseSayVoices(out).map(v => v.name)); });
}
loadValidVoices();

// ---- Listenable summary: rewrite a long agent message into a short spoken
// summary. Uses Claude Haiku 4.5 via the API when ANTHROPIC_API_KEY is set;
// otherwise falls back to a local extractive heuristic. ----
let anthropicClient = null;
let anthropicTried = false;
function getAnthropicClient() {
  if (anthropicTried) return anthropicClient;
  anthropicTried = true;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    anthropicClient = new Anthropic();   // reads ANTHROPIC_API_KEY from env
  } catch { anthropicClient = null; }
  return anthropicClient;
}

const TTS_SUMMARY_SYSTEM =
  "You rewrite an AI coding agent's message into a short summary meant to be " +
  "heard, not read. Rules: 1 to 3 sentences, under 60 words total; plain spoken " +
  "language with no markdown, code, file paths, or symbols; lead with the outcome " +
  "(what happened or what was found); no greetings or sign-offs. Output only the summary.";

function heuristicSummary(raw) {
  let t = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[#>\-*+]+\s*/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\/(?:[^\s/]+\/)+([^\s/]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = t.match(/[^.!?]+[.!?]+/g) || [t];
  let out = '';
  for (const s of sentences) { if ((out + s).length > 280) break; out += s; }
  return (out || t).trim().slice(0, 300);
}

// Backend 1: Anthropic API (needs ANTHROPIC_API_KEY, billed per call).
async function summarizeViaApi(raw) {
  const client = getAnthropicClient();
  if (!client) return null;
  const envModel = process.env.TTS_SUMMARY_MODEL || '';
  const model = /^claude-/.test(envModel) ? envModel : 'claude-haiku-4-5';
  const msg = await client.messages.create({
    model,
    max_tokens: 200,
    system: TTS_SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: String(raw).slice(0, 6000) }]
  });
  const text = (msg.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  return text || null;
}

// Backend 2: Claude Code CLI (`claude -p`). Uses the user's subscription auth —
// no API key, no extra payment. Slower (cold start), so it runs lazily with a
// kill timeout. AGENTS_HQ_NO_TRACK + a temp cwd keep it out of the dashboard.
let claudeCliAvailable = null;
function hasClaudeCli() {
  if (claudeCliAvailable !== null) return claudeCliAvailable;
  try {
    const r = spawnSync('which', ['claude'], { timeout: 3000 });
    claudeCliAvailable = !r.error && r.status === 0;
  } catch { claudeCliAvailable = false; }
  return claudeCliAvailable;
}

function summarizeViaCli(raw) {
  return new Promise((resolve) => {
    const model = process.env.TTS_SUMMARY_MODEL || 'sonnet';
    const prompt = `${TTS_SUMMARY_SYSTEM}\n\nMessage to summarize:\n${String(raw).slice(0, 6000)}`;
    let child;
    try {
      child = spawn('claude', ['-p', prompt, '--model', model, '--output-format', 'text'], {
        cwd: os.tmpdir(),                                  // don't load project context/hooks
        env: { ...process.env, AGENTS_HQ_NO_TRACK: '1' },  // suppress dashboard tracking hooks
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { return resolve(null); }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 25000);
    child.on('error', () => { clearTimeout(killer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(killer);
      const text = out.trim();
      resolve(code === 0 && text ? text : null);
    });
  });
}

// Pick a backend: explicit override → API (if key) → CLI (if installed) → heuristic.
function resolveSummarizer() {
  const explicit = (process.env.TTS_SUMMARIZER || '').toLowerCase();
  if (explicit === 'cli' || explicit === 'api' || explicit === 'heuristic') return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (hasClaudeCli()) return 'cli';
  return 'heuristic';
}

async function summarizeForSpeech(raw) {
  const backend = resolveSummarizer();
  try {
    if (backend === 'api') { const t = await summarizeViaApi(raw); if (t) return t; }
    else if (backend === 'cli') { const t = await summarizeViaCli(raw); if (t) return t; }
  } catch { /* fall through to heuristic */ }
  return heuristicSummary(raw);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(null), ms))]);
}

// ---- Optional AI output formatting: reformat an agent's finished message into
// themed HTML shown in the output popup. Opt-in and on-demand (POST /api/htmlify).
// The HTML is rendered client-side inside a sandboxed, opaque-origin iframe, so
// it can never touch the dashboard DOM/cookies/API. This server pass is a
// convenience + a defense-in-depth sanitize; the iframe is the real boundary. ----
const HTML_FORMAT_SYSTEM =
  "You reformat an AI coding agent's finished message into clean, well-structured HTML for a dashboard panel. " +
  "RULES:\n" +
  "- RESTRUCTURE for readability; do NOT rewrite, summarize, or invent. Preserve every fact, number, file path, and code snippet verbatim.\n" +
  "- Output ONLY an HTML body fragment. Never emit <html>, <head>, <body>, <script>, <style>, <iframe>, <object>, <embed>, <form>, <link>, <meta>, or any on* event attribute.\n" +
  "- Allowed tags only: h1,h2,h3,h4,p,ul,ol,li,strong,em,code,pre,blockquote,hr,br,a,table,thead,tbody,tr,th,td,div,span,details,summary.\n" +
  "- Reproduce code and commands exactly inside <pre><code>...</code></pre>. Do not alter them.\n" +
  "- For any color, use ONLY CSS variables via inline style, e.g. style=\"color:var(--accent)\". Never hardcode hex or rgb. Available tokens: --text, --text-bright, --text-content, --text-muted, --accent, --accent-dim, --bg, --bg-card, --bg-stat, --border, --border-faint, --status-active, --status-idle, --status-attention.\n" +
  "- Use <details><summary>Heading</summary>...</details> to make long or secondary sections collapsible when it helps. Never use JavaScript.\n" +
  "- Links: https:// URLs only.\n" +
  "Output only the HTML fragment, no prose, no code fences.";

function htmlModel(kind) {
  const env = process.env.AI_HTML_MODEL || '';
  if (kind === 'api') return /^claude-/.test(env) ? env : 'claude-haiku-4-5';
  return env || 'haiku';
}

async function htmlifyViaApi(raw) {
  const client = getAnthropicClient();
  if (!client) return null;
  const msg = await client.messages.create({
    model: htmlModel('api'),
    max_tokens: 1500,
    system: HTML_FORMAT_SYSTEM,
    messages: [{ role: 'user', content: String(raw).slice(0, 6000) }]
  });
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return text || null;
}

function htmlifyViaCli(raw) {
  return new Promise((resolve) => {
    const prompt = `${HTML_FORMAT_SYSTEM}\n\nMessage to reformat:\n${String(raw).slice(0, 6000)}`;
    let child;
    try {
      child = spawn('claude', ['-p', prompt, '--model', htmlModel('cli'), '--output-format', 'text'], {
        cwd: os.tmpdir(),
        env: { ...process.env, AGENTS_HQ_NO_TRACK: '1' },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { return resolve(null); }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
    child.on('error', () => { clearTimeout(killer); resolve(null); });
    child.on('close', (code) => { clearTimeout(killer); const t = out.trim(); resolve(code === 0 && t ? t : null); });
  });
}

async function htmlifyOutput(raw) {
  const backend = resolveSummarizer();
  if (backend === 'heuristic') return null;   // no LLM available → caller falls back
  try {
    if (backend === 'api') return await htmlifyViaApi(raw);
    if (backend === 'cli') return await htmlifyViaCli(raw);
  } catch { /* fall through */ }
  return null;
}

// Allowlist sanitize — defense-in-depth behind the sandboxed iframe. Strips
// dangerous tags/attributes even though the iframe already can't execute them.
function sanitizeHtmlFragment(html) {
  let h = String(html || '').trim();
  h = h.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();   // strip stray code fences
  h = h.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');  // drop script/style + content
  h = h.replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|link|meta|base|html|head|body)\b[^>]*>/gi, '');
  h = h.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
       .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
       .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  h = h.replace(/(href|src)\s*=\s*"(\s*javascript:[^"]*)"/gi, '$1="#"')
       .replace(/(href|src)\s*=\s*'(\s*javascript:[^']*)'/gi, "$1='#'");
  return h.slice(0, 60000);
}

const htmlCache = new Map();   // sha1(text) -> sanitized html fragment
const HTML_CACHE_MAX = 100;
function htmlCacheSet(key, val) {
  htmlCache.set(key, val);
  if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value);
}

// ---- Voice engines: render speech to an audio file. `say` is the free local
// default; OpenAI (gpt-4o-mini-tts) gives much better voices when OPENAI_API_KEY
// is set. The browser plays whatever file we produce, so engines are pluggable. ----
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const OPENAI_INSTRUCTIONS = process.env.TTS_OPENAI_INSTRUCTIONS ||
  'Speak in a calm, clear, natural narrator voice — steady and neutral, not overly expressive.';

function resolveTtsEngine() {
  const explicit = (process.env.TTS_ENGINE || '').toLowerCase();
  if (explicit === 'say' || explicit === 'openai') return explicit;
  if (getOpenAIKey()) return 'openai';
  return 'say';
}

// Content-hash cache: identical (engine, voice, rate, text) reuses the rendered
// file — instant and, for OpenAI, free. Files live in TTS_DIR; LRU-evicted.
let openaiCharCount = 0;             // chars synthesized via OpenAI this session
const TTS_CACHE_MAX = 300;
function ttsCachePath(parts, ext) {
  const hash = crypto.createHash('sha1').update(parts.join(' ')).digest('hex');
  return { file: path.join(TTS_DIR, `${hash}.${ext}`), url: `/api/speak/audio/${hash}.${ext}` };
}
function touchFile(file) { try { const now = new Date(); fs.utimesSync(file, now, now); } catch {} }
function evictCache() {
  try {
    const files = fs.readdirSync(TTS_DIR).filter(f => /\.(wav|mp3)$/.test(f));
    if (files.length <= TTS_CACHE_MAX) return;
    files.map(f => ({ f, t: fs.statSync(path.join(TTS_DIR, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .slice(0, files.length - TTS_CACHE_MAX)
      .forEach(({ f }) => { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} });
  } catch {}
}

function renderViaSay(item, speakText) {
  return new Promise((resolve) => {
    const voice = (item.voice && (validVoiceNames.size === 0 || validVoiceNames.has(item.voice))) ? item.voice : '';
    const { file, url } = ttsCachePath(['say', voice, String(item.rate || 0), speakText], 'wav');
    if (fs.existsSync(file)) { touchFile(file); return resolve({ file, url }); }   // cache hit
    const args = [];
    if (voice) args.push('-v', voice);
    if (item.rate) args.push('-r', String(item.rate));
    args.push('-o', file, '--data-format=LEI16@22050', '--', speakText);
    let child;
    try { child = spawn('say', args); } catch { return resolve(null); }
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(file)) { evictCache(); resolve({ file, url }); }
      else resolve(null);
    });
  });
}

async function renderViaOpenAI(item, speakText) {
  const key = getOpenAIKey();
  if (!key) return null;
  const model = process.env.TTS_OPENAI_MODEL || 'gpt-4o-mini-tts';
  const voice = OPENAI_VOICES.includes(item.voice) ? item.voice
    : (process.env.TTS_OPENAI_VOICE || 'nova');
  const input = String(speakText).slice(0, 4000);
  const { file, url } = ttsCachePath(['openai', model, voice, String(item.rate || 0), input], 'mp3');
  if (fs.existsSync(file)) { touchFile(file); return { file, url }; }   // cache hit — no API call, no cost
  const body = { model, input, voice, response_format: 'mp3' };
  if (/mini-tts/.test(model)) body.instructions = OPENAI_INSTRUCTIONS;
  else if (item.rate) body.speed = Math.max(0.25, Math.min(4, item.rate / 180));   // tts-1 speed multiplier
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return null;
    fs.writeFileSync(file, buf);
    openaiCharCount += input.length;
    evictCache();
    return { file, url };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function renderAudio(item, speakText) {
  if (resolveTtsEngine() === 'openai') {
    const r = await renderViaOpenAI(item, speakText);
    if (r) return r;            // fall back to local `say` if the API call fails
  }
  return renderViaSay(item, speakText);
}

// ---- Pause other system media (Safari, Apple Music, podcasts, anything that
// responds to the Mac's play/pause key) while the agent speaks, via the
// MediaRemote framework through `nowplaying-cli`. No-ops if it isn't installed
// (brew install nowplaying-cli). Pause on first utterance, resume when idle. ----
let nowPlayingCliAvailable = null;
function hasNowPlayingCli() {
  if (nowPlayingCliAvailable !== null) return nowPlayingCliAvailable;
  try {
    const r = spawnSync('which', ['nowplaying-cli'], { timeout: 3000 });
    nowPlayingCliAvailable = !r.error && r.status === 0;
  } catch { nowPlayingCliAvailable = false; }
  return nowPlayingCliAvailable;
}
function nowPlayingCli(args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('nowplaying-cli', args, { timeout: 4000 }); }
    catch { return resolve(''); }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });
}
let mediaPausedByUs = false;
async function maybePauseOtherMedia(item) {
  if (mediaPausedByUs || !item || !item.pauseOtherMedia || !hasNowPlayingCli()) return;
  const rate = parseFloat(await nowPlayingCli(['get', 'playbackRate']));
  if (rate > 0) {                       // something is actually playing → pause it
    await nowPlayingCli(['pause']);
    mediaPausedByUs = true;
  }
}
async function maybeResumeOtherMedia() {
  if (!mediaPausedByUs) return;
  mediaPausedByUs = false;
  if (hasNowPlayingCli()) await nowPlayingCli(['play']);
}

function ttsSnapshot() {
  return {
    type: 'tts',
    speaking: ttsSpeaking,
    paused: ttsPaused,
    hold: ttsHold,
    queued: ttsQueue.length,
    current: ttsCurrentItem
      ? { id: ttsCurrentItem.id, agentId: ttsCurrentItem.agentId, label: ttsCurrentItem.label,
          preview: ttsCurrentItem.preview, priority: ttsCurrentItem.priority, replay: !!ttsCurrentItem.replay,
          voiceSystem: !!ttsCurrentItem.voiceSystem, audioUrl: ttsCurrentItem.audioUrl }
      : null,
    queue: ttsQueue.map(i => ({ id: i.id, agentId: i.agentId, label: i.label, preview: i.preview, priority: i.priority, replay: !!i.replay, voiceSystem: !!i.voiceSystem }))
  };
}

function broadcastTtsState() { broadcast(ttsSnapshot()); }

// Audio files are cache entries now (LRU-evicted), so we don't delete them per item.
function cleanupAudio() { /* no-op: handled by evictCache */ }

// Summarize + render an item to audio, memoized on the item (used for pre-render).
async function prepareItem(item) {
  if (item._prepared) return item._prepared;
  let speakText = item.text;
  let preview = item.preview;
  if (item.summarize && item.rawText) {
    const summary = await withTimeout(summarizeForSpeech(item.rawText), 27000);
    if (summary) { speakText = (item.lead || '') + summary; preview = summary.slice(0, 140); }
  }
  const rendered = await withTimeout(renderAudio(item, speakText), 30000);
  if (!rendered) return null;
  item._prepared = { url: rendered.url, preview, speakText };
  return item._prepared;
}

// Get the next queued item ready in the background so playback flows without gaps.
function prerenderNext() {
  const next = ttsQueue[0];
  if (next && !next._prepared) prepareItem(next).catch(() => {});
}

// Drop an agent's still-queued utterances (not the one playing) — used when the
// agent starts a new turn, making any queued summary stale.
function dropQueuedForAgent(agentId) {
  if (!agentId) return;
  const before = ttsQueue.length;
  for (let i = ttsQueue.length - 1; i >= 0; i--) {
    // Voice-system items (confirmations / "queued" / error lines) are protected:
    // the injected run itself fires this agent's UserPromptSubmit 1–3s after
    // spawn, which would otherwise silently delete the mishear-veto confirmation.
    // Replays and click-listens are protected too — explicitly requested.
    if (ttsQueue[i].voiceSystem || ttsQueue[i].replay || ttsQueue[i].userListen) continue;
    if (ttsQueue[i].agentId === agentId) ttsQueue.splice(i, 1);
  }
  if (ttsQueue.length !== before) broadcastTtsState();
}

// Finish the current item (client reported done, skipped, or watchdog) and move on.
function advanceCurrent(id) {
  if (ttsWatchdog) { clearTimeout(ttsWatchdog); ttsWatchdog = null; }
  if (id !== undefined && ttsCurrentItem && ttsCurrentItem.id !== id) return; // stale done
  // Fire any terminal-state callback registered for this item (voice bridge).
  fireTtsDone(ttsCurrentItem);
  // A genuine agent reply just finished playing (not a protected voice-system
  // confirmation, not a priority attention ask) → signal the client so the
  // voice reply-window can open the mic for a hands-free answer.
  const finished = ttsCurrentItem;
  if (finished && finished.agentId && !finished.voiceSystem && !finished.priority) {
    // Hold the queue NOW (synchronously, before playNextTts below can start the
    // next item) if the client has auto-reply armed — closes the race where the
    // following message would start playing into the about-to-open mic.
    if (autoReplyArmed && voice.isEnabled()) setTtsHold(true);
    broadcast({ type: 'voiceReplyDone', agentId: finished.agentId, at: Date.now() });
    // The agent's summary has now been HEARD → deliver any voice utterance that
    // queued while it was busy. (Flushing earlier would let the injected turn's
    // UserPromptSubmit drop the still-queued summary via dropQueuedForAgent.)
    try { voice.flushPending(finished.agentId); } catch {}
  }
  cleanupAudio(ttsCurrentItem);
  ttsCurrentItem = null;
  ttsSpeaking = false;
  broadcastTtsState();
  playNextTts();
}

async function playNextTts() {
  if (ttsSpeaking || ttsPaused || ttsRendering || ttsHold) return;
  const item = ttsQueue.shift();
  if (!item) { ttsCurrentItem = null; broadcastTtsState(); maybeResumeOtherMedia(); return; }
  ttsRendering = true;
  ttsCurrentItem = item;   // show as current immediately (no audioUrl yet → client waits)
  broadcastTtsState();

  // Summarize + render (or reuse the pre-rendered result from prerenderNext).
  const prep = await prepareItem(item);
  ttsRendering = false;

  if (ttsCurrentItem !== item) { setImmediate(playNextTts); return; }   // superseded by stop/skip
  // Prep failed: still fire its done-callback, so a voice confirmation that
  // couldn't render doesn't silently strand the utterance it announces.
  if (!prep) { fireTtsDone(item); ttsCurrentItem = null; setImmediate(playNextTts); return; }

  if (prep.preview) item.preview = prep.preview;
  await maybePauseOtherMedia(item);   // pause the user's music/video before the voice starts
  item.audioUrl = prep.url;
  ttsSpeaking = true;
  // Sweep-proof "last spoken instance" record for voice routing. ORGANIC agent
  // responses only: voice-system lines, replays of old messages, and click-
  // initiated listens must not hijack the sticky voice target (the popup's own
  // Reply mic already freezes to the popup's agent).
  if (item.agentId && !item.voiceSystem && !item.replay && !item.userListen) {
    lastSpokenAgent = { agentId: item.agentId, at: Date.now() };
  }
  recordSpokenHistory(item, prep.speakText);
  broadcastTtsState();   // client picks up audioUrl and plays it
  ttsWatchdog = setTimeout(() => advanceCurrent(), TTS_WATCHDOG_MS);
  prerenderNext();       // prepare the next line in the background
}

app.post('/api/speak', (req, res) => {
  const { text, voice, rate, label, preview, agentId, priority, rawText, lead, summarize, pauseOtherMedia, listen } = req.body || {};
  const clean = (text || '').toString().slice(0, 6000);
  if (!clean.trim()) return res.json({ ok: false, queued: ttsQueue.length });
  const item = {
    id: ++ttsSeq,
    agentId: typeof agentId === 'string' ? agentId : '',
    text: clean,
    rawText: typeof rawText === 'string' ? rawText.slice(0, 6000) : '',
    lead: typeof lead === 'string' ? lead.slice(0, 200) : '',
    summarize: !!summarize,
    pauseOtherMedia: !!pauseOtherMedia,
    voice: typeof voice === 'string' ? voice : '',
    rate: Number.isFinite(rate) ? rate : 0,
    label: (label || '').toString().slice(0, 80),
    preview: (preview || '').toString().slice(0, 140),
    // A click-initiated Listen: jumps the queue like a replay and shares its
    // protections, but IS recorded into spoken history (it's the first organic
    // speak of this output). Being priority, it never fires voiceReplyDone.
    userListen: !!listen,
    priority: !!priority || !!listen
  };
  if (item.priority) {
    // Jump ahead of normal items but stay FIFO behind earlier priority items.
    let idx = 0;
    while (idx < ttsQueue.length && ttsQueue[idx].priority) idx++;
    ttsQueue.splice(idx, 0, item);
  } else {
    ttsQueue.push(item);
  }
  if (ttsQueue.length > 50) fireTtsDone(ttsQueue.shift());   // drop oldest if backed up
  playNextTts();
  broadcastTtsState();
  res.json({ ok: true, queued: ttsQueue.length + (ttsSpeaking ? 1 : 0) });
});

// Past spoken messages (final speech text, newest first) — for the popup's
// history list and the Listen button.
app.get('/api/speak/history', (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const entries = (agentId ? spokenHistory.filter(e => e.agentId === agentId) : spokenHistory)
    .slice(0, limit)
    .map(e => ({ id: e.id, agentId: e.agentId, at: e.at, label: e.label, preview: e.preview }));
  res.json({ ok: true, entries });
});

// Full content of one history entry — the reader popup shows past messages
// inline (rawText when recorded; older entries only have the spoken summary).
app.get('/api/speak/history/entry', (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const e = spokenHistory.find(x => x.id === id);
  if (!e) return res.json({ ok: false, reason: 'not-found' });
  res.json({ ok: true, entry: {
    id: e.id, agentId: e.agentId, at: e.at, label: e.label,
    preview: e.preview, rawText: e.rawText || '', speakText: e.speakText || ''
  } });
});

// Replay a past spoken message. Accepts {historyId} for a specific entry
// (history dropdown — any entry, deliberately), or {agentId} for that agent's
// newest one. When {agentId, rawText} are sent (the Listen button), the newest
// entry must have been spoken FROM that exact output — otherwise ok:false so
// the client speaks the actually-displayed output instead of a stale summary.
// The stored speech text + voice + rate hit the audio content-hash cache, so
// no re-summarization and usually no re-render happens.
app.post('/api/speak/replay', (req, res) => {
  const { historyId, agentId, rawText } = req.body || {};
  let entry = null;
  if (historyId) {
    entry = spokenHistory.find(e => e.id === historyId);
  } else if (typeof agentId === 'string' && agentId) {
    if (typeof rawText === 'string' && rawText) {
      const key = spokenOutputKey(rawText);
      entry = spokenHistory.find(e => e.agentId === agentId && e.outputKey === key);
    } else {
      entry = spokenHistory.find(e => e.agentId === agentId);
    }
  }
  if (!entry || !entry.speakText) return res.json({ ok: false, reason: 'no-history' });
  const item = {
    id: ++ttsSeq,
    agentId: entry.agentId,
    text: entry.speakText,
    rawText: '',
    lead: '',
    summarize: false,           // already the prepared speech form
    pauseOtherMedia: entry.pauseOtherMedia !== false,   // honor the original item's setting
    voice: entry.voice || '',
    rate: entry.rate || 0,
    label: entry.label || 'replay',
    preview: entry.preview || '',
    priority: true,             // the user asked to hear it now
    replay: true
  };
  let idx = 0;
  while (idx < ttsQueue.length && ttsQueue[idx].priority) idx++;
  ttsQueue.splice(idx, 0, item);
  playNextTts();
  broadcastTtsState();
  res.json({ ok: true, id: item.id });
});

// Optional, opt-in: reformat an agent's output into themed HTML via a quick
// Claude model. On-demand only (the client calls this when the user clicks
// "Enhance"). Returns a fragment the client renders in a sandboxed iframe.
app.post('/api/htmlify', async (req, res) => {
  const text = ((req.body && req.body.text) || '').toString().slice(0, 6000);
  if (!text.trim()) return res.json({ ok: false, error: 'empty' });
  if (resolveSummarizer() === 'heuristic') return res.json({ ok: false, error: 'no-ai-backend' });
  const key = crypto.createHash('sha1').update('htmlv1|' + text).digest('hex');
  const cached = htmlCache.get(key);
  if (cached) return res.json({ ok: true, html: cached, cached: true });
  let html = null;
  try { html = await withTimeout(htmlifyOutput(text), 35000); } catch { html = null; }
  if (!html) return res.json({ ok: false, error: 'failed' });
  html = sanitizeHtmlFragment(html);
  if (!html.trim()) return res.json({ ok: false, error: 'empty' });
  htmlCacheSet(key, html);
  res.json({ ok: true, html });
});

// Serve a rendered audio file (basename only — no path traversal).
app.get('/api/speak/audio/:file', (req, res) => {
  const fp = path.join(TTS_DIR, path.basename(req.params.file));
  if (!fp.startsWith(TTS_DIR) || !fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// The browser finished playing the current item.
app.post('/api/speak/done', (req, res) => {
  const id = req.body && req.body.id;
  advanceCurrent(typeof id === 'number' ? id : undefined);
  res.json({ ok: true });
});

app.post('/api/speak/skip', (req, res) => {
  ttsPaused = false;
  advanceCurrent();
  res.json({ ok: true });
});

app.post('/api/speak/stop', (req, res) => {
  if (ttsWatchdog) { clearTimeout(ttsWatchdog); ttsWatchdog = null; }
  ttsQueue.length = 0;
  ttsPaused = false;
  ttsDoneCallbacks.clear();   // discarded items' callbacks won't fire
  cleanupAudio(ttsCurrentItem);
  ttsCurrentItem = null;
  ttsSpeaking = false;
  broadcastTtsState();
  maybeResumeOtherMedia();   // bring the user's media back
  res.json({ ok: true });
});

// Pause/resume — the browser pauses the <audio>; the server just holds the queue
// and reflects the flag so the panel and other tabs stay in sync.
app.post('/api/speak/pause', (req, res) => {
  if (ttsSpeaking && !ttsPaused) {
    ttsPaused = true;
    if (ttsWatchdog) { clearTimeout(ttsWatchdog); ttsWatchdog = null; }
    broadcastTtsState();
  }
  res.json({ ok: true, paused: ttsPaused });
});

app.post('/api/speak/resume', (req, res) => {
  if (ttsPaused) {
    ttsPaused = false;
    if (ttsSpeaking) ttsWatchdog = setTimeout(() => advanceCurrent(), TTS_WATCHDOG_MS);
    broadcastTtsState();
    playNextTts();   // in case nothing was current
  }
  res.json({ ok: true, paused: ttsPaused });
});

// Remove a single still-queued item by id (does not affect what's playing).
app.post('/api/speak/remove', (req, res) => {
  const id = req.body && req.body.id;
  const idx = ttsQueue.findIndex(i => i.id === id);
  // Removing a voice confirmation cancels the send it announces (its callback is dropped).
  if (idx >= 0) { ttsDoneCallbacks.delete(ttsQueue[idx].id); ttsQueue.splice(idx, 1); broadcastTtsState(); }
  res.json({ ok: true });
});

// List voices for the active engine (OpenAI's set, or installed `say` voices).
app.get('/api/voices', (req, res) => {
  if (resolveTtsEngine() === 'openai') {
    return res.json(OPENAI_VOICES.map(name => ({ name, lang: 'en' })));
  }
  let child;
  try { child = spawn('say', ['-v', '?']); } catch { return res.json([]); }
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('error', () => res.json([]));
  child.on('close', () => res.json(parseSayVoices(out)));
});

// Masked status of UI-settable keys (never returns the full secret).
app.get('/api/config/keys', (req, res) => {
  const k = getOpenAIKey();
  res.json({
    openai: {
      set: !!k,
      hint: maskKey(k),
      source: runtimeSecrets.OPENAI_API_KEY ? 'ui' : (process.env.OPENAI_API_KEY ? 'env' : null)
    },
    usage: { openaiChars: openaiCharCount }
  });
});

// Set or clear the OpenAI key from the UI. Empty string clears the UI-set key.
app.post('/api/config/keys', (req, res) => {
  const { openai } = req.body || {};
  if (typeof openai === 'string') {
    const trimmed = openai.trim();
    if (trimmed) runtimeSecrets.OPENAI_API_KEY = trimmed;
    else delete runtimeSecrets.OPENAI_API_KEY;
    saveSecrets();
  }
  const k = getOpenAIKey();
  res.json({ ok: true, openai: { set: !!k, hint: maskKey(k) } });
});

// Clear the voice-stale badge for a session (manual dismiss, or on reopen).
app.post('/api/agent/:id/voice-stale-dismiss', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const safeFilename = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(STATE_DIR, `${safeFilename}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    delete data.voiceStale;
    delete data.voiceStaleEscalated;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    broadcast({ type: 'update', agent: data });
    return res.json({ ok: true });
  } catch { return res.json({ ok: false }); }
});

// Remove offline agents (keeps active/idle ones)
// Optional query param: ?olderThan=ms (only remove agents offline longer than this)
app.post('/api/cleanup/offline-agents', (req, res) => {
  const olderThan = parseInt(req.query.olderThan) || 0;
  const now = Date.now();
  const states = readAllStates();
  let removed = 0;
  const removedIds = new Set();
  for (const [id, state] of Object.entries(states)) {
    if (state.status === 'offline') {
      if (olderThan > 0) {
        const elapsed = now - new Date(state.lastActivity).getTime();
        if (elapsed < olderThan) continue;
      }
      const filename = state._filename || `${id}.json`;
      try { fs.unlinkSync(path.join(STATE_DIR, filename)); } catch {}
      delete agentRegistry[id];
      removedIds.add(id);
      removed++;
    }
  }
  if (removed > 0) {
    activityLog = activityLog.filter(e => !removedIds.has(e.agentId));
    purgeSpokenHistory(e => removedIds.has(e.agentId));
    saveActivityLog();
    broadcast({ type: 'init', config: getRegistryArray(), states: readAllStates(), activityLog });
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
  const removedIds = new Set();
  for (const [project, agents] of Object.entries(projects)) {
    const allOffline = agents.every(a => a.state.status === 'offline');
    if (allOffline) {
      for (const { id, state } of agents) {
        const filename = state._filename || `${id}.json`;
        try { fs.unlinkSync(path.join(STATE_DIR, filename)); } catch {}
        delete agentRegistry[id];
        removedIds.add(id);
        removed++;
      }
    }
  }
  if (removed > 0) {
    activityLog = activityLog.filter(e => !removedIds.has(e.agentId));
    purgeSpokenHistory(e => removedIds.has(e.agentId));
    saveActivityLog();
    broadcast({ type: 'init', config: getRegistryArray(), states: readAllStates(), activityLog });
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
  purgeSpokenHistory(() => true);
  Object.keys(typeColorMap).forEach(k => delete typeColorMap[k]);
  typeColorIndex = 0;
  messageLog.length = 0;
  activityLog = [];
  saveActivityLog();
  broadcast({ type: 'init', config: [], states: {}, activityLog: [] });
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
  ws.send(JSON.stringify({ type: 'init', config: getRegistryArray(), states, activityLog }));
  // Also send message history
  ws.send(JSON.stringify({ type: 'message_history', messages: messageLog }));
  // Current speech-queue state
  ws.send(JSON.stringify(ttsSnapshot()));
  // Auto-reply is armed by a tab; with no tab left nobody can answer, so stop
  // holding the queue after every reply. A tab re-arms on reconnect.
  ws.on('close', () => {
    if (wss.clients.size === 0 && autoReplyArmed) {
      setAutoReplyArmed(false);
      setTtsHold(false);
    }
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try { client.send(data); } catch {}
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
      const oldStatus = state.status;
      state.status = newStatus;
      state.currentTool = null;
      if (newStatus === 'offline') {
        state.sessionStart = null;
        delete agentToolTimers[id];
        if (state.awaitingUser) {
          state.awaitingUser = false;
          delete state.awaitingMessage;
          delete state.awaitingSince;
          delete state.awaitingKind;
        }
        if (state.finishedTurn) {
          state.finishedTurn = false;
          delete state.finishedSince;
        }
      }
      const filename = state._filename || `${id}.json`;
      delete state._filename;
      const filePath = path.join(STATE_DIR, filename);
      try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
        const logEntry = { time: new Date().toISOString(), agentId: id, oldStatus, newStatus, tool: null, task: null };
        appendActivityLog(logEntry);
        appendAgentEventLog(filePath, logEntry);
        changed = true;
      } catch {}
    }
  }
}, 10000); // check every 10s

// ---- Voice bridge (input half of the voice loop) ----
const voice = mountVoice(app, express, {
  getOpenAIKey,
  readAllStates,
  broadcast,
  speakVoiceSystem,
  getVoiceRecords,
  setTtsHold,
  setAutoReplyArmed,
  dropVoiceSystemItems,
  stateRoot: path.join(__dirname, 'state')
});
function shutdownVoice() { try { voice.shutdown(); } catch {} }
process.on('SIGINT', () => { shutdownVoice(); flushSpokenHistory(); process.exit(0); });
process.on('SIGTERM', () => { shutdownVoice(); flushSpokenHistory(); process.exit(0); });

const PORT = process.env.PORT || 3141;
// Bind to loopback by default so the dashboard (and the speak endpoint) aren't
// reachable from the LAN. Set HOST=0.0.0.0 to expose it intentionally.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Agents HQ running at http://localhost:${PORT}`);
  console.log(`Hooks should POST to http://localhost:${PORT}/api/agent/:id/status`);
});
