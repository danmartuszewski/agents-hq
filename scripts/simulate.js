const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state', 'agents');
fs.mkdirSync(STATE_DIR, { recursive: true });

// Simulated agents across two projects
const agents = [
  { agentId: 'sim-ceo',     agentType: 'lead',       project: 'my-api',       cwd: '/projects/my-api' },
  { agentId: 'sim-cto',     agentType: 'lead',       project: 'frontend-app', cwd: '/projects/frontend-app' },
  { agentId: 'sim-res-1',   agentType: 'researcher', project: 'my-api',       cwd: '/projects/my-api' },
  { agentId: 'sim-coder-1', agentType: 'coder',      project: 'my-api',       cwd: '/projects/my-api' },
  { agentId: 'sim-coder-2', agentType: 'coder',      project: 'frontend-app', cwd: '/projects/frontend-app' },
  { agentId: 'sim-test-1',  agentType: 'tester',     project: 'my-api',       cwd: '/projects/my-api' },
  { agentId: 'sim-rev-1',   agentType: 'reviewer',   project: 'my-api',       cwd: '/projects/my-api' },
];

const tasks = {
  lead:       ['Reviewing quarterly strategy', 'Analyzing market trends', 'Planning team expansion', 'Reading competitive intelligence'],
  researcher: ['Searching documentation', 'Reading source code', 'Comparing libraries', 'Analyzing patterns'],
  coder:      ['Writing auth middleware', 'Editing route handler', 'Refactoring models', 'Writing tests'],
  tester:     ['Running test suite', 'Checking coverage', 'Re-running failed tests', 'Validating edge cases'],
  reviewer:   ['Reading PR diff', 'Checking security patterns', 'Reviewing test coverage', 'Final review'],
};

const tools = ['Read', 'Write', 'Bash', 'Grep', 'Edit', 'WebSearch', null, null, null];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function updateAgent(agent, status, task, tool) {
  const filePath = path.join(STATE_DIR, `${agent.agentId}.json`);
  const data = {
    agentId: agent.agentId,
    agentType: agent.agentType,
    project: agent.project,
    cwd: agent.cwd,
    sessionId: 'sim-session',
    status,
    currentTask: task || null,
    currentTool: tool || null,
    lastActivity: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Initialize all agents as offline
for (const agent of agents) {
  updateAgent(agent, 'offline', null, null);
}

console.log('Simulator started. Agents will come alive in waves...');
console.log('Press Ctrl+C to stop.\n');

// Phase 1: Bring agents online one by one
let agentIndex = 0;
const bootInterval = setInterval(() => {
  if (agentIndex >= agents.length) {
    clearInterval(bootInterval);
    console.log('All agents online. Running simulation loop...\n');
    startSimLoop();
    return;
  }

  const agent = agents[agentIndex];
  const task = randomChoice(tasks[agent.agentType] || ['Working...']);
  const tool = randomChoice(tools);
  updateAgent(agent, 'active', task, tool);
  console.log(`  [+] @${agent.agentType} (${agent.project}) is now ACTIVE — ${task}`);
  agentIndex++;
}, 1500);

function startSimLoop() {
  setInterval(() => {
    const agent = randomChoice(agents);
    const currentState = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${agent.agentId}.json`), 'utf8'));
      } catch {
        return { status: 'offline' };
      }
    })();

    let newStatus, newTask, newTool;
    if (currentState.status === 'active') {
      if (Math.random() < 0.3) {
        newStatus = 'idle';
        newTask = null;
        newTool = null;
        console.log(`  [~] @${agent.agentType} (${agent.project}) is now IDLE`);
      } else {
        newStatus = 'active';
        newTask = randomChoice(tasks[agent.agentType] || ['Working...']);
        newTool = randomChoice(tools);
        console.log(`  [*] @${agent.agentType} (${agent.project}) switched task — ${newTask}${newTool ? ` (${newTool})` : ''}`);
      }
    } else if (currentState.status === 'idle') {
      if (Math.random() < 0.8) {
        newStatus = 'active';
        newTask = randomChoice(tasks[agent.agentType] || ['Working...']);
        newTool = randomChoice(tools);
        console.log(`  [+] @${agent.agentType} (${agent.project}) is now ACTIVE — ${newTask}`);
      } else {
        newStatus = 'offline';
        newTask = null;
        newTool = null;
        console.log(`  [-] @${agent.agentType} (${agent.project}) went OFFLINE`);
      }
    } else {
      newStatus = 'active';
      newTask = randomChoice(tasks[agent.agentType] || ['Working...']);
      newTool = randomChoice(tools);
      console.log(`  [+] @${agent.agentType} (${agent.project}) is now ACTIVE — ${newTask}`);
    }

    updateAgent(agent, newStatus, newTask, newTool);
  }, 2000 + Math.random() * 3000);
}
