# Agents HQ

A dashboard that shows what your AI agents are doing while they work. You start a Claude Code team (researcher, coder, tester, whatever), and this gives you a live floor view of each agent - what tool they're running, what task they're on, when they go idle or finish.

Agents register themselves when they first appear. You don't need to configure anything upfront.

## Views

The dashboard has four layouts you can switch between:

HQ is a 3D isometric floor with agents as shaded spheres, grouped by department. Drag to orbit, scroll to zoom, alt+click to pan.

List is a plain table - status, current task, tool, last active time.

Cards is a grid layout with one card per agent showing live status and a task progress bar.

Graph is a 3D network view with department clusters and connection lines between agents. Same orbit/zoom/pan as HQ.

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3000`.

## Hooking into Claude Code

Copy the hooks into your Claude Code project:

```bash
# From your project directory
mkdir -p .claude/hooks
cp /path/to/agents-hq/.claude/hooks/agent-tracker.sh .claude/hooks/
cp /path/to/agents-hq/.claude/hooks/agent-tracker.js .claude/hooks/
cp /path/to/agents-hq/.claude/settings.json .claude/settings.json
```

Four hook events drive the dashboard:

- SubagentStart - agent shows up as active
- SubagentStop - agent goes offline
- PreToolUse - updates which tool the agent is running
- PostToolUse - clears the tool indicator

If an agent type isn't in `config/agents.json`, the server creates it on the fly with an auto-assigned color and grid position under the SUBAGENT department.

Set `AGENTS_HQ_URL` if the dashboard isn't on localhost:

```bash
export AGENTS_HQ_URL=http://192.168.1.50:3000
```

## Try it without Claude Code

The simulation script populates the dashboard with fake activity:

```bash
npm run simulate
```

There's also a scripted multi-agent session that walks through research, implementation, testing, and review phases:

```bash
bash scripts/test-hooks.sh
```

And a manual status updater:

```bash
bash scripts/report-status.sh <agent-id> <status> [task] [tool]
bash scripts/report-status.sh ceo active "Reviewing strategy" "Read"
```

## API

The server watches `state/agents/` for file changes and pushes updates to browsers over WebSocket. You can also hit the HTTP endpoints directly:

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

10 color themes, switchable from the header: Matrix, Neon Abyss, Tokyo Drift, Arctic Frost, Velvet Dusk, Burnished Iron, Signal Red, One Dark, Dracula, Horizon.

## Agent config

`config/agents.json` defines the agents that show up at startup. Each one has an id, display name, abbreviation (the text inside the sphere), department, color, and grid position for the HQ floor.

Departments: C-SUITE, OPERATIONS, CREATIVE. Dynamically created agents go into SUBAGENT.

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
