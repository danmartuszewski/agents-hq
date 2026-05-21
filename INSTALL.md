# Install Agents HQ

Instructions for an AI agent (Claude Code, etc.) to install Agents HQ for a user.

Hand this file to your agent: **"Follow `INSTALL.md` in this repo to install Agents HQ for me."**

---

## Procedure

### 1. Verify prerequisites

Run, in order. If any fails, stop and report the error to the user.

```bash
node --version    # require v18+
npm --version
```

### 2. Resolve the install path

Determine the absolute path of this repository.

```bash
REPO_PATH="$(pwd)"
```

Store this — every hook command needs the absolute path. If you are not running from inside the repo, ask the user where they cloned it.

### 3. Install dependencies

```bash
npm install
```

### 4. Start the dashboard server

Start it in the background and confirm it is listening on port 3141.

```bash
nohup npm start > /tmp/agents-hq.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://localhost:3141/
```

A `200` confirms the server is up. If the port is already in use, ask the user whether to kill the existing process (`lsof -ti:3141 | xargs kill`) or pick a different port.

### 5. Install global Claude Code hooks

Read the user's current global settings:

```bash
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
```

Merge the six hook entries below into `$SETTINGS` under the `hooks` key. **Do not overwrite** other unrelated keys the user already has. If the user already has hooks for the same events, append rather than replace, and tell the user what you appended.

Hooks to add (replace `{{REPO_PATH}}` with the value from step 2):

```json
{
  "hooks": {
    "PreToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js PreToolUse"}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js PostToolUse"}]}],
    "SubagentStart": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js SubagentStart"}]}],
    "SubagentStop": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js SubagentStop"}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js Notification"}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js UserPromptSubmit"}]}],
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "node {{REPO_PATH}}/.claude/hooks/agent-tracker.js Stop"}]}]
  }
}
```

Validate the JSON after writing:

```bash
node -e "JSON.parse(require('fs').readFileSync('$HOME/.claude/settings.json', 'utf8'))" && echo "settings.json valid"
```

### 6. Smoke test

Trigger a hook manually to confirm the server receives it:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","session_id":"install-smoke-test","cwd":"'"$REPO_PATH"'"}' \
  | node "$REPO_PATH/.claude/hooks/agent-tracker.js" PreToolUse
curl -s http://localhost:3141/api/agents | grep -q install-smoke-test && echo "hook → server OK"
```

Then clean up the test agent:

```bash
rm -f "$REPO_PATH/state/agents/install-smoke-test.json"
```

### 7. Tell the user it's done

Report to the user:

- Dashboard URL: `http://localhost:3141`
- Background log: `/tmp/agents-hq.log`
- Stop command: `lsof -ti:3141 | xargs kill`
- Any new Claude Code session they open will now appear on the dashboard.

If they want the server to autostart on login, point them to the **Auto-start on login** section in `README.md`.

---

## What this installs

- Six Claude Code hooks in `~/.claude/settings.json` (PreToolUse, PostToolUse, SubagentStart, SubagentStop, Notification, UserPromptSubmit)
- A background Node server on port 3141 serving the dashboard
- No global packages, no system files modified

## What this does **not** do

- Does not modify `~/.claude/CLAUDE.md` or any other config beyond `settings.json`
- Does not install launchd / systemd autostart (covered in `README.md`)
- Does not change firewall, network, or shell-profile settings

## Uninstall

Remove the six hook entries from `~/.claude/settings.json` and kill the server (`lsof -ti:3141 | xargs kill`). The repo directory can then be deleted.
