<p align="center">
  <img src="assets/icon.svg" height="128">
</p>

<h1 align="center">Agents HQ</h1>

<p align="center">
  See what every Claude Code instance is doing.
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Agents HQ demo" width="800">
</p>

A real-time dashboard for your Claude Code agents. You spin up a team (researcher, coder, tester, whatever) and this gives you a live floor view of each one - what tool it's running, what it's working on, when it goes idle, when it finishes.

Agents are grouped by project (derived from `cwd`) and by type. The dashboard builds itself as agents report in, no config needed. Main Claude Code sessions show up too, not just subagents.

## Views

Six layouts, switchable from the header (or press `1`-`6`):

**HQ** - 3D isometric floor with agents as spheres, grouped by project. Drag to orbit, scroll to zoom, alt+click to pan. Active agents pulse faster the more tools they've called recently. A mini-map shows up when you're zoomed in.

**List** - Plain table with status, agent type, current task, tool, and last active time. Rows grouped under collapsible project headers.

**Cards** - Grid of cards, one per agent, showing live status and task. Grouped under collapsible project sections.

**Graph** - 3D network view with project clusters and connection lines. Lines get thicker as agents exchange more messages. Messages animate as traveling dots.

**Tree** - Hierarchical view showing which agent spawned which. Lead agents are roots, subagents are nested children. Agents whose parent went offline show in a separate "orphaned" section.

**Timeline** - Gantt chart of agent activity over time. Each agent gets a row with color-coded bars for active, idle, and offline spans. Drag to pan, scroll to zoom. A "NOW" line marks the current time, and active spans pulse at the right edge.

## Project stats

Project headers in the List and Cards views show aggregate stats: active/idle/offline agent counts, total tool calls, average session duration, and crash count. Below that, a mini bar chart shows the top 5 most-used tools across the project.

## Keyboard shortcuts

Press `?` to see all shortcuts. The main ones:

- `1`-`6` switch views (HQ, List, Cards, Graph, Tree, Timeline)
- `/` focuses the search box, `Esc` clears it or closes panels
- `j`/`k` or arrow keys cycle through agents, `Enter` opens the detail panel
- `t` cycles the color theme, `r` resets the camera in HQ/Graph
- `p` pauses/resumes the spoken voice queue, `m` mutes/unmutes the voice (do-not-disturb)
- `o` expands the selected agent's output into a full-screen reader

## Agent detail panel

Click any agent in any view to open the detail panel. It shows:

- Status, uptime, event count, tool count
- Activity sparkline (5-minute window of tool calls)
- Tool usage bars with call counts and average durations
- Full event log

Everything in the panel follows the active theme.

## Output

Instead of reading an agent's raw response in the terminal, the dashboard can show its **finished output nicely formatted** right in the detail panel. Turn it on under **SETTINGS → Output** ("Show agent output in detail panel") — it's off by default.

When on, an **OUTPUT** section appears in the agent detail panel, rendering the agent's last completed message as clean Markdown — headings, lists, tables, code blocks, bold/italic, and links.

- **Deterministic and local** — the Markdown is rendered client-side. No API call, no cost, no latency, and the output is shown verbatim (nothing is summarized, reordered, or rewritten — unlike the spoken [Voice](#voice) summaries).
- **Safe** — every character is HTML-escaped before rendering, so raw HTML in an agent's output (e.g. a `<script>` tag) shows as text and never executes.
- **Expand to a full-screen reader** — the sidebar is narrow, so click the expand (⤢) button in the OUTPUT header, click the preview, or press **`o`** to open the output in a centered popup. Wide tables and long code blocks get room to breathe; press `Esc`, click the backdrop, or hit the ✕ to close. A **Copy** button copies the raw Markdown.

The last finished output is cached per agent, so it stays readable even after the agent starts its next turn. Everything follows the active theme.

## Voice

The dashboard can **speak agent responses out loud**, queued one at a time across all your concurrent agents — so you can keep working in another window and just listen as each agent finishes. Everything is configured under **NOTIFY → SPEAK (TTS)**.

### Speaking responses

- **Speak responses** — when an agent finishes a turn, its final message is read aloud.
- **Speak attention asks** — permission prompts / "needs input" moments are read aloud too, and they **jump the queue** ahead of finished-turn summaries.
- Each line is prefixed with **project then agent** ("AxRange. researcher says: …") so you instantly know who's talking when several projects run at once.

### The voice queue

Click the **🔊 N** indicator in the header to open a live queue panel showing what's speaking now and what's lined up, labelled by project · agent. From there you can:

- **Skip** the current line, **Stop all**, or remove a single queued item (✕).
- **Pause / Resume** the speech (button, or press **`p`**) — freezes mid-sentence and holds the queue, e.g. while you take a call.
- **Click a queue row** to jump to that agent's detail panel.

Agents currently speaking or queued are also marked in the **List** and **Cards** views (🔊 / 🔈 plus an accent bar), and the queue survives concurrent agents finishing at once (they're spoken in arrival order; an agent that starts a new turn has its stale queued summary dropped).

### Summarize for listening

Raw agent output is full of code blocks, paths, and markdown that sound terrible read verbatim. With **Summarize for listening** on (default), each response is rewritten into a short, outcome-first spoken summary. Three backends, picked automatically (override with `TTS_SUMMARIZER`):

1. **`claude -p` (subscription)** — uses your Claude Code login, **no API key, no extra cost**. Chosen automatically when the `claude` CLI is installed and no Anthropic key is set. Pick the model with `TTS_SUMMARY_MODEL` (e.g. `sonnet`, `opus`, `haiku`).
2. **Anthropic API** — fastest, billed per call. Used when `ANTHROPIC_API_KEY` is set. Defaults to Haiku 4.5.
3. **Local heuristic** — no key, instant, extractive (first sentences, markdown stripped). The fallback if neither is available.

The dashboard's own summarizer calls are tagged so they never show up as phantom agents.

### Voices (local `say` or OpenAI)

- **`say` (default)** — free, local macOS voices. No key. Pick one in the **Voice** dropdown (the dropdown lists the active engine's voices); set the rate too.
- **OpenAI** — much better voices via `gpt-4o-mini-tts` (calm-narrator tone). Paste your key into the **OpenAI key** field in the SPEAK panel and click **Save key** — it's stored server-side (`state/secrets.json`, git-ignored, never sent back to the browser; only a masked hint is shown). Once set, the engine switches to OpenAI automatically. Configurable via `TTS_OPENAI_VOICE` / `TTS_OPENAI_MODEL`, or `OPENAI_API_KEY` as an env fallback.
- **Distinct voice per project** — give each project its own voice from the active engine's pool, so you recognize the project by sound.

If an API voice call fails, it falls back to local `say` so speech never breaks.

### Hardware media keys & background playback

Speech plays through a hidden `<audio>` element with a **Media Session**, so your Mac's hardware play/pause keys, the Now Playing widget, and AirPods control it, and it keeps playing while the dashboard tab is in the background. (One click on the page per load is needed to satisfy the browser's autoplay policy.)

### Pause your other media while speaking

With **Pause other media while speaking** on, the dashboard pauses whatever's playing on your Mac (Safari, Apple Music, podcasts — anything that responds to the play/pause key) before an agent speaks, and resumes it when the queue goes idle. This needs a small tool:

```bash
brew install nowplaying-cli
```

Without it, the toggle no-ops. (macOS has no built-in command to reach the system media controls, which is why the extra tool is required.)

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3141`.

### Running in background

`npm start` occupies a terminal. To run the dashboard without keeping a terminal open:

**Quick (session-only)**

```bash
nohup npm start > /tmp/agents-hq.log 2>&1 &
```

The server runs in the background and survives closing the terminal. Logs go to `/tmp/agents-hq.log`. To stop it:

```bash
lsof -ti:3141 | xargs kill
```

**Auto-start on login (macOS launchd)**

Create `~/Library/LaunchAgents/com.agents-hq.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agents-hq.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/agents-hq/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/agents-hq</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/agents-hq.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agents-hq.stderr.log</string>
</dict>
</plist>
```

Replace `/usr/local/bin/node` with your node path (`which node`) and `/path/to/agents-hq` with the actual project path. Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.agents-hq.server.plist
```

This starts the server automatically on login and restarts it if it crashes. To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.agents-hq.server.plist
```

## Hooking into Claude Code

### Let an agent install it

For a hands-off install, hand the repo to Claude Code (or any AI agent) and say:

> Follow `INSTALL.md` in this repo to install Agents HQ for me.

The agent will install deps, start the server, merge the hooks into `~/.claude/settings.json`, and run a smoke test. See [INSTALL.md](INSTALL.md) for the exact procedure.

### Global setup (recommended)

Add hooks to `~/.claude/settings.json` so every Claude Code session reports to the dashboard:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js PreToolUse"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js PostToolUse"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js SubagentStart"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js SubagentStop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js Notification"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js UserPromptSubmit"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js Stop"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/agents-hq` with the actual absolute path. This tracks every Claude Code window across all projects, including the main session (shown as `@lead`).

Global hooks need absolute paths since they run from any working directory. `matcher: ""` means all tools are tracked.

### Per-project setup

If you only want tracking for one project, add the same hooks to that project's `.claude/settings.json` instead. The per-project version in this repo uses relative paths through a shell wrapper (`bash .claude/hooks/agent-tracker.sh`), which works because hooks run from the project root.

### Hook events

- `PreToolUse` - fires before a tool runs. Updates the current tool and extracts details (file paths, commands, search patterns, message recipients).
- `PostToolUse` - fires after a tool finishes. Clears the tool indicator and records duration.
- `SubagentStart` - agent appears on the dashboard as active.
- `SubagentStop` - agent goes offline. The hook parses the subagent's transcript to extract all tool calls made during its lifetime, since PreToolUse/PostToolUse don't fire for subagent processes.
- `Notification` - fires when Claude needs the user (tool-permission prompt or idle wait). Combined with `Stop`, the dashboard classifies the signal as either **attention** (red dot, beep — permission/question mid-task) or **finished** (green dot, silent — idle wait after the turn ended). Main-session only — Claude Code does not fire this for subagents.
- `Stop` - fires when Claude finishes responding. Marks the agent as "turn finished" so a follow-up `Notification` is treated as an idle wait rather than a real ask.
- `UserPromptSubmit` - fires when the user submits a new prompt. Clears the awaiting and finished flags. `PreToolUse` also clears them, so this hook is optional but recommended for snappier UI.

Main sessions (no `agent_id`) are tracked via `session_id` and show as type `lead`. Subagents use `agent_id` directly.

### Subagent tool tracking

Claude Code's PreToolUse and PostToolUse hooks only fire for the main session, not subagents. To work around this, the tracker parses the subagent's transcript file (`agent_transcript_path` from the SubagentStop event) when the subagent finishes. It extracts tool names, timestamps, and details retroactively, so the dashboard gets the full tool history after the subagent completes.

### Timeouts

No activity for 60 seconds marks an agent idle. After 5 minutes it goes offline.

### Custom dashboard URL

Set `AGENTS_HQ_URL` if the dashboard isn't on localhost:

```bash
export AGENTS_HQ_URL=http://192.168.1.50:3141
```

## Inter-agent messages

When agents use `SendMessage`, the dashboard captures the recipient, message type, and content. These show up in the activity log with arrow indicators (`[->]` for direct messages, `[>>]` for broadcasts) and animate as traveling dots in the graph view.

## Search and notifications

The search box filters agents across all views by ID, type, project, or current task. In HQ view, non-matching agents are dimmed.

If an active agent drops offline unexpectedly (skipping idle), the dashboard plays a beep and sends a desktop notification. The mute button in the header disables both.

## Try it without Claude Code

The simulation script populates the dashboard with fake activity across two projects:

```bash
npm run simulate
```

There's also a scripted multi-agent session that walks through research, implementation, testing, and review phases:

```bash
bash scripts/test-hooks.sh
```

And a manual status updater:

```bash
bash scripts/report-status.sh <agent-id> <status> [task] [tool] [agent-type] [cwd]
bash scripts/report-status.sh c-001 active "Reviewing strategy" "Read" coder /projects/my-api
```

## API

The server watches `state/agents/` for file changes and pushes updates to browsers over WebSocket.

```
GET  /api/config                    # agent registry
GET  /api/agents                    # all agent states
GET  /api/messages                  # inter-agent message history
POST /api/agent/:id/status          # update agent status
POST /api/cleanup/offline-agents    # remove all offline agents
POST /api/cleanup/offline-projects  # remove projects where every agent is offline
POST /api/reset                     # clear all state and registry

# Voice (text-to-speech)
GET  /api/voices                    # voices for the active engine (say or OpenAI)
GET  /api/config/keys               # masked status of UI-set keys (OpenAI)
POST /api/config/keys               # set/clear the OpenAI key (stored server-side)
POST /api/speak                     # queue an utterance
GET  /api/speak/audio/:file         # serve a rendered audio file
POST /api/speak/done                # browser reports current clip finished
POST /api/speak/skip                # skip current
POST /api/speak/pause               # pause playback (hold queue)
POST /api/speak/resume              # resume playback
POST /api/speak/stop                # clear the queue and stop
POST /api/speak/remove              # remove one queued item by id
```

POST body for status updates:

```json
{
  "status": "active",
  "currentTask": "Writing auth middleware",
  "currentTool": "Write",
  "agentType": "coder",
  "cwd": "/projects/my-api",
  "sessionId": "sess-001",
  "hookEvent": "PreToolUse"
}
```

Status values: `active`, `idle`, `offline`.

WebSocket message types: `init`, `update`, `config_update`, `agent_message`, `message_history`, `subagent_tools`, `tts` (voice queue state).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3141` | Server port |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default so the dashboard and voice endpoints aren't reachable from the LAN — set `0.0.0.0` to expose deliberately. |
| `AGENTS_HQ_URL` | `http://localhost:3141` | Where hooks POST to (set if the dashboard isn't on localhost) |
| `TTS_ENGINE` | auto | Voice engine: `say` or `openai`. Auto-picks `openai` when an OpenAI key is set, else `say`. |
| `OPENAI_API_KEY` | — | OpenAI voice key (env fallback; the UI field is preferred and takes precedence) |
| `TTS_OPENAI_VOICE` | `nova` | OpenAI voice (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer) |
| `TTS_OPENAI_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS model |
| `TTS_OPENAI_INSTRUCTIONS` | calm-narrator preset | Tone instructions for `gpt-4o-mini-tts` |
| `TTS_SUMMARIZER` | auto | Summary backend: `cli`, `api`, or `heuristic`. Auto: `api` if Anthropic key, else `cli` if `claude` installed, else `heuristic`. |
| `TTS_SUMMARY_MODEL` | `sonnet` (cli) / `claude-haiku-4-5` (api) | Model for the summary rewrite |
| `ANTHROPIC_API_KEY` | — | Enables the API summary backend |

## Themes

10 color themes in the header: Matrix, Neon Abyss, Tokyo Drift, Arctic Frost, Velvet Dusk, Burnished Iron, Signal Red, One Dark, Dracula, Horizon. Selection persists in localStorage.

## Data model

No static config file. The server builds its registry from incoming hook events.

Registry entry (one per unique agent): `agentId`, `agentType`, `project`, `cwd`, `sessionId`, `color`, `abbreviation`.

State file (`state/agents/{id}.json`): same fields plus `status`, `currentTask`, `currentTool`, `lastActivity`, `sessionStart`, `lastMessage`, `toolDetail`, `lastToolDuration`, `lastCompletedTool`.

Projects come from `cwd` (last directory segment). Same agent type gets the same color everywhere. Display names are `@researcher` if there's one, `@researcher #1` / `@researcher #2` if there are several.

## Project structure

```
server.js              Express + WebSocket server, file watcher, heartbeat sweep
public/
  index.html           Dashboard shell
  app.js               Views, 3D engine, sparklines, interaction handlers
  style.css            Themes and layout
state/
  agents/              Runtime state files (one JSON per agent)
scripts/
  simulate.js          Random activity simulator
  test-hooks.sh        Multi-agent session test
  report-status.sh     Manual status update helper
.claude/
  settings.json        Per-project hook configuration
  hooks/
    agent-tracker.sh   Shell wrapper (for per-project relative paths)
    agent-tracker.js   Receives hook events, parses transcripts, POSTs to dashboard
```
