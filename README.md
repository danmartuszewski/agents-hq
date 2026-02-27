# Agents HQ

A live dashboard for watching Claude Code agents work. Start a team of agents (researcher, coder, tester) and get a real-time floor view of each one - what tool they're running, what task they're on, when they go idle, and when they finish.

Agents are grouped by project (derived from `cwd`) and by type. The dashboard builds itself as agents report in - no config file needed. Main Claude Code sessions show up too, not just subagents.

## Views

Four layouts, switchable from the header:

**HQ** - 3D isometric floor with agents as spheres, grouped by project. Drag to orbit, scroll to zoom, alt+click to pan. Active agents pulse faster based on how many tools they've called recently. A mini-map appears when you're zoomed in.

**List** - Table with status, agent type, current task, tool, and last active time. Rows grouped under collapsible project headers.

**Cards** - Grid layout with one card per agent showing live status and task. Cards grouped under collapsible project sections.

**Graph** - 3D network view with project clusters and connection lines. Lines between agents get thicker based on how many messages they've exchanged. Inter-agent messages animate as traveling dots.

## Agent detail panel

Click any agent in any view to open the detail panel. Shows:

- Current status, uptime, event count, tool count
- Activity sparkline (5-minute window of tool calls)
- Tool usage bars with call counts and average durations
- Full event log

The sparkline and all panel elements follow the active theme.

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3141`.

## Hooking into Claude Code

### Global setup (recommended, all projects)

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

**Important**: Global hooks in `~/.claude/settings.json` use absolute paths since they run from any working directory. The `matcher: ""` means all tools are tracked.

### Per-project setup

If you only want tracking for a single project, add the same hooks to that project's `.claude/settings.json` instead. The per-project version in this repo uses relative paths through a shell wrapper (`bash .claude/hooks/agent-tracker.sh`), which works because hooks run from the project root.

### Hook events

- **PreToolUse** - fires before a tool runs. Updates current tool and extracts details (file paths, commands, search patterns, message recipients).
- **PostToolUse** - fires after a tool finishes. Clears the tool indicator and records duration.
- **SubagentStart** - agent appears as active on the dashboard.
- **SubagentStop** - agent goes offline. The hook parses the subagent's transcript file to retroactively extract all tool calls made during its lifetime (since PreToolUse/PostToolUse don't fire for subagent processes).

Main sessions (no `agent_id`) are tracked via `session_id` and show as type `lead`. Subagents use `agent_id` directly.

### Subagent tool tracking

Claude Code's PreToolUse and PostToolUse hooks only fire for the main session, not for subagent processes. To work around this, the tracker parses the subagent's transcript file (`agent_transcript_path` from the SubagentStop event) when the subagent finishes. This extracts tool names, timestamps, and details retroactively, so the dashboard shows the full tool history after the subagent completes.

### Timeouts

Agents with no activity for 60 seconds are marked idle. After 5 minutes they go offline.

### Custom dashboard URL

Set `AGENTS_HQ_URL` if the dashboard isn't on localhost:

```bash
export AGENTS_HQ_URL=http://192.168.1.50:3141
```

## Inter-agent messages

When agents use the `SendMessage` tool, the dashboard captures the recipient, message type, and content. These show up in the activity log with arrow indicators (`[->]` for direct messages, `[>>]` for broadcasts) and animate as traveling dots in the graph view.

## Search and notifications

The search box in the header filters agents across all views by ID, type, project, or current task. In the HQ view, non-matching agents are dimmed.

When an active agent goes offline unexpectedly (skipping the idle state), the dashboard plays an audio beep and sends a desktop notification. The mute button in the header disables both.

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
POST /api/agent/:id/status          # update an agent's status
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

10 color themes, switchable from the header: Matrix, Neon Abyss, Tokyo Drift, Arctic Frost, Velvet Dusk, Burnished Iron, Signal Red, One Dark, Dracula, Horizon. Theme selection persists in localStorage.

## Data model

No static config file. The server builds its registry from incoming hook events.

**Registry entry** (one per unique agent): `agentId`, `agentType`, `project`, `cwd`, `sessionId`, `color`, `abbreviation`.

**State file** (`state/agents/{id}.json`): same fields plus `status`, `currentTask`, `currentTool`, `lastActivity`, `sessionStart`, `lastMessage`, `toolDetail`, `lastToolDuration`, `lastCompletedTool`.

Projects come from `cwd` (last directory segment). Same agent type gets the same color everywhere. Display names are `@researcher` if there's one instance, `@researcher #1` / `@researcher #2` if multiple.

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
  test-hooks.sh        Realistic multi-agent session test
  report-status.sh     Manual status update helper
.claude/
  settings.json        Per-project hook configuration
  hooks/
    agent-tracker.sh   Shell wrapper (for per-project relative paths)
    agent-tracker.js   Receives hook events, parses transcripts, POSTs to dashboard
```
