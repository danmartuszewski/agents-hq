// ============================================================
// State
// ============================================================
let agentRegistry = [];   // flat array from server: { agentId, agentType, project, cwd, sessionId, color, abbreviation }
let agentStates = {};      // { agentId: stateObj }
let currentLayout = localStorage.getItem('agents-hq-layout') || 'isometric';
let agentLogs = {};       // { agentId: [{ time, oldStatus, newStatus, tool, task }] }
let agentToolCounts = {}; // { agentId: { toolName: count } }
let selectedAgentId = null;
let cachedProjectMap = null;
let cachedProjectLayout = null;

// Phase 2: Communication & timeline state
let agentMessages = [];           // inter-agent messages
let agentToolTimeline = {};       // { agentId: [{ time, tool }] } for sparklines
let agentToolDurations = {};      // { agentId: { toolName: [ms] } }
let messageAnimations = [];       // { fromId, toId, startTime, duration }

// Phase 6: QoL state
let searchFilter = '';
let collapsedProjects = new Set();
let notificationsMuted = localStorage.getItem('agents-hq-muted') === 'true';
let notificationsPermission = Notification.permission;

// ============================================================
// Project Map & Layout helpers
// ============================================================
function buildProjectMap() {
  // { projectName: { cwd, types: { typeName: { color, abbreviation, instances: [agentId, ...] } } } }
  const map = {};
  for (const agent of agentRegistry) {
    if (!map[agent.project]) {
      map[agent.project] = { cwd: agent.cwd, types: {} };
    }
    if (!map[agent.project].types[agent.agentType]) {
      map[agent.project].types[agent.agentType] = {
        color: agent.color,
        abbreviation: agent.abbreviation,
        instances: []
      };
    }
    map[agent.project].types[agent.agentType].instances.push(agent.agentId);
    // Keep cwd up to date
    if (agent.cwd) map[agent.project].cwd = agent.cwd;
  }
  cachedProjectMap = map;
  return map;
}

function getDisplayName(agent) {
  const pm = cachedProjectMap || buildProjectMap();
  const typeInfo = pm[agent.project]?.types?.[agent.agentType];
  if (typeInfo && typeInfo.instances.length > 1) {
    const idx = typeInfo.instances.indexOf(agent.agentId) + 1;
    return `@${agent.agentType} #${idx}`;
  }
  return `@${agent.agentType}`;
}

function getAgentById(agentId) {
  return agentRegistry.find(a => a.agentId === agentId);
}

function invalidateLayout() {
  cachedProjectMap = null;
  cachedProjectLayout = null;
}

function computeProjectLayout() {
  if (cachedProjectLayout) return cachedProjectLayout;
  const pm = buildProjectMap();
  const projects = Object.keys(pm);
  const GRID = 14; // fixed grid size
  if (projects.length === 0) return (cachedProjectLayout = { zones: {}, gridCols: GRID, gridRows: GRID });

  // Arrange projects in a grid of zones that fits within the fixed 14x14 floor
  const projCols = Math.ceil(Math.sqrt(projects.length));
  const projRows = Math.ceil(projects.length / projCols);

  // Divide the available space evenly among project zones
  const usable = GRID - 2; // 1-tile margin on each side
  const cellW = usable / projCols;
  const cellH = usable / projRows;

  const zones = {};

  projects.forEach((projName, pi) => {
    const pCol = pi % projCols;
    const pRow = Math.floor(pi / projCols);
    const originCol = 1 + pCol * cellW;
    const originRow = 1 + pRow * cellH;

    const types = Object.keys(pm[projName].types);
    const maxInstances = Math.max(...types.map(t => pm[projName].types[t].instances.length));

    // Use all available zone space — no artificial cap
    const colSpacing = (cellW - 1) / Math.max(1, maxInstances);
    const rowSpacing = (cellH - 1) / Math.max(1, types.length);

    const zone = { types, originCol, originRow, agents: {} };

    types.forEach((typeName, ti) => {
      const typeInfo = pm[projName].types[typeName];
      typeInfo.instances.forEach((agentId, ii) => {
        zone.agents[agentId] = {
          col: originCol + 0.5 + ii * colSpacing,
          row: originRow + 0.5 + ti * rowSpacing
        };
      });
    });

    zones[projName] = zone;
  });

  cachedProjectLayout = { zones, gridCols: GRID, gridRows: GRID };
  return cachedProjectLayout;
}

// ============================================================
// Search/Filter helpers (Phase 6)
// ============================================================
function matchesSearch(agent, state) {
  if (!searchFilter) return true;
  const q = searchFilter.toLowerCase();
  return (
    agent.agentId.toLowerCase().includes(q) ||
    agent.agentType.toLowerCase().includes(q) ||
    agent.project.toLowerCase().includes(q) ||
    (state && state.currentTask && state.currentTask.toLowerCase().includes(q))
  );
}

function getFilteredAgents() {
  return agentRegistry.filter(a => matchesSearch(a, agentStates[a.agentId]));
}

function sortAgents(agents) {
  const statusOrder = { active: 0, idle: 1, offline: 2 };
  return [...agents].sort((a, b) => {
    const sa = agentStates[a.agentId] || { status: 'offline' };
    const sb = agentStates[b.agentId] || { status: 'offline' };
    return (statusOrder[sa.status] || 2) - (statusOrder[sb.status] || 2)
      || a.agentType.localeCompare(b.agentType);
  });
}

// ============================================================
// Theme Switcher
// ============================================================
let currentTheme = localStorage.getItem('agents-hq-theme') || 'matrix';

function applyTheme(name, skipRender) {
  currentTheme = name;
  document.body.setAttribute('data-theme', name);
  localStorage.setItem('agents-hq-theme', name);

  // Update dropdown active state
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.theme === name);
  });

  // Re-render canvas-based views (they read colors from CSS vars)
  if (!skipRender) renderCurrentLayout();
}

document.getElementById('theme-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('theme-dropdown').classList.toggle('open');
});

document.addEventListener('click', () => {
  document.getElementById('theme-dropdown').classList.remove('open');
  document.getElementById('cleanup-dropdown').classList.remove('open');
});

document.querySelectorAll('.theme-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    applyTheme(opt.dataset.theme);
    document.getElementById('theme-dropdown').classList.remove('open');
  });
});

// Apply saved theme on load (skip render - canvas not ready yet)
applyTheme(currentTheme, true);

// ============================================================
// Cleanup Switcher
// ============================================================
document.getElementById('cleanup-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('cleanup-dropdown').classList.toggle('open');
  // Close theme dropdown if open
  document.getElementById('theme-dropdown').classList.remove('open');
});

document.querySelectorAll('.cleanup-option').forEach(opt => {
  opt.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.getElementById('cleanup-dropdown').classList.remove('open');
    const action = opt.dataset.action;
    try {
      if (action === 'offline-agents') {
        await fetch('/api/cleanup/offline-agents', { method: 'POST' });
      } else if (action === 'offline-projects') {
        await fetch('/api/cleanup/offline-projects', { method: 'POST' });
      } else if (action === 'reset-all') {
        await fetch('/api/reset', { method: 'POST' });
      }
    } catch (err) {
      // silently ignore
    }
  });
});

// ============================================================
// Search / Sort / Mute controls (Phase 6)
// ============================================================
document.getElementById('agent-search').addEventListener('input', (e) => {
  searchFilter = e.target.value;
  renderCurrentLayout();
});


const muteBtn = document.getElementById('mute-btn');
function updateMuteBtn() {
  muteBtn.textContent = notificationsMuted ? 'UNMUTE' : 'MUTE';
  muteBtn.classList.toggle('muted', notificationsMuted);
}
updateMuteBtn();
muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  notificationsMuted = !notificationsMuted;
  localStorage.setItem('agents-hq-muted', notificationsMuted);
  updateMuteBtn();
});

// Request notification permission on first load
if (Notification.permission === 'default') {
  Notification.requestPermission().then(p => { notificationsPermission = p; });
}

// ============================================================
// DOM refs
// ============================================================
const activityLogEl = document.getElementById('activity-log');
const teamStatsEl = document.getElementById('team-stats');

// ============================================================
// Layout Switcher
// ============================================================
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => switchLayout(btn.dataset.layout));
});

function switchLayout(name) {
  currentLayout = name;
  localStorage.setItem('agents-hq-layout', name);

  // Update buttons
  document.querySelectorAll('.layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === name));

  // Toggle view containers
  document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  renderCurrentLayout();
}

function renderCurrentLayout() {
  switch (currentLayout) {
    case 'isometric': renderIsometric(); break;
    case 'list': renderList(); break;
    case 'cards': renderCards(); break;
    case 'graph': renderGraph(); break;
  }
}

// ============================================================
// Empty State
// ============================================================
function drawEmptyState(ctx, W, H, tv) {
  ctx.fillStyle = tv.textDim;
  ctx.font = '14px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Waiting for agents...', W / 2, H / 2);
}

// ============================================================
// HQ View — Full 3D Canvas Renderer
// ============================================================
const isoCanvas = document.getElementById('iso-grid');
const isoCtx = isoCanvas.getContext('2d');

// 3D scene parameters
const TILE_SIZE = 55;
const SPHERE_RADIUS = 20;
const CAMERA_DIST = 900;
const BASE_TILT = 35;

// Interactive transform state
const isoTransform = { rotX: 0, rotY: 0, scale: 1, panX: 0, panY: 0 };
const isoResetBtn = document.getElementById('iso-reset');

// Projected agent positions for hit-testing
let projectedAgents = [];

// Particles (screen-space, drawn on top)
const particles = [];
for (let i = 0; i < 25; i++) {
  particles.push({
    x: Math.random(), y: Math.random(),
    speed: 0.0002 + Math.random() * 0.0005,
    size: 1 + Math.random() * 2,
    alpha: 0.1 + Math.random() * 0.3,
    phase: Math.random() * Math.PI * 2
  });
}

function getThemeVars() {
  const s = getComputedStyle(document.body);
  return {
    tileR: parseInt(s.getPropertyValue('--grid-tile-r')) || 18,
    tileG: parseInt(s.getPropertyValue('--grid-tile-g')) || 58,
    tileB: parseInt(s.getPropertyValue('--grid-tile-b')) || 28,
    lineColor: s.getPropertyValue('--grid-line-color').trim(),
    glowInner: s.getPropertyValue('--grid-glow-inner').trim(),
    glowMid: s.getPropertyValue('--grid-glow-mid').trim(),
    particle: s.getPropertyValue('--particle-color').trim(),
    clusterBg: s.getPropertyValue('--graph-cluster-bg').trim(),
    deptLabel: s.getPropertyValue('--graph-dept-label').trim(),
    graphLine: s.getPropertyValue('--graph-line').trim(),
    graphLineCross: s.getPropertyValue('--graph-line-cross').trim(),
    graphNameActive: s.getPropertyValue('--graph-name-active').trim(),
    graphNameDim: s.getPropertyValue('--graph-name-dim').trim(),
    textMuted: s.getPropertyValue('--text-muted').trim(),
    textDim: s.getPropertyValue('--text-dim').trim(),
    accent: s.getPropertyValue('--accent').trim(),
  };
}

// ---- 3D Math ----
function rotateY3D(x, y, z, deg) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { x: x * cos + z * sin, y, z: -x * sin + z * cos };
}

function rotateX3D(x, y, z, deg) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return { x, y: y * cos - z * sin, z: y * sin + z * cos };
}

function transform3D(x, y, z) {
  const totalRotX = BASE_TILT + isoTransform.rotX;
  let p = rotateY3D(x, y, z, isoTransform.rotY);
  p = rotateX3D(p.x, p.y, p.z, totalRotX);
  return p;
}

function project(x, y, z, cx, cy) {
  const scale = CAMERA_DIST / (CAMERA_DIST + z) * isoTransform.scale;
  return { sx: cx + x * scale, sy: cy + y * scale, scale, z };
}

// ---- Sphere Drawing (Phase 4: dynamic glow) ----
function drawSphere(ctx, sx, sy, r, color, abbrev, status, agentId) {
  const opacity = status === 'offline' ? 0.5 : status === 'idle' ? 0.7 : 1.0;

  // Phase 4: activity-based glow
  if (status === 'active') {
    const recentCount = getRecentToolCount(agentId, 30000);
    const glowIntensity = Math.min(0.4, 0.15 + recentCount * 0.025);
    const glowRadius = r * (1.5 + Math.min(0.5, recentCount * 0.05));

    const glow = ctx.createRadialGradient(sx, sy, r * 0.8, sx, sy, glowRadius);
    glow.addColorStop(0, color.replace(')', `, ${glowIntensity})`).replace('rgb(', 'rgba('));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Shadow on floor
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(sx + r * 0.15, sy + r * 0.9, r * 0.7, r * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.globalAlpha = opacity;

  // Main sphere body with 3D shading
  const hlx = sx - r * 0.3, hly = sy - r * 0.3;
  const grad = ctx.createRadialGradient(hlx, hly, r * 0.05, sx, sy, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.25, color);
  grad.addColorStop(0.75, darkenColor(color, 0.5));
  grad.addColorStop(1, darkenColor(color, 0.25));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();

  // Rim light
  const rim = ctx.createRadialGradient(sx, sy - r * 0.1, r * 0.75, sx, sy, r);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(0.9, 'rgba(255,255,255,0)');
  rim.addColorStop(1, 'rgba(255,255,255,0.08)');
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();

  // Abbreviation text
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(r * 0.7)}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(abbrev, sx, sy + 1);

  ctx.restore();
}

function darkenColor(color, factor) {
  const m = color.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) {
    const r = Math.round(parseInt(m[1], 16) * factor);
    const g = Math.round(parseInt(m[2], 16) * factor);
    const b = Math.round(parseInt(m[3], 16) * factor);
    return `rgb(${r},${g},${b})`;
  }
  return color;
}

// ---- Phase 4: Activity rate helpers ----
function getRecentToolCount(agentId, windowMs) {
  const timeline = agentToolTimeline[agentId];
  if (!timeline || timeline.length === 0) return 0;
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].time >= cutoff) count++;
    else break;
  }
  return count;
}

function getPulsePeriod(agentId) {
  const count = getRecentToolCount(agentId, 30000);
  if (count > 10) return 500;
  if (count > 5) return 1000;
  if (count > 0) return 1500;
  return 2500;
}

// ---- Dynamic project-based layout ----
function agentToWorld(agent) {
  const layout = computeProjectLayout();
  const zone = layout.zones[agent.project];
  if (!zone || !zone.agents[agent.agentId]) {
    // Fallback: center of grid
    return { x: 0, y: 0, z: 0 };
  }
  const pos = zone.agents[agent.agentId];
  const wx = (pos.col - layout.gridCols / 2) * TILE_SIZE;
  const wz = (pos.row - layout.gridRows / 2) * TILE_SIZE;
  return { x: wx, y: 0, z: wz };
}

// ---- Main 3D Scene Draw ----
function draw3DScene() {
  const ctx = isoCtx;
  const W = isoCanvas.width, H = isoCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const tv = getThemeVars();
  const cx = W * 0.5 + isoTransform.panX, cy = H * 0.44 + isoTransform.panY;

  if (agentRegistry.length === 0) {
    drawEmptyState(ctx, W, H, tv);
    // Still draw particles
    drawParticles(ctx, W, H, tv);
    return;
  }

  const layout = computeProjectLayout();
  const GRID_COLS = layout.gridCols;
  const GRID_ROWS = layout.gridRows;

  // Background glow
  const bgGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.55);
  bgGlow.addColorStop(0, tv.glowInner);
  bgGlow.addColorStop(0.5, tv.glowMid);
  bgGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, W, H);

  // Collect all drawables for depth sorting
  const drawables = [];
  const halfGrid = (GRID_COLS - 1) / 2;
  const maxDist = Math.sqrt(2) * halfGrid;

  // Floor tiles
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const wx = (c - GRID_COLS / 2) * TILE_SIZE;
      const wz = (r - GRID_ROWS / 2) * TILE_SIZE;
      const hs = TILE_SIZE * 0.48;

      const corners3D = [
        { x: wx, y: 0, z: wz - hs },
        { x: wx + hs, y: 0, z: wz },
        { x: wx, y: 0, z: wz + hs },
        { x: wx - hs, y: 0, z: wz }
      ];

      const projected = corners3D.map(p => {
        const t = transform3D(p.x, p.y, p.z);
        return project(t.x, t.y, t.z, cx, cy);
      });

      const centerT = transform3D(wx, 0, wz);
      const depth = centerT.z;

      const dc = Math.sqrt((c - halfGrid) ** 2 + (r - halfGrid) ** 2);
      const brightness = Math.max(0, 1 - dc / maxDist);
      const alpha = 0.12 + brightness * 0.30;
      const shade = (r + c) % 2 === 0 ? 1 : 0.75;

      drawables.push({
        type: 'tile', depth, draw: () => {
          ctx.beginPath();
          ctx.moveTo(projected[0].sx, projected[0].sy);
          for (let i = 1; i < 4; i++) ctx.lineTo(projected[i].sx, projected[i].sy);
          ctx.closePath();
          ctx.fillStyle = `rgba(${Math.round(tv.tileR * shade)}, ${Math.round(tv.tileG * shade)}, ${Math.round(tv.tileB * shade)}, ${alpha})`;
          ctx.fill();
          ctx.strokeStyle = tv.lineColor.replace(/[\d.]+\)$/, `${alpha * 0.5})`);
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      });
    }
  }

  // Agent spheres
  const newProjected = [];
  for (const agent of agentRegistry) {
    const state = agentStates[agent.agentId] || { status: 'offline' };
    const wp = agentToWorld(agent);
    const sphereY = -SPHERE_RADIUS;
    const t = transform3D(wp.x, sphereY, wp.z);
    const p = project(t.x, t.y, t.z, cx, cy);
    const r = SPHERE_RADIUS * p.scale;

    newProjected.push({ id: agent.agentId, sx: p.sx, sy: p.sy, r });

    // Phase 6: dim non-matching agents in isometric view
    const matches = matchesSearch(agent, state);
    const displayName = getDisplayName(agent);
    drawables.push({
      type: 'agent', depth: t.z, draw: () => {
        ctx.save();
        if (!matches && searchFilter) ctx.globalAlpha = 0.2;
        drawSphere(ctx, p.sx, p.sy, r, agent.color, agent.abbreviation, state.status, agent.agentId);
        ctx.fillStyle = state.status === 'offline' ? tv.textDim : tv.textMuted;
        ctx.font = `${Math.round(r * 0.45)}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(displayName, p.sx, p.sy + r + Math.round(r * 0.55));
        ctx.restore();
      }
    });
  }
  projectedAgents = newProjected;

  // Project labels on the floor
  const pm = cachedProjectMap || buildProjectMap();
  for (const [projName, projData] of Object.entries(layout.zones)) {
    const wx = (projData.originCol - GRID_COLS / 2) * TILE_SIZE - TILE_SIZE * 0.5;
    const wz = (projData.originRow - GRID_ROWS / 2) * TILE_SIZE;
    const t = transform3D(wx, -5, wz);
    const p = project(t.x, t.y, t.z, cx, cy);

    // Project label (large)
    drawables.push({
      type: 'label', depth: t.z, draw: () => {
        ctx.fillStyle = tv.accent;
        ctx.font = `bold ${Math.max(10, Math.round(13 * p.scale))}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'left';
        const truncated = projName.length > 20 ? projName.substring(0, 18) + '..' : projName;
        ctx.fillText(truncated.toUpperCase(), p.sx, p.sy);
      }
    });
  }

  // Sort back-to-front
  drawables.sort((a, b) => b.depth - a.depth);
  for (const d of drawables) d.draw();

  // Particles
  drawParticles(ctx, W, H, tv);

  // Phase 5: Mini-map
  drawMinimap(ctx, W, H, layout, cx, cy);
}

function drawParticles(ctx, W, H, tv) {
  const now = Date.now();
  for (const p of particles) {
    const flicker = 0.5 + 0.5 * Math.sin(now * 0.001 + p.phase);
    ctx.fillStyle = `rgba(${tv.particle}, ${p.alpha * flicker})`;
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, p.size * flicker, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed;
    if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
  }
}

// ============================================================
// Phase 5: Mini-map
// ============================================================
function drawMinimap(ctx, W, H, layout, cx, cy) {
  const isZoomed = isoTransform.scale > 1.3;
  const isPanned = Math.abs(isoTransform.panX) > 30 || Math.abs(isoTransform.panY) > 30;
  if (!isZoomed && !isPanned) return;
  if (agentRegistry.length === 0) return;

  const mmW = 150, mmH = 100;
  const mmX = 16, mmY = H - mmH - 16;

  // Background
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(mmX, mmY, mmW, mmH, 4);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Compute scale to fit all agents in minimap
  const GRID_COLS = layout.gridCols;
  const GRID_ROWS = layout.gridRows;
  const mapScale = Math.min((mmW - 20) / (GRID_COLS * TILE_SIZE), (mmH - 20) / (GRID_ROWS * TILE_SIZE));
  const mapCx = mmX + mmW / 2;
  const mapCy = mmY + mmH / 2;

  // Draw agent dots
  for (const agent of agentRegistry) {
    const state = agentStates[agent.agentId] || { status: 'offline' };
    const wp = agentToWorld(agent);
    const dx = wp.x * mapScale + mapCx;
    const dy = wp.z * mapScale + mapCy;

    let dotColor;
    if (state.status === 'active') dotColor = agent.color;
    else if (state.status === 'idle') dotColor = '#f5a623';
    else dotColor = '#555';

    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(dx, dy, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Viewport rectangle
  const vpHalfW = (W / 2) / isoTransform.scale * mapScale;
  const vpHalfH = (H / 2) / isoTransform.scale * mapScale;
  const vpCx = mapCx - isoTransform.panX / isoTransform.scale * mapScale;
  const vpCy = mapCy - isoTransform.panY / isoTransform.scale * mapScale;

  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vpCx - vpHalfW, vpCy - vpHalfH, vpHalfW * 2, vpHalfH * 2);

  ctx.restore();
}

// ---- Public API for layout system ----
function renderIsometric() {
  isoCanvas.width = isoCanvas.parentElement.clientWidth;
  isoCanvas.height = isoCanvas.parentElement.clientHeight;
}

function updateIsometric() {
  // No-op: draw3DScene runs every frame and reads agentStates directly
}

function animateIso() {
  if (currentLayout === 'isometric') draw3DScene();
  requestAnimationFrame(animateIso);
}

// ---- HQ View Interaction Handlers (3D orbit) ----
(function initIsoInteraction() {
  const view = document.getElementById('view-isometric');
  let dragMode = null;
  let dragStartX = 0, dragStartY = 0;
  let startRotX = 0, startRotY = 0;
  let startPanX = 0, startPanY = 0;
  let lastPinchDist = 0;

  function syncResetBtn() {
    const isDefault = isoTransform.rotX === 0 && isoTransform.rotY === 0
      && isoTransform.scale === 1 && isoTransform.panX === 0 && isoTransform.panY === 0;
    isoResetBtn.classList.toggle('visible', !isDefault);
  }

  view.addEventListener('mousedown', (e) => {
    if (e.target.closest('.iso-reset-btn')) return;
    const isPan = e.button === 1 || (e.button === 0 && e.altKey);
    if (!isPan) {
      const rect = isoCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      for (const a of projectedAgents) {
        if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) return;
      }
    }
    dragMode = isPan ? 'pan' : 'rotate';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    if (dragMode === 'pan') {
      startPanX = isoTransform.panX;
      startPanY = isoTransform.panY;
    } else {
      startRotX = isoTransform.rotX;
      startRotY = isoTransform.rotY;
    }
    view.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragMode) {
      const rect = isoCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let overAgent = false;
      for (const a of projectedAgents) {
        if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) { overAgent = true; break; }
      }
      if (view.contains(e.target)) {
        isoCanvas.style.cursor = overAgent ? 'pointer' : e.altKey ? 'move' : 'grab';
      }
      return;
    }
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (dragMode === 'pan') {
      isoTransform.panX = startPanX + dx;
      isoTransform.panY = startPanY + dy;
    } else {
      isoTransform.rotY = startRotY - dx * 0.3;
      isoTransform.rotX = Math.max(-40, Math.min(40, startRotX + dy * 0.3));
    }
    syncResetBtn();
  });

  window.addEventListener('mouseup', () => {
    if (dragMode) {
      dragMode = null;
      view.classList.remove('dragging');
    }
  });

  isoCanvas.addEventListener('click', (e) => {
    const rect = isoCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const sorted = [...projectedAgents].sort((a, b) => b.r - a.r);
    for (const a of sorted) {
      if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) {
        openAgentDetail(a.id);
        return;
      }
    }
  });

  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('auxclick', (e) => e.preventDefault());

  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.93 : 1.07;
    isoTransform.scale = Math.max(0.4, Math.min(2.5, isoTransform.scale * delta));
    syncResetBtn();
  }, { passive: false });

  // Touch support
  view.addEventListener('touchstart', (e) => {
    if (e.target.closest('.iso-reset-btn')) return;
    if (e.touches.length === 1) {
      dragMode = 'rotate';
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      startRotX = isoTransform.rotX;
      startRotY = isoTransform.rotY;
    } else if (e.touches.length === 2) {
      dragMode = null;
      lastPinchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
    }
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && dragMode === 'rotate') {
      const dx = e.touches[0].clientX - dragStartX;
      const dy = e.touches[0].clientY - dragStartY;
      isoTransform.rotY = startRotY - dx * 0.3;
      isoTransform.rotX = Math.max(-40, Math.min(40, startRotX + dy * 0.3));
      syncResetBtn();
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
      if (lastPinchDist > 0) {
        isoTransform.scale = Math.max(0.4, Math.min(2.5, isoTransform.scale * (dist / lastPinchDist)));
        syncResetBtn();
      }
      lastPinchDist = dist;
    }
    e.preventDefault();
  }, { passive: false });

  view.addEventListener('touchend', () => { dragMode = null; lastPinchDist = 0; });

  isoResetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const start = { ...isoTransform };
    const duration = 400;
    const t0 = performance.now();
    function animateReset(now) {
      const t = Math.min(1, (now - t0) / duration);
      if (t >= 1) {
        isoTransform.rotX = 0;
        isoTransform.rotY = 0;
        isoTransform.scale = 1;
        isoTransform.panX = 0;
        isoTransform.panY = 0;
      } else {
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        isoTransform.rotX = start.rotX * (1 - ease);
        isoTransform.rotY = start.rotY * (1 - ease);
        isoTransform.scale = start.scale + (1 - start.scale) * ease;
        isoTransform.panX = start.panX * (1 - ease);
        isoTransform.panY = start.panY * (1 - ease);
        requestAnimationFrame(animateReset);
      }
      syncResetBtn();
    }
    requestAnimationFrame(animateReset);
  });
})();

// ============================================================
// List View (Phase 6: search, sort, collapse)
// ============================================================
function renderList() {
  const body = document.getElementById('list-body');
  body.innerHTML = '';

  const filtered = getFilteredAgents();
  if (filtered.length === 0 && agentRegistry.length === 0) {
    body.innerHTML = '<div class="list-empty-state">Waiting for agents...</div>';
    return;
  }
  if (filtered.length === 0) {
    body.innerHTML = '<div class="list-empty-state">No matching agents</div>';
    return;
  }

  const pm = buildProjectMap();
  const projects = Object.keys(pm).sort();

  for (const projName of projects) {
    const projectAgents = sortAgents(
      filtered.filter(a => a.project === projName)
    );
    if (projectAgents.length === 0) continue;

    // Project header row
    const header = document.createElement('div');
    header.className = 'list-project-header';
    const isCollapsed = collapsedProjects.has(projName);
    const truncated = projName.length > 30 ? projName.substring(0, 28) + '..' : projName;
    const arrow = isCollapsed ? '\u25b6' : '\u25bc';
    header.innerHTML = `<span class="collapse-arrow">${arrow}</span> ${truncated.toUpperCase()} <span class="project-agent-count">(${projectAgents.length})</span>`;
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      if (collapsedProjects.has(projName)) collapsedProjects.delete(projName);
      else collapsedProjects.add(projName);
      renderList();
    });
    body.appendChild(header);

    if (isCollapsed) continue;

    for (const agent of projectAgents) {
      const state = agentStates[agent.agentId] || { status: 'offline' };
      const row = document.createElement('div');
      row.className = `list-row ${state.status}`;
      row.id = `list-agent-${agent.agentId}`;

      const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '\u2014';
      const taskText = state.currentTask || '\u2014';
      const toolHtml = state.currentTool ? `<span class="tool-badge">${state.currentTool}</span>` : '\u2014';
      const displayName = getDisplayName(agent);

      row.innerHTML = `
        <span class="list-col col-status"><span class="status-dot"></span><span class="status-text">${state.status}</span></span>
        <span class="list-col col-agent"><span class="agent-abbr" style="background:${agent.color}">${agent.abbreviation}</span>${displayName}</span>
        <span class="list-col col-type">${agent.agentType}</span>
        <span class="list-col col-task"><span class="task-text">${taskText}</span></span>
        <span class="list-col col-tool">${toolHtml}</span>
        <span class="list-col col-time"><span class="time-text">${timeSince}</span></span>
      `;
      attachAgentClick(row, agent.agentId);
      body.appendChild(row);
    }
  }
}

function updateList(agentId) {
  const row = document.getElementById(`list-agent-${agentId}`);
  if (!row) { renderList(); return; }
  const agent = getAgentById(agentId);
  if (!agent) return;
  const state = agentStates[agentId] || { status: 'offline' };
  row.className = `list-row ${state.status}`;

  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '\u2014';
  const taskText = state.currentTask || '\u2014';
  const toolHtml = state.currentTool ? `<span class="tool-badge">${state.currentTool}</span>` : '\u2014';
  const displayName = getDisplayName(agent);

  row.innerHTML = `
    <span class="list-col col-status"><span class="status-dot"></span><span class="status-text">${state.status}</span></span>
    <span class="list-col col-agent"><span class="agent-abbr" style="background:${agent.color}">${agent.abbreviation}</span>${displayName}</span>
    <span class="list-col col-type">${agent.agentType}</span>
    <span class="list-col col-task"><span class="task-text">${taskText}</span></span>
    <span class="list-col col-tool">${toolHtml}</span>
    <span class="list-col col-time"><span class="time-text">${timeSince}</span></span>
  `;
  row.classList.add('list-row-flash');
  setTimeout(() => row.classList.remove('list-row-flash'), 1000);
}

// ============================================================
// Cards View (Phase 6: search, sort, collapse)
// ============================================================
function renderCards() {
  const container = document.getElementById('cards-container');
  container.innerHTML = '';

  const filtered = getFilteredAgents();
  if (filtered.length === 0 && agentRegistry.length === 0) {
    container.innerHTML = '<div class="cards-empty-state">Waiting for agents...</div>';
    return;
  }
  if (filtered.length === 0) {
    container.innerHTML = '<div class="cards-empty-state">No matching agents</div>';
    return;
  }

  const pm = buildProjectMap();
  const projects = Object.keys(pm).sort();

  for (const projName of projects) {
    const projectAgents = sortAgents(
      filtered.filter(a => a.project === projName)
    );
    if (projectAgents.length === 0) continue;

    // Project section header
    const header = document.createElement('div');
    header.className = 'cards-project-header';
    const isCollapsed = collapsedProjects.has(projName);
    const truncated = projName.length > 30 ? projName.substring(0, 28) + '..' : projName;
    const arrow = isCollapsed ? '\u25b6' : '\u25bc';
    header.innerHTML = `<span class="collapse-arrow">${arrow}</span> ${truncated.toUpperCase()} <span class="project-agent-count">(${projectAgents.length})</span>`;
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      if (collapsedProjects.has(projName)) collapsedProjects.delete(projName);
      else collapsedProjects.add(projName);
      renderCards();
    });
    container.appendChild(header);

    if (isCollapsed) continue;

    for (const agent of projectAgents) {
      const state = agentStates[agent.agentId] || { status: 'offline' };
      const card = createCard(agent, state);
      container.appendChild(card);
    }
  }
}

function createCard(agent, state) {
  const card = document.createElement('div');
  card.className = `agent-card ${state.status}`;
  card.id = `card-agent-${agent.agentId}`;
  card.style.setProperty('--agent-color', agent.color);

  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '\u2014';
  const taskText = state.currentTask || 'No active task';
  const toolHtml = state.currentTool ? `<span class="card-tool">${state.currentTool}</span>` : '';
  const statusLabel = state.status.toUpperCase();
  const displayName = getDisplayName(agent);

  card.innerHTML = `
    <div class="card-header">
      <div class="card-orb" style="background: ${agent.color}">${agent.abbreviation}</div>
      <div class="card-info">
        <div class="card-name">${displayName}</div>
        <div class="card-dept">${agent.agentType}</div>
      </div>
      <span class="card-status-badge">${statusLabel}</span>
    </div>
    <div class="card-task">${taskText}</div>
    <div class="card-footer">
      <div>${toolHtml}</div>
      <span class="card-time">${timeSince}</span>
    </div>
  `;
  attachAgentClick(card, agent.agentId);
  return card;
}

function updateCards(agentId) {
  const agent = getAgentById(agentId);
  if (!agent) return;
  const state = agentStates[agentId] || { status: 'offline' };
  const old = document.getElementById(`card-agent-${agentId}`);
  const card = createCard(agent, state);
  if (old) old.replaceWith(card);
  else renderCards();
}

// ============================================================
// Graph View (Phase 2: message animations, Phase 4: dynamic pulses)
// ============================================================
const graphCanvas = document.getElementById('graph-canvas');
const graphCtx = graphCanvas.getContext('2d');
const graphResetBtn = document.getElementById('graph-reset');
let graphNodes = [];
let projectedGraphNodes = [];

const GRAPH_BASE_TILT = 15;
const GRAPH_CAM_DIST = 1100;
const graphTransform = { rotX: 0, rotY: 0, scale: 1, panX: 0, panY: 0 };

function graphTransform3D(x, y, z) {
  const totalRotX = GRAPH_BASE_TILT + graphTransform.rotX;
  let p = rotateY3D(x, y, z, graphTransform.rotY);
  p = rotateX3D(p.x, p.y, p.z, totalRotX);
  return p;
}

function graphProject(x, y, z, cx, cy) {
  const scale = GRAPH_CAM_DIST / (GRAPH_CAM_DIST + z) * graphTransform.scale;
  return { sx: cx + x * scale, sy: cy + y * scale, scale, z };
}

function initGraphNodes() {
  // Two-level clustering: projects as outer ring, types as inner clusters
  const pm = buildProjectMap();
  const projects = Object.keys(pm);
  graphNodes = [];

  if (projects.length === 0) return;

  const cx = graphCanvas.width / 2;
  const cy = graphCanvas.height / 2;

  // Count total agents to scale the layout
  let totalAgents = 0;
  for (const proj of projects) {
    for (const t of Object.values(pm[proj].types)) totalAgents += t.instances.length;
  }

  // Scale project radius with agent count so large swarms get more room
  const baseRadius = Math.min(cx, cy) * 0.55;
  const projectRadius = baseRadius + Math.max(0, totalAgents - 10) * 4;

  const NODE_RADIUS = 26;
  // Minimum spacing: enough that two nodes (radius 26 each) + labels don't overlap
  const MIN_NODE_GAP = NODE_RADIUS * 2.5; // ~65px between centers

  projects.forEach((projName, pi) => {
    const projAngle = (pi / projects.length) * Math.PI * 2 - Math.PI / 2;
    const projX = Math.cos(projAngle) * projectRadius;
    const projZ = Math.sin(projAngle) * projectRadius;

    const types = Object.keys(pm[projName].types);
    // Scale type spread with the number of types and their sizes
    const maxInstInProject = Math.max(...types.map(t => pm[projName].types[t].instances.length));
    const typeSpread = 50 + types.length * 20 + maxInstInProject * 8;

    types.forEach((typeName, ti) => {
      const typeAngle = (ti / types.length) * Math.PI * 2 + 0.3;
      const typeX = projX + Math.cos(typeAngle) * typeSpread;
      const typeZ = projZ + Math.sin(typeAngle) * typeSpread;

      const instances = pm[projName].types[typeName].instances;
      const count = instances.length;

      // For ring layout: ensure circumference provides enough gap
      // circumference = 2*PI*r, each node needs MIN_NODE_GAP of arc
      const minRingRadius = (count * MIN_NODE_GAP) / (2 * Math.PI);
      const instSpread = count <= 1 ? 0 : Math.max(35, minRingRadius);

      instances.forEach((agentId, ii) => {
        const instAngle = (ii / count) * Math.PI * 2;
        const agent = getAgentById(agentId);
        if (!agent) return;

        graphNodes.push({
          id: agentId,
          project: projName,
          agentType: typeName,
          color: agent.color,
          abbreviation: agent.abbreviation,
          name: getDisplayName(agent),
          wx: typeX + Math.cos(instAngle) * instSpread,
          wz: typeZ + Math.sin(instAngle) * instSpread,
          radius: NODE_RADIUS
        });
      });
    });
  });
}

// Phase 2: Message count between agents for line thickness
function getMessageCount(fromId, toId) {
  let count = 0;
  for (const msg of agentMessages) {
    if ((msg.fromId === fromId && msg.toId === toId) ||
        (msg.fromId === toId && msg.toId === fromId)) {
      count++;
    }
  }
  return count;
}

function queueMessageAnimation(fromId, toId) {
  messageAnimations.push({
    fromId,
    toId,
    startTime: Date.now(),
    duration: 1500
  });
}

function drawGraph() {
  const ctx = graphCtx;
  const tv = getThemeVars();
  const W = graphCanvas.width, H = graphCanvas.height;
  ctx.clearRect(0, 0, W, H);

  if (graphNodes.length === 0) {
    drawEmptyState(ctx, W, H, tv);
    return;
  }

  const cx = W / 2 + graphTransform.panX;
  const cy = H / 2 + graphTransform.panY;

  // Group nodes by project
  const projGroups = {};
  const projected = [];
  for (const node of graphNodes) {
    // Phase 6: skip filtered-out nodes from graph (dim them)
    const state = agentStates[node.id] || { status: 'offline' };
    const agent = getAgentById(node.id);
    const matches = agent ? matchesSearch(agent, state) : true;

    const t = graphTransform3D(node.wx, 0, node.wz);
    const p = graphProject(t.x, t.y, t.z, cx, cy);
    const r = node.radius * p.scale;
    const proj = { ...node, sx: p.sx, sy: p.sy, r, depth: t.z, matches };
    projected.push(proj);
    if (!projGroups[node.project]) projGroups[node.project] = [];
    projGroups[node.project].push(proj);
  }
  projectedGraphNodes = projected;

  const drawables = [];

  // Project cluster glows and labels
  for (const [projName, nodes] of Object.entries(projGroups)) {
    let avgSx = 0, avgSy = 0, avgDepth = 0, avgScale = 0;
    let topSy = Infinity;
    for (const n of nodes) {
      avgSx += n.sx; avgSy += n.sy; avgDepth += n.depth; avgScale += n.r / n.radius;
      if (n.sy - n.r < topSy) topSy = n.sy - n.r;
    }
    avgSx /= nodes.length; avgSy /= nodes.length;
    avgDepth /= nodes.length; avgScale /= nodes.length;
    const glowR = 140 * avgScale;

    drawables.push({
      depth: avgDepth + 100,
      draw: () => {
        const glow = ctx.createRadialGradient(avgSx, avgSy, 0, avgSx, avgSy, glowR);
        glow.addColorStop(0, tv.clusterBg);
        glow.addColorStop(1, tv.clusterBg.replace(/[\d.]+\)$/, '0)'));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(avgSx, avgSy, glowR, 0, Math.PI * 2);
        ctx.fill();

        // Project label above topmost node
        ctx.fillStyle = tv.accent;
        ctx.font = `bold ${Math.max(9, Math.round(12 * avgScale))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        const truncated = projName.length > 20 ? projName.substring(0, 18) + '..' : projName;
        ctx.fillText(truncated.toUpperCase(), avgSx, topSy - 14 * avgScale);
      }
    });

    // Intra-project connections (within same type)
    const typeGroups = {};
    for (const n of nodes) {
      if (!typeGroups[n.agentType]) typeGroups[n.agentType] = [];
      typeGroups[n.agentType].push(n);
    }

    for (const typeNodes of Object.values(typeGroups)) {
      for (let i = 0; i < typeNodes.length; i++) {
        for (let j = i + 1; j < typeNodes.length; j++) {
          const lineDepth = Math.max(typeNodes[i].depth, typeNodes[j].depth);
          // Phase 2: line width based on message count
          const msgCount = getMessageCount(typeNodes[i].id, typeNodes[j].id);
          const lineW = Math.min(4, 1.5 + msgCount * 0.3);
          const lineAlpha = Math.min(1, 0.45 + msgCount * 0.05);
          drawables.push({
            depth: lineDepth + 50,
            draw: () => {
              ctx.beginPath();
              ctx.moveTo(typeNodes[i].sx, typeNodes[i].sy);
              ctx.lineTo(typeNodes[j].sx, typeNodes[j].sy);
              ctx.strokeStyle = tv.graphLine.replace(/[\d.]+\)$/, `${lineAlpha})`);
              ctx.lineWidth = lineW;
              ctx.stroke();
            }
          });
        }
      }
    }
  }

  // Cross-project connections
  const projKeys = Object.keys(projGroups);
  for (let i = 0; i < projKeys.length; i++) {
    for (let j = i + 1; j < projKeys.length; j++) {
      const a = projGroups[projKeys[i]];
      const b = projGroups[projKeys[j]];
      let minDist = Infinity, bestA, bestB;
      for (const na of a) {
        for (const nb of b) {
          const d = Math.hypot(na.sx - nb.sx, na.sy - nb.sy);
          if (d < minDist) { minDist = d; bestA = na; bestB = nb; }
        }
      }
      if (bestA && bestB) {
        const lineDepth = Math.max(bestA.depth, bestB.depth);
        const msgCount = getMessageCount(bestA.id, bestB.id);
        const lineW = Math.min(3, 1 + msgCount * 0.3);
        drawables.push({
          depth: lineDepth + 50,
          draw: () => {
            ctx.beginPath();
            ctx.moveTo(bestA.sx, bestA.sy);
            ctx.lineTo(bestB.sx, bestB.sy);
            ctx.strokeStyle = tv.graphLineCross;
            ctx.lineWidth = lineW;
            ctx.setLineDash([4, 8]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        });
      }
    }
  }

  // Agent spheres with Phase 4 dynamic pulse
  const now = Date.now();
  for (const node of projected) {
    const state = agentStates[node.id] || { status: 'offline' };
    const status = state.status;
    const isActive = status === 'active';

    drawables.push({
      depth: node.depth,
      draw: () => {
        ctx.save();
        if (!node.matches && searchFilter) ctx.globalAlpha = 0.2;

        if (isActive) {
          const period = getPulsePeriod(node.id);
          const pulse = ((now % period) / period);
          ctx.beginPath();
          ctx.arc(node.sx, node.sy, node.r + pulse * 15 * (node.r / node.radius), 0, Math.PI * 2);
          ctx.strokeStyle = node.color + Math.round((1 - pulse) * 60).toString(16).padStart(2, '0');
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        drawSphere(ctx, node.sx, node.sy, node.r, node.color, node.abbreviation, status, node.id);

        ctx.fillStyle = isActive ? tv.graphNameActive : tv.graphNameDim;
        ctx.font = `${Math.max(8, Math.round(10 * (node.r / node.radius)))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(node.name, node.sx, node.sy + node.r + 14 * (node.r / node.radius));
        ctx.restore();
      }
    });
  }

  // Phase 2: Message animations (traveling dots)
  const activeAnims = [];
  for (const anim of messageAnimations) {
    const elapsed = now - anim.startTime;
    if (elapsed > anim.duration) continue;
    activeAnims.push(anim);

    const progress = elapsed / anim.duration;
    const fromNode = projected.find(n => n.id === anim.fromId);
    const toNode = projected.find(n => n.id === anim.toId);
    if (!fromNode || !toNode) continue;

    const dx = toNode.sx - fromNode.sx;
    const dy = toNode.sy - fromNode.sy;
    const dotX = fromNode.sx + dx * progress;
    const dotY = fromNode.sy + dy * progress;

    drawables.push({
      depth: -1000, // draw on top
      draw: () => {
        ctx.fillStyle = tv.accent;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
        ctx.fill();
        // Trail
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(dotX - dx * 0.03, dotY - dy * 0.03, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });
  }
  messageAnimations = activeAnims;

  drawables.sort((a, b) => b.depth - a.depth);
  for (const d of drawables) d.draw();
}

function renderGraph() {
  graphCanvas.width = graphCanvas.parentElement.clientWidth;
  graphCanvas.height = graphCanvas.parentElement.clientHeight;
  initGraphNodes();
}

function animateGraph() {
  if (currentLayout === 'graph') drawGraph();
  requestAnimationFrame(animateGraph);
}

// ---- Graph View Interaction Handlers ----
(function initGraphInteraction() {
  const view = document.getElementById('view-graph');
  let dragMode = null;
  let dragStartX = 0, dragStartY = 0;
  let startRotX = 0, startRotY = 0;
  let startPanX = 0, startPanY = 0;
  let lastPinchDist = 0;

  function syncResetBtn() {
    const isDefault = graphTransform.rotX === 0 && graphTransform.rotY === 0
      && graphTransform.scale === 1 && graphTransform.panX === 0 && graphTransform.panY === 0;
    graphResetBtn.classList.toggle('visible', !isDefault);
  }

  view.addEventListener('mousedown', (e) => {
    if (e.target.closest('.iso-reset-btn')) return;
    const isPan = e.button === 1 || (e.button === 0 && e.altKey);
    if (!isPan) {
      const rect = graphCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      for (const a of projectedGraphNodes) {
        if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) return;
      }
    }
    dragMode = isPan ? 'pan' : 'rotate';
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    if (dragMode === 'pan') {
      startPanX = graphTransform.panX;
      startPanY = graphTransform.panY;
    } else {
      startRotX = graphTransform.rotX;
      startRotY = graphTransform.rotY;
    }
    view.classList.add('dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragMode) {
      const rect = graphCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let overAgent = false;
      for (const a of projectedGraphNodes) {
        if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) { overAgent = true; break; }
      }
      if (view.contains(e.target)) {
        graphCanvas.style.cursor = overAgent ? 'pointer' : e.altKey ? 'move' : 'grab';
      }
      return;
    }
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (dragMode === 'pan') {
      graphTransform.panX = startPanX + dx;
      graphTransform.panY = startPanY + dy;
    } else {
      graphTransform.rotY = startRotY - dx * 0.3;
      graphTransform.rotX = Math.max(-40, Math.min(40, startRotX + dy * 0.3));
    }
    syncResetBtn();
  });

  window.addEventListener('mouseup', () => {
    if (dragMode) {
      dragMode = null;
      view.classList.remove('dragging');
    }
  });

  graphCanvas.addEventListener('click', (e) => {
    const rect = graphCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const sorted = [...projectedGraphNodes].sort((a, b) => b.r - a.r);
    for (const a of sorted) {
      if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) {
        openAgentDetail(a.id);
        return;
      }
    }
  });

  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('auxclick', (e) => e.preventDefault());

  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.93 : 1.07;
    graphTransform.scale = Math.max(0.4, Math.min(2.5, graphTransform.scale * delta));
    syncResetBtn();
  }, { passive: false });

  view.addEventListener('touchstart', (e) => {
    if (e.target.closest('.iso-reset-btn')) return;
    if (e.touches.length === 1) {
      dragMode = 'rotate';
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      startRotX = graphTransform.rotX;
      startRotY = graphTransform.rotY;
    } else if (e.touches.length === 2) {
      dragMode = null;
      lastPinchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
    }
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && dragMode === 'rotate') {
      const dx = e.touches[0].clientX - dragStartX;
      const dy = e.touches[0].clientY - dragStartY;
      graphTransform.rotY = startRotY - dx * 0.3;
      graphTransform.rotX = Math.max(-40, Math.min(40, startRotX + dy * 0.3));
      syncResetBtn();
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
      if (lastPinchDist > 0) {
        graphTransform.scale = Math.max(0.4, Math.min(2.5, graphTransform.scale * (dist / lastPinchDist)));
        syncResetBtn();
      }
      lastPinchDist = dist;
    }
    e.preventDefault();
  }, { passive: false });

  view.addEventListener('touchend', () => { dragMode = null; lastPinchDist = 0; });

  graphResetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const start = { ...graphTransform };
    const duration = 400;
    const t0 = performance.now();
    function animateReset(now) {
      const t = Math.min(1, (now - t0) / duration);
      if (t >= 1) {
        graphTransform.rotX = 0;
        graphTransform.rotY = 0;
        graphTransform.scale = 1;
        graphTransform.panX = 0;
        graphTransform.panY = 0;
      } else {
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        graphTransform.rotX = start.rotX * (1 - ease);
        graphTransform.rotY = start.rotY * (1 - ease);
        graphTransform.scale = start.scale + (1 - start.scale) * ease;
        graphTransform.panX = start.panX * (1 - ease);
        graphTransform.panY = start.panY * (1 - ease);
        requestAnimationFrame(animateReset);
      }
      syncResetBtn();
    }
    requestAnimationFrame(animateReset);
  });
})();

// ============================================================
// Agent Detail Panel (Phase 3: sparklines, uptime, avg durations)
// ============================================================
document.getElementById('agent-detail-back').addEventListener('click', closeAgentDetail);

function openAgentDetail(agentId) {
  selectedAgentId = agentId;
  document.getElementById('sidebar-global').classList.remove('active');
  document.getElementById('sidebar-agent').classList.add('active');
  renderAgentDetail();
}

function closeAgentDetail() {
  selectedAgentId = null;
  document.getElementById('sidebar-agent').classList.remove('active');
  document.getElementById('sidebar-global').classList.add('active');
}

function renderAgentDetail() {
  if (!selectedAgentId) return;
  const agent = getAgentById(selectedAgentId);
  if (!agent) return;
  const state = agentStates[selectedAgentId] || { status: 'offline' };
  const logs = agentLogs[selectedAgentId] || [];
  const tools = agentToolCounts[selectedAgentId] || {};
  const durations = agentToolDurations[selectedAgentId] || {};
  const displayName = getDisplayName(agent);

  // Title
  document.getElementById('agent-detail-title').textContent = displayName.toUpperCase();

  // Header
  const isActive = state.status === 'active';
  document.getElementById('agent-detail-header').innerHTML = `
    <div class="detail-orb ${isActive ? 'glow' : ''}" style="background: ${agent.color}; --c: ${agent.color}">${agent.abbreviation}</div>
    <div class="detail-agent-info">
      <div class="detail-agent-name">${displayName}</div>
      <div class="detail-agent-dept">${agent.project}</div>
      <div class="detail-agent-cwd">${agent.cwd || ''}</div>
    </div>
    <span class="detail-status-badge ${state.status}">${state.status.toUpperCase()}</span>
  `;

  // Status section with Phase 3 uptime
  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '\u2014';
  const uptime = state.sessionStart ? getTimeSince(state.sessionStart).replace(' ago', '') : '\u2014';
  const taskText = state.currentTask || 'None';
  const toolText = state.currentTool || '\u2014';
  const eventCount = logs.length;

  // Richer task display from toolDetail
  let richTask = taskText;
  if (state.toolDetail && state.toolDetail.summary) {
    richTask = state.toolDetail.summary;
  }

  document.getElementById('agent-detail-status').innerHTML = `
    <div class="detail-status-grid">
      <div class="detail-stat">
        <div class="detail-stat-label">LAST ACTIVE</div>
        <div class="detail-stat-value">${timeSince}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">UPTIME</div>
        <div class="detail-stat-value">${uptime}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">EVENTS</div>
        <div class="detail-stat-value">${eventCount}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">TOOLS USED</div>
        <div class="detail-stat-value">${Object.keys(tools).length}</div>
      </div>
    </div>
    <div class="detail-stat" style="margin-top: 8px">
      <div class="detail-stat-label">CURRENT TASK</div>
      <div class="detail-stat-value task">${richTask}</div>
    </div>
    <div class="detail-sparkline-wrap" style="margin-top: 8px">
      <div class="detail-stat-label">ACTIVITY (5 MIN)</div>
      <canvas id="sparkline-canvas" width="280" height="40"></canvas>
    </div>
  `;

  // Draw sparkline
  requestAnimationFrame(() => {
    const canvas = document.getElementById('sparkline-canvas');
    if (canvas) drawSparkline(canvas, selectedAgentId, 5 * 60 * 1000);
  });

  // Tool usage bars with Phase 3 avg durations
  const toolEntries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  const maxCount = toolEntries.length > 0 ? toolEntries[0][1] : 1;
  if (toolEntries.length === 0) {
    document.getElementById('agent-detail-tools').innerHTML = '<div class="detail-no-logs">No tools used yet</div>';
  } else {
    document.getElementById('agent-detail-tools').innerHTML = toolEntries.map(([name, count]) => {
      const durs = durations[name] || [];
      const avgMs = durs.length > 0 ? Math.round(durs.reduce((s, v) => s + v, 0) / durs.length) : null;
      const avgLabel = avgMs !== null ? `<span class="detail-tool-avg">avg ${avgMs}ms</span>` : '';
      return `
        <div class="detail-tool-bar">
          <span class="detail-tool-name">${name}</span>
          <div class="detail-tool-track"><div class="detail-tool-fill" style="width: ${(count / maxCount) * 100}%"></div></div>
          <span class="detail-tool-count">${count}</span>
          ${avgLabel}
        </div>
      `;
    }).join('');
  }

  // Event log
  if (logs.length === 0) {
    document.getElementById('agent-detail-log').innerHTML = '<div class="detail-no-logs">No events recorded yet</div>';
  } else {
    document.getElementById('agent-detail-log').innerHTML = logs.slice(0, 30).map(log => {
      let html = `<div class="detail-log-entry"><span class="dl-time">${log.timeStr}</span>`;
      html += `<span class="dl-status">${log.oldStatus} > ${log.newStatus}</span>`;
      if (log.tool) html += ` <span class="dl-tool">${log.tool}</span>`;
      if (log.task) html += `<br><span class="dl-task">${log.task}</span>`;
      html += '</div>';
      return html;
    }).join('');
  }
}

// Phase 3: Sparkline drawing
function drawSparkline(canvas, agentId, windowMs) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const timeline = agentToolTimeline[agentId] || [];
  if (timeline.length === 0) return;

  const now = Date.now();
  const cutoff = now - windowMs;
  const BUCKETS = 30;
  const bucketMs = windowMs / BUCKETS;
  const counts = new Array(BUCKETS).fill(0);

  for (const entry of timeline) {
    if (entry.time < cutoff) continue;
    const bucket = Math.min(BUCKETS - 1, Math.floor((entry.time - cutoff) / bucketMs));
    counts[bucket]++;
  }

  const maxCount = Math.max(1, ...counts);
  const tv = getThemeVars();
  const barW = (W - 4) / BUCKETS;

  // Parse accent color once (handles both hex and rgb formats)
  const accentRgb = parseColorToRgb(tv.accent);

  for (let i = 0; i < BUCKETS; i++) {
    const h = (counts[i] / maxCount) * (H - 4);
    const alpha = 0.3 + (counts[i] / maxCount) * 0.7;
    ctx.fillStyle = `rgba(${accentRgb},${alpha})`;
    ctx.fillRect(2 + i * barW, H - 2 - h, barW - 1, h);
  }
}

function recordAgentEvent(agentId, oldStatus, newStatus, tool, task) {
  if (!agentLogs[agentId]) agentLogs[agentId] = [];
  const timeStr = `${Math.floor((Date.now() - (window._startTime || Date.now())) / 1000)}s`;
  agentLogs[agentId].unshift({ timeStr, oldStatus, newStatus, tool, task });
  if (agentLogs[agentId].length > 100) agentLogs[agentId].length = 100;

  if (tool) {
    if (!agentToolCounts[agentId]) agentToolCounts[agentId] = {};
    agentToolCounts[agentId][tool] = (agentToolCounts[agentId][tool] || 0) + 1;

    // Record timeline entry for sparklines
    if (!agentToolTimeline[agentId]) agentToolTimeline[agentId] = [];
    agentToolTimeline[agentId].push({ time: Date.now(), tool });
    // Keep only last 10 minutes
    const cutoff = Date.now() - 10 * 60 * 1000;
    while (agentToolTimeline[agentId].length > 0 && agentToolTimeline[agentId][0].time < cutoff) {
      agentToolTimeline[agentId].shift();
    }
  }

  if (selectedAgentId === agentId) renderAgentDetail();
}

function attachAgentClick(el, agentId) {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    openAgentDetail(agentId);
  });
}

// ============================================================
// Shared utilities
// ============================================================
function parseColorToRgb(color) {
  color = color.trim();
  // Hex: #rrggbb
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return `${parseInt(hex[1], 16)},${parseInt(hex[2], 16)},${parseInt(hex[3], 16)}`;
  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return `${rgb[1]},${rgb[2]},${rgb[3]}`;
  return '255,255,255'; // fallback
}

function getTimeSince(isoDate) {
  const diff = Math.max(0, Date.now() - new Date(isoDate).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function addLogEntry(agentId, oldStatus, newStatus, tool) {
  const timeStr = `${Math.floor((Date.now() - (window._startTime || Date.now())) / 1000)}s`;
  const agent = getAgentById(agentId);
  const agentName = agent ? getDisplayName(agent) : `@${agentId}`;

  let text = `<span class="time">${timeStr}</span> <span class="marker">[*]</span> <span class="agent-ref">${agentName}</span> <span class="transition">${oldStatus.toUpperCase()} > ${newStatus.toUpperCase()}</span>`;
  if (tool) text += ` <span class="tool-name">${tool}</span>`;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = text;
  activityLogEl.insertBefore(entry, activityLogEl.firstChild);
  while (activityLogEl.children.length > 50) activityLogEl.removeChild(activityLogEl.lastChild);
}

// Phase 2: Message log entry
function addMessageLogEntry(msg) {
  const timeStr = `${Math.floor((Date.now() - (window._startTime || Date.now())) / 1000)}s`;
  const fromAgent = getAgentById(msg.fromId);
  const fromName = fromAgent ? getDisplayName(fromAgent) : `@${msg.fromId}`;
  const toName = msg.toId || 'all';

  const icon = msg.type === 'broadcast' ? '[>>]' : '[->]';
  const preview = (msg.summary || msg.content || '').substring(0, 60);

  const entry = document.createElement('div');
  entry.className = 'log-entry log-message';
  entry.innerHTML = `<span class="time">${timeStr}</span> <span class="msg-marker">${icon}</span> <span class="agent-ref">${fromName}</span> <span class="msg-arrow">\u2192</span> <span class="msg-recipient">${toName}</span> <span class="msg-preview">${preview}</span>`;
  activityLogEl.insertBefore(entry, activityLogEl.firstChild);
  while (activityLogEl.children.length > 50) activityLogEl.removeChild(activityLogEl.lastChild);
}

// Phase 6: Offline notification
function notifyAgentOffline(agentId, agentName) {
  if (notificationsMuted) return;

  // Audio beep via Web Audio API
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 440;
    gain.gain.value = 0.1;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) { /* ignore audio errors */ }

  // Desktop notification
  if (Notification.permission === 'granted') {
    new Notification('Agent Offline', {
      body: `${agentName} went offline unexpectedly`,
      tag: `offline-${agentId}`
    });
  }
}

function updateStats() {
  let active = 0, idle = 0, offline = 0;
  const allIds = new Set([...agentRegistry.map(a => a.agentId), ...Object.keys(agentStates)]);
  for (const id of allIds) {
    const state = agentStates[id];
    if (!state || state.status === 'offline') offline++;
    else if (state.status === 'active') active++;
    else if (state.status === 'idle') idle++;
  }
  const total = allIds.size;
  teamStatsEl.innerHTML = `[ <span class="stat-active">${active} ACTIVE</span> | <span class="stat-idle">${idle} IDLE</span> | ${offline} OFFLINE | ${total} TOTAL ]`;
}

function updateView(agentId) {
  switch (currentLayout) {
    case 'isometric': updateIsometric(agentId); break;
    case 'list': updateList(agentId); break;
    case 'cards': updateCards(agentId); break;
    case 'graph': break; // Graph redraws every frame
  }
}

// Update time-since values in list/cards every 5s
setInterval(() => {
  if (currentLayout === 'list') renderList();
  if (currentLayout === 'cards') renderCards();
}, 5000);

// ============================================================
// WebSocket
// ============================================================
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => { window._startTime = Date.now(); };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'init') {
      agentRegistry = msg.config;
      agentStates = msg.states;
      invalidateLayout();
      renderCurrentLayout();
      updateStats();
    }

    if (msg.type === 'config_update') {
      agentRegistry = msg.config;
      invalidateLayout();
      renderCurrentLayout();
      updateStats();
    }

    // Phase 2: Message history on connect
    if (msg.type === 'message_history') {
      agentMessages = msg.messages || [];
    }

    // Phase 2: Inter-agent message
    if (msg.type === 'agent_message') {
      agentMessages.push(msg.message);
      if (agentMessages.length > 200) agentMessages.shift();
      addMessageLogEntry(msg.message);
      queueMessageAnimation(msg.message.fromId, msg.message.toId);
    }

    if (msg.type === 'update') {
      const agent = msg.agent;
      // Support both new (agentId) and old (id) field names
      const agentId = agent.agentId || agent.id;
      if (!agentId) return; // skip malformed updates

      // Normalize into new schema
      agent.agentId = agentId;

      // If this agent isn't in registry yet, add a temporary entry
      if (!agentRegistry.find(a => a.agentId === agentId)) {
        const agentType = agent.agentType || 'unknown';
        agentRegistry.push({
          agentId,
          agentType,
          project: agent.project || 'unknown',
          cwd: agent.cwd || '',
          sessionId: agent.sessionId || '',
          color: TYPE_COLORS[(agentRegistry.length) % TYPE_COLORS.length],
          abbreviation: agentType.substring(0, 3).toUpperCase()
        });
        invalidateLayout();
        renderCurrentLayout();
      }

      const oldState = agentStates[agentId] || { status: 'offline' };
      const oldStatus = oldState.status || 'offline';

      if (oldStatus !== agent.status || oldState.currentTool !== agent.currentTool) {
        addLogEntry(agentId, oldStatus, agent.status, agent.currentTool);
        recordAgentEvent(agentId, oldStatus, agent.status, agent.currentTool, agent.currentTask);
      }

      // Record tool timeline entry for sparklines
      if (agent.currentTool && agent.currentTool !== oldState.currentTool) {
        if (!agentToolTimeline[agentId]) agentToolTimeline[agentId] = [];
        agentToolTimeline[agentId].push({ time: Date.now(), tool: agent.currentTool });
      }

      // Record tool duration
      if (agent.lastToolDuration && agent.lastCompletedTool) {
        if (!agentToolDurations[agentId]) agentToolDurations[agentId] = {};
        const toolName = agent.lastCompletedTool;
        if (!agentToolDurations[agentId][toolName]) agentToolDurations[agentId][toolName] = [];
        agentToolDurations[agentId][toolName].push(agent.lastToolDuration);
        // Keep only last 50 per tool
        if (agentToolDurations[agentId][toolName].length > 50) {
          agentToolDurations[agentId][toolName].shift();
        }
      }

      // Phase 6: Offline notification (active -> offline, skip idle)
      if (oldStatus === 'active' && agent.status === 'offline') {
        const agentInfo = getAgentById(agentId);
        const name = agentInfo ? getDisplayName(agentInfo) : `@${agentId}`;
        notifyAgentOffline(agentId, name);
      }

      agentStates[agentId] = agent;
      updateView(agentId);
      updateStats();
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
}

// Fallback color palette for client-side temporary entries
const TYPE_COLORS = [
  '#f5a623', '#4a90d9', '#50e3c2', '#7b68ee', '#ff6b6b',
  '#4cd964', '#b8b8b8', '#e6a8d7', '#ff9f43', '#00d2d3',
  '#6c5ce7', '#fd79a8', '#00cec9', '#e17055', '#74b9ff'
];

// ============================================================
// Init
// ============================================================
window.addEventListener('resize', renderCurrentLayout);

switchLayout(currentLayout);
animateIso();
animateGraph();
connect();
