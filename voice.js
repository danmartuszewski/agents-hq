// ============================================================
// Voice Bridge — input half of the voice loop.
//
// Trigger → record (browser) → POST audio/text here → STT → resolve target
// session → inject as a real user turn via `claude -p --resume <sessionId>`.
// The injected turn's Stop hook flows through the EXISTING agents-hq
// summarize → TTS → speak pipeline, so the reply speaks itself. This module
// owns only the INPUT half: transcription, routing, and the managed child
// process that performs the injection.
//
// The server owns the TTS queue and the agent state; this module receives a
// small `serverApi` surface (see mountVoice) rather than reaching into globals.
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---- Settings (server-owned, default OFF — the kill switch) ----------------
const DEFAULT_SETTINGS = {
  enabled: false,          // master switch. When false, all /api/voice/* except
                           // /config return 403 (local AND remote).
  wakePhrase: 'HQ',        // Phase 5 auto-mode gate (unused until then)
  confirmSpoken: false,    // speak a "Sending to X: …" confirmation before injecting.
                           // Off by default — the visual toast already echoes it and
                           // the spoken line interrupts conversational flow.
  confirmCancelMs: 3000,   // stem-press cancel window after the confirmation plays
  replyWindowMs: 12000,    // Phase 2 deferred-music-resume / auto-listen window
  autoListenMs: 12000,     // Phase 5 auto conversation window
  watchdogMs: 30 * 60 * 1000,   // injected-turn hang guard (30 min)
  stickyMinutes: 30,       // how long lastSpokenAgent / lastFinishedAgent stay valid
  queueTtlMs: 15 * 60 * 1000,   // Phase 3 pending-queue TTL
  // Browser auto-send (VAD endpointing) is a per-device client pref (localStorage),
  // default OFF — see public/app.js. These server fields are reserved for a future
  // server/remote-side VAD (e.g. the phone path) and are unused by the dashboard mic.
  endpointSilenceMs: 0,
  maxRecordMs: 60000
};

// Numeric settings are clamped on write: an unbounded watchdogMs of 0 would
// SIGKILL every injected turn instantly, and anything above 2^31-1 ms makes
// setTimeout fire immediately.
const NUMERIC_BOUNDS = {
  confirmCancelMs: [0, 30000],
  replyWindowMs: [0, 120000],
  autoListenMs: [0, 120000],
  watchdogMs: [60000, 2 * 60 * 60 * 1000],
  stickyMinutes: [1, 24 * 60],
  queueTtlMs: [60000, 2 * 60 * 60 * 1000],
  endpointSilenceMs: [0, 30000],
  maxRecordMs: [5000, 10 * 60 * 1000]
};

// Session ids come from hook-reported state files; only plain id characters may
// reach the `--resume` argument.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// STT silence-hallucination denylist: gpt-4o-transcribe emits these for silent
// or near-silent clips. Discard before the resolver ever sees them.
const HALLUCINATION_DENYLIST = [
  'thank you.', 'thank you', 'thanks for watching.', 'thanks for watching',
  'thank you for watching.', 'thank you for watching', 'you', '.', 'bye.',
  'thanks for watching!', 'please subscribe.', "i'll see you next time."
];

function mountVoice(app, express, serverApi) {
  const {
    getOpenAIKey, readAllStates, broadcast, speakVoiceSystem,
    getVoiceRecords, stateRoot, setTtsHold, setAutoReplyArmed, dropVoiceSystemItems
  } = serverApi;

  const SETTINGS_PATH = path.join(stateRoot, 'voice-settings.json');
  const ALIASES_PATH = path.join(stateRoot, 'voice-aliases.json');
  const QUEUE_PATH = path.join(stateRoot, 'voice-queue.json');

  // ---- Settings persistence ----
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const disk = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...disk };
    settings.enabled = settings.enabled === true;
    settings.confirmSpoken = settings.confirmSpoken === true;
    for (const [k, [lo, hi]] of Object.entries(NUMERIC_BOUNDS)) {
      settings[k] = Number.isFinite(settings[k]) ? Math.min(hi, Math.max(lo, settings[k])) : DEFAULT_SETTINGS[k];
    }
  } catch (e) {
    // Only create the file when it's missing — a corrupt or half-edited file is
    // left alone (the in-memory defaults keep voice off) rather than clobbered.
    if (e && e.code === 'ENOENT') saveSettings();
  }
  function saveSettings() {
    try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch {}
  }

  // ---- Alias map (static file merged with the live registry at resolve time) ----
  let aliasMap = {};
  function loadAliases() {
    try {
      const raw = JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8'));
      aliasMap = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        aliasMap[normalize(k)] = v;
      }
    } catch { aliasMap = {}; }
  }
  loadAliases();

  // ---- Per-agent injection lock: agentId -> { child, startedAt, sessionId } ----
  const injectionLocks = new Map();

  // ---- Text helpers ----
  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
    return dp[m][n];
  }

  // Live registry project names (canonical namespace) from current state files.
  function rosterProjects() {
    const states = readAllStates();
    const names = new Set();
    for (const s of Object.values(states)) {
      if (s.project && s.project !== 'unknown') names.add(s.project);
    }
    return [...names];
  }

  // STT bias prompt: the live roster + wake phrase steer transcription toward
  // real project code names instead of English homophones.
  function sttPrompt() {
    const projects = rosterProjects();
    const aliasNames = [...new Set(Object.values(aliasMap))];
    const all = [...new Set([...projects, ...aliasNames])];
    let p = 'This is a spoken command to an AI coding agent. ';
    if (all.length) p += 'Project code names that may be spoken: ' + all.join(', ') + '. ';
    if (settings.wakePhrase) p += `The wake phrase is "${settings.wakePhrase}". `;
    return p.slice(0, 900);
  }

  // Deterministic fuzzy match of a spoken name against the roster + alias map.
  // Returns the canonical project name or null (never a wrong match — requires a
  // close hit).
  function matchProject(spoken) {
    const key = normalize(spoken);
    if (!key) return null;
    if (aliasMap[key]) return aliasMap[key];
    const candidates = [...new Set([...rosterProjects(), ...Object.values(aliasMap)])];
    // exact normalized match
    for (const c of candidates) if (normalize(c) === key) return c;
    // fuzzy: closest within a strict edit-distance budget
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = levenshtein(key, normalize(c));
      if (d < bestD) { bestD = d; best = c; }
    }
    // also test the raw alias keys (spoken forms) for fuzzy typo tolerance
    for (const k of Object.keys(aliasMap)) {
      const d = levenshtein(key, k);
      if (d < bestD) { bestD = d; best = aliasMap[k]; }
    }
    const budget = Math.max(1, Math.floor(key.length * 0.25));
    return bestD <= budget ? best : null;
  }

  // Apply the fuzzy alias pass to inline project mentions in a free-form command
  // (best-effort; leaves the sentence otherwise intact).
  function applyAliasPass(text) {
    let out = text;
    for (const [k, v] of Object.entries(aliasMap)) {
      if (k.length < 3) continue;
      const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      out = out.replace(re, v);
    }
    return out;
  }

  // Error text from OpenAI can echo part of the key ("Incorrect API key provided:
  // sk-…") — scrub anything key-shaped before it reaches the browser or logs.
  const scrubKeys = (s) => String(s).replace(/sk-[A-Za-z0-9_*.-]{4,}/g, 'sk-…').slice(0, 200);

  // ---- STT via OpenAI gpt-4o-transcribe ----
  async function transcribe(audioBuf, contentType) {
    const key = getOpenAIKey();
    if (!key) return { error: 'no-openai-key' };
    const model = process.env.VOICE_STT_MODEL || 'gpt-4o-transcribe';
    const ext = /wav/.test(contentType) ? 'wav'
      : /mp4|m4a/.test(contentType) ? 'mp4'
      : /mpeg|mp3/.test(contentType) ? 'mp3'
      : /ogg/.test(contentType) ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', sttPrompt());
    form.append('file', new Blob([audioBuf], { type: contentType || 'audio/webm' }), `clip.${ext}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: ctrl.signal
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { error: `stt-http-${resp.status}`, detail: scrubKeys(t) };
      }
      const json = await resp.json();
      return { text: (json.text || '').trim() };
    } catch (e) {
      return { error: 'stt-failed', detail: scrubKeys(e && e.message || e) };
    } finally { clearTimeout(timer); }
  }

  function isHallucination(text) {
    const n = text.toLowerCase().trim().replace(/\s+/g, ' ');
    if (n.length < 2) return true;
    if (HALLUCINATION_DENYLIST.includes(n)) return true;
    // Only alphanumeric-free noise
    if (!/[a-z0-9]/i.test(n)) return true;
    return false;
  }

  // ---- Target resolver (ordered rules; see plan §Reply-target routing) --------
  // Returns { agent, reason } or { agent: null, reason }. `agent` is a state
  // object augmented with a resolved sessionId.
  function resolveTarget(text, opts = {}) {
    const states = readAllStates();
    const live = Object.values(states);
    const records = getVoiceRecords();
    const stickyMs = settings.stickyMinutes * 60 * 1000;
    const now = Date.now();

    const agentById = (id) => states[id] || live.find(s => s.sessionId === id) || null;
    const withSession = (a) => a ? { ...a, sessionId: a.sessionId || a.agentId } : null;

    // Rule 1: explicit address — "tell/ask/switch to <name> ..."
    const m = text.match(/^\s*(?:hey\s+)?(?:tell|ask|switch to|talk to|send to)\s+([a-z0-9 ._-]{2,30}?)[\s,:]/i);
    if (m) {
      const proj = matchProject(m[1]);
      if (proj) {
        const a = live.find(s => s.project === proj && s.status !== 'offline')
          || live.find(s => s.project === proj);
        if (a) return { agent: withSession(a), reason: 'explicit-address', matchedProject: proj, sticky: true };
      }
      // Also allow a bare project name at the start ("axrange, deploy staging")
    }
    // Bare leading project name (stem-press dictation): "<project>, <command>"
    const bare = text.match(/^\s*([a-z0-9 ._-]{2,30}?)[\s]*[,:]\s+/i);
    if (bare) {
      const proj = matchProject(bare[1]);
      if (proj) {
        const a = live.find(s => s.project === proj && s.status !== 'offline')
          || live.find(s => s.project === proj);
        if (a) return { agent: withSession(a), reason: 'bare-address', matchedProject: proj, sticky: true };
      }
    }

    // Rule 2: frozen target pinned at record start (Phase 2)
    if (opts.frozenAgentId) {
      const a = agentById(opts.frozenAgentId);
      if (a) return { agent: withSession(a), reason: 'frozen' };
    }

    // Rules 3–4: sticky default — the FRESHER of the two sweep-proof records.
    // (Order used to be spoken-then-finished unconditionally, which let a stale
    // 15-min-old lastSpokenAgent outrank a session that JUST finished but whose
    // summary hadn't played yet — a daily misroute under multi-session use.)
    const stickyCands = [];
    if (records.lastSpokenAgent && (now - records.lastSpokenAgent.at) < stickyMs) {
      stickyCands.push({ agentId: records.lastSpokenAgent.agentId, at: records.lastSpokenAgent.at, kind: 'sticky-spoken' });
    }
    if (records.lastFinishedAgent && (now - records.lastFinishedAgent.at) < stickyMs) {
      stickyCands.push({ agentId: records.lastFinishedAgent.agentId, at: records.lastFinishedAgent.at, kind: 'sticky-finished' });
    }
    stickyCands.sort((a, b) => b.at - a.at);
    for (const rec of stickyCands) {
      const a = agentById(rec.agentId);
      if (a) return { agent: withSession(a), reason: rec.kind };
    }

    // Rules 4b–5 only consider sessions that finished within the sticky window:
    // without a bound, dictation could land in a session that went quiet hours
    // ago and that nobody is looking at.
    const recentFinish = (s) => s.finishedSince && (now - new Date(s.finishedSince).getTime()) < stickyMs;

    // Rule 4b: exactly one agent with finishedTurn set (state-file flag)
    const finished = live.filter(s => s.finishedTurn && recentFinish(s));
    if (finished.length === 1) {
      return { agent: withSession(finished[0]), reason: 'single-finished' };
    }

    // Rule 5: newest finishedSince across all states
    const withFinish = live.filter(recentFinish)
      .sort((a, b) => new Date(b.finishedSince) - new Date(a.finishedSince));
    if (withFinish.length) {
      return { agent: withSession(withFinish[0]), reason: 'newest-finished' };
    }
    if (finished.length > 1) {
      return { agent: null, reason: 'ambiguous', candidates: finished.map(a => a.project) };
    }

    // Rule 6: nothing usable
    return { agent: null, reason: 'no-target' };
  }

  // ---- Live-status hard gate: re-read `claude agents --json` right before spawn.
  // Returns { injectable, status, blocked } — a session with an open permission
  // dialog is NEVER resume-injected (-p cannot answer it).
  //
  // The CLI list is cached for ~3s: one utterance consults it three times (busy
  // gate, dialog gate, pre-spawn re-check) and each uncached spawnSync costs
  // 0.5–1.5s AND blocks the event loop — tripling it added seconds of dead time
  // to every voice turn (UX review 2026-07-12).
  let liveListCache = { at: 0, arr: null };
  function liveAgentsList() {
    const now = Date.now();
    if (liveListCache.arr && (now - liveListCache.at) < 3000) return liveListCache.arr;
    try {
      const r = spawnSync('claude', ['agents', '--json'], { timeout: 5000, encoding: 'utf8' });
      if (r.error || r.status !== 0) return null;
      const arr = JSON.parse(r.stdout || '[]');
      liveListCache = { at: now, arr };
      return arr;
    } catch { return null; }
  }
  function liveStatus(sessionId) {
    try {
      const arr = liveAgentsList();
      if (!arr) return { status: 'unknown', injectable: true, note: 'cli-unavailable' };
      const entry = arr.find(a => a.sessionId === sessionId);
      // Not in the live interactive list — a session that idled out of the daemon
      // list (or a headless-created one) is still reachable by `--resume`, and it
      // cannot be dialog-blocked, so allow it. A truly dead sessionId surfaces as
      // a non-zero exit through the managed child (spoken error line).
      if (!entry) return { status: 'not-listed', injectable: true, note: 'not-in-live-list' };
      const st = entry.status || 'unknown';
      // waiting + a dialog (waitingFor) => never resume-injected (-p can't answer it)
      if (st === 'waiting' && entry.waitingFor) return { status: st, injectable: false, blocked: 'dialog', waitingFor: entry.waitingFor };
      if (st === 'running') return { status: st, injectable: true, busy: true };
      return { status: st, injectable: true };
    } catch {
      return { status: 'unknown', injectable: true, note: 'parse-failed' };
    }
  }

  // Busy predicate: injection lock OR state-file `active` OR live `running`.
  function isBusy(agentId, sessionId, states) {
    if (injectionLocks.has(agentId)) return { busy: true, why: 'lock' };
    const st = states[agentId];
    if (st && st.status === 'active') return { busy: true, why: 'state-active' };
    const ls = liveStatus(sessionId);
    if (ls.busy) return { busy: true, why: 'live-running' };
    return { busy: false };
  }

  // ---- Injector: managed child that appends a turn to the resumed session ----
  // The injected turn runs the session's tools — don't hand them the dashboard's
  // OpenAI key just because the server process happens to have it in its env.
  function voiceTurnEnv() {
    const env = { ...process.env, AGENTS_HQ_VOICE_TURN: '1' };
    delete env.OPENAI_API_KEY;
    return env;
  }

  function inject(agent, text) {
    const agentId = agent.agentId;
    const sessionId = agent.sessionId || agent.agentId;
    if (!settings.enabled) return { ok: false, error: 'voice-disabled' };
    if (!SESSION_ID_RE.test(sessionId)) {
      speakError(agent, `couldn't deliver to ${agent.project} — invalid session id`);
      return { ok: false, error: 'bad-session-id' };
    }
    const cwd = agent.cwd && fs.existsSync(agent.cwd) ? agent.cwd : process.cwd();
    let child;
    try {
      // The dictated text goes in on stdin, never argv: a transcript that starts
      // with "--" would otherwise be parsed as a CLI flag (e.g. a permission
      // override), and argv is visible to every local user via `ps`.
      child = spawn('claude',
        ['-p', '--resume', sessionId, '--output-format', 'json'],
        { cwd, env: voiceTurnEnv(), stdio: ['pipe', 'pipe', 'pipe'] }
      );
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    } catch (e) {
      speakError(agent, `couldn't start ${agent.project} — ${String(e && e.message || e)}`);
      return { ok: false, error: 'spawn-failed' };
    }

    const lock = { child, startedAt: Date.now(), sessionId };
    injectionLocks.set(agentId, lock);
    broadcastVoice();

    // Drain both pipes so a >64KB --output-format json payload never deadlocks.
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
    child.stderr.on('data', d => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });

    const watchdog = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      speakError(agent, `${agent.project}'s turn timed out`);
    }, settings.watchdogMs);

    child.on('error', (e) => {
      clearTimeout(watchdog);
      injectionLocks.delete(agentId);
      broadcastVoice();
      speakError(agent, `couldn't deliver to ${agent.project} — session may need reopening`);
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      injectionLocks.delete(agentId);
      broadcastVoice();
      if (code !== 0 && code !== null) {
        speakError(agent, `couldn't deliver to ${agent.project} — session may need reopening`);
      }
      // Success path: the injected turn's Stop hook already spoke the reply via
      // the existing pipeline; nothing to do here. Flush any pending queue.
      flushPending(agentId);
    });

    return { ok: true, pid: child.pid };
  }

  function speakError(agent, line) {
    if (!settings.enabled) return;   // a turn that outlived the switch stays silent
    try { speakVoiceSystem(line, { label: 'voice error', agentId: agent && agent.agentId }); } catch {}
  }

  // ---- Pending queue for busy targets (Phase 3, minimal now) ----
  // Persisted so a restart doesn't silently strand a queued utterance.
  let pending = [];
  try {
    const loaded = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    // Shape-validate: a torn or hand-edited file must not crash server startup.
    pending = Array.isArray(loaded)
      ? loaded.filter(p => p && typeof p === 'object' && typeof p.agentId === 'string'
          && typeof p.text === 'string' && Number.isFinite(p.at))
      : [];
  } catch { pending = []; }
  // Entries already expired at boot are dropped SILENTLY: announcing an
  // hours-old loss minutes after a restart is context-free noise (it made every
  // played message trail a "dropped the queued message…" line).
  {
    const bootNow = Date.now();
    const before = pending.length;
    // Voice off at boot → nothing queued may survive to deliver after a later re-enable.
    pending = settings.enabled ? pending.filter(p => (bootNow - p.at) <= (settings.queueTtlMs || 0)) : [];
    if (pending.length !== before) { try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(pending)); } catch {} }
  }
  function savePending() { try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(pending)); } catch {} }
  function queuePending(agentId, sessionId, text) {
    if (!settings.enabled) return;
    // Dedup: re-dictating the same thing at a still-busy agent refreshes the
    // existing entry instead of stacking duplicates (each of which would later
    // deliver — or expire aloud — separately).
    const dup = pending.find(p => p.agentId === agentId && p.text === text);
    if (dup) { dup.at = Date.now(); dup.sessionId = sessionId; }
    else pending.push({ agentId, sessionId, text, at: Date.now() });
    savePending();
    broadcastVoice();
  }
  function flushPending(agentId) {
    if (!settings.enabled) return;   // kill switch also covers queued deliveries
    if (!pending.some(p => p.agentId === agentId)) return;
    const states = readAllStates();
    const now = Date.now();
    const a = states[agentId];
    // Target's state is gone entirely → quietly forget its queue.
    if (!a) {
      pending = pending.filter(p => p.agentId !== agentId);
      savePending(); broadcastVoice();
      return;
    }
    // Drain ALL expired entries in one pass and announce ONCE (one spoken line
    // per flush, never per entry).
    const expired = pending.filter(p => p.agentId === agentId && (now - p.at) > settings.queueTtlMs);
    if (expired.length) {
      pending = pending.filter(p => !expired.includes(p));
      savePending(); broadcastVoice();
      const what = expired.length === 1 ? 'your queued message' : `${expired.length} queued messages`;
      speakVoiceSystem(`Couldn't deliver ${what} to ${a.project} — it stayed busy too long.`, { agentId });
    }
    // Deliver the oldest live entry if the target is free now.
    const idx = pending.findIndex(p => p.agentId === agentId);
    if (idx < 0) return;
    const item = pending[idx];
    const busy = isBusy(agentId, item.sessionId, states);
    if (busy.busy) return;   // still busy; wait for the next close
    pending.splice(idx, 1); savePending(); broadcastVoice();
    inject({ ...a, sessionId: item.sessionId }, item.text);
  }

  // ---- WebSocket voice-state broadcast ----
  function broadcastVoice() {
    broadcast({
      type: 'voice',
      enabled: settings.enabled,
      wakePhrase: settings.wakePhrase,
      confirmSpoken: settings.confirmSpoken,
      injecting: [...injectionLocks.keys()],
      pending: pending.map(p => ({ agentId: p.agentId, at: p.at }))
    });
  }

  // ============================================================
  // The end-to-end handler: (transcript|audio) → resolve → confirm → inject.
  // ============================================================
  async function handleUtterance({ text, audioBuf, contentType, frozenAgentId }) {
    // 1. STT (unless the caller already sent text — phone path)
    let transcript = (text || '').trim();
    if (!transcript && audioBuf) {
      const r = await transcribe(audioBuf, contentType);
      if (r.error) return { action: 'error', error: r.error, detail: r.detail };
      transcript = (r.text || '').trim();
    }
    // Voice may have been switched off during the STT round-trip.
    if (!settings.enabled) return { action: 'discarded', reason: 'voice-disabled', transcript: '' };
    if (!transcript) return { action: 'discarded', reason: 'empty', transcript: '' };
    if (isHallucination(transcript)) return { action: 'discarded', reason: 'hallucination', transcript };

    // 2. Alias pass + resolve
    const aliased = applyAliasPass(transcript);
    const res = resolveTarget(aliased, { frozenAgentId });
    if (!res.agent) {
      const line = res.reason === 'ambiguous'
        ? `Which agent? I have ${(res.candidates || []).join(' and ')} waiting.`
        : 'No target session.';
      speakVoiceSystem(line, { label: 'voice routing' });
      return { action: 'discarded', reason: res.reason, transcript, candidates: res.candidates };
    }

    const agent = res.agent;
    const states = readAllStates();

    // 3. Busy gate
    const busy = isBusy(agent.agentId, agent.sessionId, states);
    if (busy.busy) {
      queuePending(agent.agentId, agent.sessionId, aliased);
      speakVoiceSystem(`${agent.project} is still working — queued.`, { label: 'voice queued', agentId: agent.agentId });
      return { action: 'queued', transcript, target: agent.project, why: busy.why };
    }

    // 4. Live-status hard gate (dialog block)
    const ls = liveStatus(agent.sessionId);
    if (!ls.injectable) {
      if (ls.blocked === 'dialog') {
        speakVoiceSystem(`${agent.project} needs a permission — open it on your phone or keyboard.`, { agentId: agent.agentId });
        return { action: 'error', error: 'dialog-blocked', transcript, target: agent.project };
      }
      speakVoiceSystem(`${agent.project} is no longer available.`, { agentId: agent.agentId });
      return { action: 'error', error: ls.status, transcript, target: agent.project };
    }

    // 5. Spawn. Re-check busy right before spawn (an interactive turn may have
    // started), then inject or queue.
    let cancelled = false;
    const cancelToken = { cancel() { cancelled = true; } };
    const doSpawn = () => {
      if (cancelled || !settings.enabled) return;   // switched off during the confirmation
      const st2 = readAllStates();
      const b2 = isBusy(agent.agentId, agent.sessionId, st2);
      if (b2.busy) {
        queuePending(agent.agentId, agent.sessionId, aliased);
        speakVoiceSystem(`${agent.project} started working — queued.`, { agentId: agent.agentId });
        return;
      }
      inject(agent, aliased);
    };

    if (settings.confirmSpoken) {
      // Protected spoken confirmation; spawn after it plays + cancel window. A
      // clean, complete sentence announcing the target (no truncated transcript
      // echo, which sounded abrupt/random). The client toast shows the full text.
      const proj = agent.project && agent.project !== 'unknown' ? agent.project : 'the session';
      speakVoiceSystem(`Sending your message to ${proj}.`, {
        label: 'voice confirm',
        agentId: agent.agentId,
        onDonePlaying: () => setTimeout(doSpawn, settings.confirmCancelMs)
      });
    } else {
      doSpawn();   // no spoken confirmation — inject straight away
    }

    return { action: 'sent', transcript, target: agent.project, reason: res.reason, cancelToken };
  }

  // ============================================================
  // Routes
  // ============================================================

  // Loopback-only guard for every /api/voice/* route, config included. The voice
  // routes can append turns to live Claude sessions, so they must never be
  // reachable from the LAN (HOST=0.0.0.0) or from a web page that rebinds a
  // hostname to 127.0.0.1 (Host check) or posts cross-site (Origin check).
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  function isLoopbackAddr(a) {
    return !!a && (a === '::1' || /^(::ffff:)?127\./.test(a));
  }
  function hostnameOf(hostHeader) {
    const h = String(hostHeader || '').toLowerCase();
    if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
    return h.split(':')[0];
  }
  function localOnly(req, res, next) {
    if (!isLoopbackAddr(req.socket && req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'voice-local-only' });
    }
    if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
      return res.status(403).json({ error: 'voice-bad-host' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase()); } catch {}
      if (!ok) return res.status(403).json({ error: 'voice-bad-origin' });
    }
    next();
  }
  app.use('/api/voice', localOnly);

  // Master kill-switch gate: every /api/voice/* except /config returns 403 when
  // disabled — this is the server-side rollback promise (covers the phone path).
  function gate(req, res, next) {
    if (!settings.enabled) return res.status(403).json({ error: 'voice-disabled' });
    next();
  }

  // GET/POST config are NOT gated — they are the control surface for the switch.
  app.get('/api/voice/config', (req, res) => {
    res.json({ ...settings });
  });
  app.post('/api/voice/config', (req, res) => {
    const b = req.body || {};
    const allowed = ['enabled', 'wakePhrase', 'confirmSpoken', 'confirmCancelMs',
      'replyWindowMs', 'autoListenMs', 'watchdogMs', 'stickyMinutes', 'queueTtlMs',
      'endpointSilenceMs', 'maxRecordMs'];
    const wasEnabled = settings.enabled;
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      // Strict booleans: `!!"false"` is true, which would switch voice ON.
      if (k === 'enabled' || k === 'confirmSpoken') { if (typeof b[k] === 'boolean') settings[k] = b[k]; }
      else if (k === 'wakePhrase') settings.wakePhrase = String(b[k]).slice(0, 20);
      else if (Number.isFinite(b[k])) {
        const [lo, hi] = NUMERIC_BOUNDS[k];
        settings[k] = Math.min(hi, Math.max(lo, b[k]));
      }
    }
    if (wasEnabled && !settings.enabled) disableRuntime();
    saveSettings();
    broadcastVoice();
    res.json({ ok: true, settings });
  });

  // Voice runtime state (records + locks + pending) — for the widget / phone.
  app.get('/api/voice/state', gate, (req, res) => {
    const records = getVoiceRecords();
    res.json({
      enabled: settings.enabled,
      lastSpokenAgent: records.lastSpokenAgent,
      lastFinishedAgent: records.lastFinishedAgent,
      injecting: [...injectionLocks.keys()],
      pending: pending.map(p => ({ agentId: p.agentId, at: p.at })),
      roster: rosterProjects()
    });
  });

  // The main entrypoint. Accepts raw audio (audio/*) OR JSON { text }.
  app.post('/api/voice/utterance',
    gate,
    express.raw({ type: 'audio/*', limit: '30mb' }),
    express.json(),
    async (req, res) => {
      try {
        let payload = {};
        const ct = req.headers['content-type'] || '';
        if (/^audio\//.test(ct)) {
          payload = { audioBuf: req.body, contentType: ct };
        } else {
          payload = { text: (req.body && req.body.text) || '' };
        }
        payload.frozenAgentId = (req.query && req.query.frozen) ||
          (req.body && req.body.frozenAgentId) || null;
        const result = await handleUtterance(payload);
        // Don't leak the internal cancelToken over the wire.
        const { cancelToken, ...clean } = result;
        res.json(clean);
      } catch (e) {
        res.status(500).json({ action: 'error', error: 'handler-crash', detail: String(e && e.message || e) });
      }
    }
  );

  // Hold/release TTS queue advancement while the reply-window mic is open, so the
  // reopened mic never captures Claude's own voice (window ⇄ TTS are exclusive).
  app.post('/api/voice/hold', gate, (req, res) => {
    const hold = !!(req.body && req.body.hold);
    if (typeof setTtsHold === 'function') setTtsHold(hold);
    res.json({ ok: true, hold });
  });

  // Register whether a client has "answer after each reply" armed, so the server
  // can hold the TTS queue the instant a reply finishes (before the next item
  // starts) — the client's own /hold call is too late for that first item.
  app.post('/api/voice/autoreply', gate, (req, res) => {
    const armed = !!(req.body && req.body.armed);
    if (typeof setAutoReplyArmed === 'function') setAutoReplyArmed(armed);
    res.json({ ok: true, armed });
  });

  // Manual reload of the alias file (after an edit) without a server restart.
  app.post('/api/voice/reload-aliases', gate, (req, res) => {
    loadAliases();
    res.json({ ok: true, aliases: Object.keys(aliasMap).length });
  });

  // Switching voice off drops anything that could still deliver or hold audio
  // later: queued utterances, the armed auto-reply hold, and a held TTS queue.
  // Turns already running are left to finish — killing a mid-turn `claude -p`
  // could leave its session in a half-written state.
  function disableRuntime() {
    pending = []; savePending();
    if (typeof dropVoiceSystemItems === 'function') dropVoiceSystemItems();
    if (typeof setAutoReplyArmed === 'function') setAutoReplyArmed(false);
    if (typeof setTtsHold === 'function') setTtsHold(false);
  }

  // Clean shutdown: kill any in-flight injected children so a restart isn't
  // blocked and locks never leak.
  function shutdown() {
    for (const { child } of injectionLocks.values()) {
      try { child.kill('SIGKILL'); } catch {}
    }
    injectionLocks.clear();
  }

  broadcastVoice();
  return { settings, isEnabled: () => settings.enabled, shutdown, flushPending, _test: { resolveTarget, matchProject, isHallucination, applyAliasPass, liveStatus } };
}

module.exports = { mountVoice, DEFAULT_SETTINGS };
