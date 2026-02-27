# Agents HQ

A dashboard that shows what your Claude Code agents are doing in real time. You spin up a team (researcher, coder, tester, whatever) and this gives you a live floor view of each one - what tool it's running, what it's working on, when it goes idle, when it finishes.

Agents are grouped by project (derived from `cwd`) and by type. The dashboard builds itself as agents report in, no config needed. Main Claude Code sessions show up too, not just subagents.

## Views

Four layouts, switchable from the header:

**HQ** - 3D isometric floor with agents as spheres, grouped by project. Drag to orbit, scroll to zoom, alt+click to pan. Active agents pulse faster the more tools they've called recently. A mini-map shows up when you're zoomed in.

**List** - Plain table with status, agent type, current task, tool, and last active time. Rows grouped under collapsible project headers.

**Cards** - Grid of cards, one per agent, showing live status and task. Grouped under collapsible project sections.

**Graph** - 3D network view with project clusters and connection lines. Lines get thicker as agents exchange more messages. Messages animate as traveling dots.

## Agent detail panel

Click any agent in any view to open the detail panel. It shows:

- Status, uptime, event count, tool count
- Activity sparkline (5-minute window of tool calls)
- Tool usage bars with call counts and average durations
- Full event log

Everything in the panel follows the active theme.

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3141`.

## Hooking into Claude Code

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

WebSocket message types: `init`, `update`, `config_update`, `agent_message`, `message_history`, `subagent_tools`.

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
