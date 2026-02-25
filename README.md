# Agents HQ

Real-time dashboard for watching AI agent teams work. Built for Claude Code's multi-agent workflows - when you spawn a team of agents (researcher, coder, tester, etc.), this gives you a live view of what each one is doing.

The dashboard picks up agent activity through Claude Code hooks. Agents appear on screen as they start, you see which tools they're using in real time, and they disappear when they finish. No config needed for new agents - they register themselves automatically.

## Views

**HQ** - 3D isometric floor with agents as shaded spheres, grouped by department. Drag to orbit, scroll to zoom, alt+click to pan.

**List** - Traditional table with status, current task, tool in use, and last active time.

**Cards** - Grid of agent cards showing live status and task progress bars.

**Graph** - 3D network graph showing department clusters and inter-agent connections. Same orbit/zoom/pan controls as HQ.

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3000`.

## Connecting to Claude Code

The project includes hooks that report agent activity to the dashboard. Copy the hooks config into your Claude Code project:

```bash
# From your project directory
mkdir -p .claude/hooks
cp /path/to/agents-hq/.claude/hooks/agent-tracker.sh .claude/hooks/
cp /path/to/agents-hq/.claude/hooks/agent-tracker.js .claude/hooks/
cp /path/to/agents-hq/.claude/settings.json .claude/settings.json
```

The hooks fire on four events:
- **SubagentStart** - agent appears on dashboard as active
- **SubagentStop** - agent goes offline
- **PreToolUse** - shows which tool the agent is about to use
- **PostToolUse** - clears the tool indicator

New agents register themselves automatically. If an agent type isn't in `config/agents.json`, the server assigns it a color and grid position and adds it to the SUBAGENT department.

Set `AGENTS_HQ_URL` if the dashboard runs somewhere other than `localhost:3000`:

```bash
export AGENTS_HQ_URL=http://192.168.1.50:3000
```

## Testing without Claude Code

Run the simulation script to populate the dashboard with fake agent activity:

```bash
npm run simulate
```

Or run the hook integration test, which simulates a realistic multi-agent session (research, implementation, testing, review):

```bash
bash scripts/test-hooks.sh
```

There's also a manual status script:

```bash
bash scripts/report-status.sh <agent-id> <status> [task] [tool]
bash scripts/report-status.sh ceo active "Reviewing strategy" "Read"
```

## API

All state updates go through HTTP or file writes. The server watches `state/agents/` for changes and pushes updates to connected browsers via WebSocket.

```
GET  /api/config              # agent config (grows as new agents appear)
GET  /api/agents              # all agent states
POST /api/agent/:id/status    # update an agent's status
POST /api/reset               # clear all state, reload config
```

POST body for status updates:

```json
{
  "status": "active",
  "currentTask": "Writing auth middleware",
  "currentTool": "Write",
  "agentType": "coder",
  "agentId": "c-001"
}
```

Status values: `active`, `idle`, `offline`.

## Themes

10 built-in color themes, switchable from the header:

Matrix, Neon Abyss, Tokyo Drift, Arctic Frost, Velvet Dusk, Burnished Iron, Signal Red, One Dark, Dracula, Horizon

## Pre-configured agents

`config/agents.json` defines agents that appear on the dashboard at startup. Each agent has an id, display name, abbreviation (shown inside the sphere), department, color, and grid position for the HQ view.

Departments: C-SUITE, OPERATIONS, CREATIVE, SUBAGENT (auto-assigned).

## Project structure

```
server.js              Express + WebSocket server, file watcher
public/
  index.html           Dashboard shell
  app.js               All view renderers, 3D engine, interaction handlers
  style.css            Themes and layout
config/
  agents.json          Pre-configured agent definitions
state/
  agents/              Runtime state files (one JSON per agent)
scripts/
  simulate.js          Random activity simulator
  test-hooks.sh        Realistic multi-agent session test
  report-status.sh     Manual status update helper
.claude/
  settings.json        Hook configuration for Claude Code
  hooks/
    agent-tracker.sh   Shell wrapper
    agent-tracker.js   Receives hook events, POSTs to dashboard
```
