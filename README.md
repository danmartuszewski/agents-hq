# Agents HQ

A dashboard that shows what your AI agents are doing while they work. You start a Claude Code team (researcher, coder, tester, whatever), and this gives you a live floor view of each agent - what tool they're running, what task they're on, when they go idle or finish.

Agents are grouped by project (derived from `cwd`) and by type. The dashboard starts empty and builds itself as agents report in - no config file needed. Main Claude Code sessions show up too, not just subagents.

## Views

The dashboard has four layouts you can switch between:

HQ is a 3D isometric floor with agents as shaded spheres, grouped by project. Drag to orbit, scroll to zoom, alt+click to pan.

List is a plain table - status, agent type, current task, tool, last active time. Rows are grouped under project headers.

Cards is a grid layout with one card per agent showing live status and task. Cards are grouped under project sections.

Graph is a 3D network view with project clusters and connection lines between agents. Same orbit/zoom/pan as HQ.

## Setup

```
npm install
npm start
```

Opens at `http://localhost:3000`.

## Hooking into Claude Code

### Global setup (all projects)

Add hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js PreToolUse" }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js PostToolUse" }] }],
    "SubagentStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js SubagentStart" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/agents-hq/.claude/hooks/agent-tracker.js SubagentStop" }] }]
  }
}
```

Replace `/path/to/agents-hq` with the actual path. This tracks every Claude Code window, including the main session (shown as `@lead`).

### Per-project setup

Copy the hooks into your project's `.claude/` directory and add the settings there instead. See `.claude/settings.json` in this repo for the format.

### Hook events

- **SubagentStart** — agent appears as active
- **SubagentStop** — agent goes offline
- **PreToolUse** — updates which tool the agent is running (fires for main session too)
- **PostToolUse** — clears the tool indicator

Main sessions (no `agent_id`) are tracked via `session_id` and show as type `lead`. Subagents use `agent_id` directly.

Agents with no activity for 60s are marked idle. After 5 minutes they go offline.

Set `AGENTS_HQ_URL` if the dashboard isn't on localhost:

```bash
export AGENTS_HQ_URL=http://192.168.1.50:3000
```

## Try it without Claude Code

The simulation script populates the dashboard with fake activity across two projects:

```bash
npm run simulate
```

There's also a scripted multi-agent session that walks through research, implementation, testing, and review phases with agents in two different projects:

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
GET  /api/config              # agent registry (grows as agents report in)
GET  /api/agents              # all agent states
POST /api/agent/:id/status    # update an agent's status
POST /api/reset               # clear all state and registry
```

POST body for status updates:

```json
{
  "status": "active",
  "currentTask": "Writing auth middleware",
  "currentTool": "Write",
  "agentType": "coder",
  "cwd": "/projects/my-api",
  "sessionId": "sess-001"
}
```

Status values: `active`, `idle`, `offline`.

## Themes

10 color themes, switchable from the header: Matrix, Neon Abyss, Tokyo Drift, Arctic Frost, Velvet Dusk, Burnished Iron, Signal Red, One Dark, Dracula, Horizon.

## Data model

No static config file. The server builds its registry from incoming hook events.

**Registry entry** (one per unique agent): `agentId`, `agentType`, `project`, `cwd`, `sessionId`, `color`, `abbreviation`.

**State file** (`state/agents/{id}.json`): same fields plus `status`, `currentTask`, `currentTool`, `lastActivity`, `lastMessage`.

Projects come from `cwd` (last directory segment). Same agent type gets the same color everywhere. Display names are `@researcher` if there's one instance, `@researcher #1` / `@researcher #2` if multiple.

## Project structure

```
server.js              Express + WebSocket server, file watcher, heartbeat sweep
public/
  index.html           Dashboard shell
  app.js               All view renderers, 3D engine, interaction handlers
  style.css            Themes and layout
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
