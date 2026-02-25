const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state', 'agents');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'agents.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const tasks = {
  ceo: ['Reviewing quarterly strategy', 'Analyzing market trends', 'Planning team expansion', 'Reading competitive intelligence'],
  cto: ['Reviewing architecture docs', 'Code review PR #142', 'Planning infrastructure migration', 'Evaluating new tools'],
  pmnet: ['Updating project roadmap', 'Sprint planning', 'Stakeholder sync', 'Writing release notes'],
  ghost: ['Running background tasks', 'Monitoring system health', 'Cleaning up logs', 'Syncing data'],
  crm: ['Updating customer records', 'Generating sales report', 'Sending follow-up emails', 'Analyzing churn data'],
  ads: ['Optimizing ad campaigns', 'A/B test analysis', 'Budget allocation', 'Creating ad copy'],
  content: ['Writing blog post', 'Editing newsletter', 'Creating social media posts', 'Reviewing content calendar']
};

const tools = ['Read', 'Write', 'Bash', 'Grep', 'Edit', 'WebSearch', null, null, null];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function updateAgent(agentId, status, task, tool) {
  const filePath = path.join(STATE_DIR, `${agentId}.json`);
  const data = {
    id: agentId,
    status,
    currentTask: task || null,
    currentTool: tool || null,
    lastActivity: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Initialize all agents as offline
for (const agent of config) {
  updateAgent(agent.id, 'offline', null, null);
}

console.log('Simulator started. Agents will come alive in waves...');
console.log('Press Ctrl+C to stop.\n');

// Phase 1: Bring agents online one by one
let agentIndex = 0;
const bootInterval = setInterval(() => {
  if (agentIndex >= config.length) {
    clearInterval(bootInterval);
    console.log('All agents online. Running simulation loop...\n');
    startSimLoop();
    return;
  }

  const agent = config[agentIndex];
  const task = randomChoice(tasks[agent.id] || ['Working...']);
  const tool = randomChoice(tools);
  updateAgent(agent.id, 'active', task, tool);
  console.log(`  [+] ${agent.name} is now ACTIVE — ${task}`);
  agentIndex++;
}, 1500);

function startSimLoop() {
  setInterval(() => {
    const agent = randomChoice(config);
    const currentState = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${agent.id}.json`), 'utf8'));
      } catch {
        return { status: 'offline' };
      }
    })();

    // Transition logic
    let newStatus, newTask, newTool;
    if (currentState.status === 'active') {
      // Active agents might go idle or switch tasks
      if (Math.random() < 0.3) {
        newStatus = 'idle';
        newTask = null;
        newTool = null;
        console.log(`  [~] ${agent.name} is now IDLE`);
      } else {
        newStatus = 'active';
        newTask = randomChoice(tasks[agent.id] || ['Working...']);
        newTool = randomChoice(tools);
        console.log(`  [*] ${agent.name} switched task — ${newTask}${newTool ? ` (${newTool})` : ''}`);
      }
    } else if (currentState.status === 'idle') {
      // Idle agents usually come back active
      if (Math.random() < 0.8) {
        newStatus = 'active';
        newTask = randomChoice(tasks[agent.id] || ['Working...']);
        newTool = randomChoice(tools);
        console.log(`  [+] ${agent.name} is now ACTIVE — ${newTask}`);
      } else {
        newStatus = 'offline';
        newTask = null;
        newTool = null;
        console.log(`  [-] ${agent.name} went OFFLINE`);
      }
    } else {
      // Offline agents come back
      newStatus = 'active';
      newTask = randomChoice(tasks[agent.id] || ['Working...']);
      newTool = randomChoice(tools);
      console.log(`  [+] ${agent.name} is now ACTIVE — ${newTask}`);
    }

    updateAgent(agent.id, newStatus, newTask, newTool);
  }, 2000 + Math.random() * 3000);
}
