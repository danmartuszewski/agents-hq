// ============================================================
// State
// ============================================================
let agentConfig = [];
let agentStates = {};
let currentLayout = localStorage.getItem('agents-hq-layout') || 'isometric';
let agentLogs = {};       // { agentId: [{ time, oldStatus, newStatus, tool, task }] }
let agentToolCounts = {}; // { agentId: { toolName: count } }
let selectedAgentId = null;

const DYNAMIC_COLORS = [
  '#f5a623', '#4a90d9', '#50e3c2', '#7b68ee', '#ff6b6b',
  '#4cd964', '#b8b8b8', '#e6a8d7', '#ff9f43', '#00d2d3',
  '#6c5ce7', '#fd79a8', '#00cec9', '#e17055', '#74b9ff'
];

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
// HQ View — Full 3D Canvas Renderer
// ============================================================
const isoCanvas = document.getElementById('iso-grid');
const isoCtx = isoCanvas.getContext('2d');

// 3D scene parameters
const GRID_COLS = 14, GRID_ROWS = 14;
const TILE_SIZE = 55;
const SPHERE_RADIUS = 20;
const CAMERA_DIST = 900;
const BASE_TILT = 35; // default X tilt (degrees) for isometric-like view

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

// ---- Sphere Drawing ----
function drawSphere(ctx, sx, sy, r, color, abbrev, status) {
  const opacity = status === 'offline' ? 0.5 : status === 'idle' ? 0.7 : 1.0;

  // Outer glow for active agents
  if (status === 'active') {
    const glow = ctx.createRadialGradient(sx, sy, r * 0.8, sx, sy, r * 1.8);
    glow.addColorStop(0, color.replace(')', ', 0.2)').replace('rgb(', 'rgba('));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.8, 0, Math.PI * 2);
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

  // Rim light (subtle bright edge on top)
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
  // Parse hex or named color via temporary element
  const m = color.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) {
    const r = Math.round(parseInt(m[1], 16) * factor);
    const g = Math.round(parseInt(m[2], 16) * factor);
    const b = Math.round(parseInt(m[3], 16) * factor);
    return `rgb(${r},${g},${b})`;
  }
  return color;
}

// ---- Department positions in grid coords ----
const deptRowOffset = { 'C-SUITE': 1, 'OPERATIONS': 4, 'CREATIVE': 7, 'SUBAGENT': 10 };
const deptLabelPos = { 'C-SUITE': { col: 1, row: 1.5 }, 'OPERATIONS': { col: 1, row: 4 }, 'CREATIVE': { col: 1, row: 7.5 }, 'SUBAGENT': { col: 1, row: 10.5 } };

function agentToWorld(agent) {
  const baseRow = (deptRowOffset[agent.department] || 0) + agent.gridPosition.row;
  const baseCol = agent.gridPosition.col + 2;
  // Center grid at origin; X = col axis, Z = row axis, Y = up
  const wx = (baseCol - GRID_COLS / 2) * TILE_SIZE;
  const wz = (baseRow - GRID_ROWS / 2) * TILE_SIZE;
  return { x: wx, y: 0, z: wz };
}

// ---- Main 3D Scene Draw ----
function draw3DScene() {
  const ctx = isoCtx;
  const W = isoCanvas.width, H = isoCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const tv = getThemeVars();
  const cx = W * 0.5 + isoTransform.panX, cy = H * 0.44 + isoTransform.panY;

  // Background glow (screen-space, not rotated)
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

      // 4 corners of tile in world space (Y=0 plane)
      const corners3D = [
        { x: wx, y: 0, z: wz - hs },
        { x: wx + hs, y: 0, z: wz },
        { x: wx, y: 0, z: wz + hs },
        { x: wx - hs, y: 0, z: wz }
      ];

      // Transform and project
      const projected = corners3D.map(p => {
        const t = transform3D(p.x, p.y, p.z);
        return project(t.x, t.y, t.z, cx, cy);
      });

      // Depth = average Z after rotation
      const centerT = transform3D(wx, 0, wz);
      const depth = centerT.z;

      // Brightness based on distance from center
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
  for (const agent of agentConfig) {
    const state = agentStates[agent.id] || { status: 'offline' };
    const wp = agentToWorld(agent);
    const sphereY = -SPHERE_RADIUS; // above floor
    const t = transform3D(wp.x, sphereY, wp.z);
    const p = project(t.x, t.y, t.z, cx, cy);
    const r = SPHERE_RADIUS * p.scale;

    newProjected.push({ id: agent.id, sx: p.sx, sy: p.sy, r });

    drawables.push({
      type: 'agent', depth: t.z, draw: () => {
        drawSphere(ctx, p.sx, p.sy, r, agent.color, agent.abbreviation, state.status);
        // Agent name below sphere
        ctx.fillStyle = state.status === 'offline' ? tv.textDim : tv.textMuted;
        ctx.font = `${Math.round(r * 0.45)}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(agent.name, p.sx, p.sy + r + Math.round(r * 0.55));
      }
    });
  }
  projectedAgents = newProjected;

  // Department labels - on the 3D floor
  const activeDepts = new Set(agentConfig.map(a => a.department));
  for (const [dept, pos] of Object.entries(deptLabelPos)) {
    if (!activeDepts.has(dept)) continue;
    const wx = (pos.col - GRID_COLS / 2) * TILE_SIZE - TILE_SIZE * 1.5;
    const wz = (pos.row - GRID_ROWS / 2) * TILE_SIZE;
    const t = transform3D(wx, -5, wz);
    const p = project(t.x, t.y, t.z, cx, cy);
    drawables.push({
      type: 'label', depth: t.z, draw: () => {
        ctx.fillStyle = tv.deptLabel;
        ctx.font = `${Math.max(9, Math.round(11 * p.scale))}px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(dept, p.sx, p.sy);
      }
    });
  }

  // Sort back-to-front (larger depth = farther from camera = draw first)
  drawables.sort((a, b) => b.depth - a.depth);
  for (const d of drawables) d.draw();

  // Particles (screen-space, on top of everything)
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
  let dragMode = null; // 'rotate' | 'pan'
  let dragStartX = 0, dragStartY = 0;
  let startRotX = 0, startRotY = 0;
  let startPanX = 0, startPanY = 0;
  let lastPinchDist = 0;

  function syncResetBtn() {
    const isDefault = isoTransform.rotX === 0 && isoTransform.rotY === 0
      && isoTransform.scale === 1 && isoTransform.panX === 0 && isoTransform.panY === 0;
    isoResetBtn.classList.toggle('visible', !isDefault);
  }

  // Mouse orbit / pan
  view.addEventListener('mousedown', (e) => {
    if (e.target.closest('.iso-reset-btn')) return;
    const isPan = e.button === 1 || (e.button === 0 && e.altKey);
    if (!isPan) {
      // Check if clicking on an agent sphere
      const rect = isoCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      for (const a of projectedAgents) {
        if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) return; // let click handler deal with it
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
      // Hover cursor
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

  // Agent click detection
  isoCanvas.addEventListener('click', (e) => {
    const rect = isoCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // Check front-to-back (closer agents first)
    const sorted = [...projectedAgents].sort((a, b) => {
      // use screen radius as proxy for closeness
      return b.r - a.r;
    });
    for (const a of sorted) {
      if (Math.hypot(mx - a.sx, my - a.sy) <= a.r) {
        openAgentDetail(a.id);
        return;
      }
    }
  });

  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('auxclick', (e) => e.preventDefault()); // prevent middle-click paste

  // Scroll to zoom
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
      dragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      startRotX = isoTransform.rotX;
      startRotY = isoTransform.rotY;
    } else if (e.touches.length === 2) {
      dragging = false;
      lastPinchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
    }
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && dragging) {
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

  view.addEventListener('touchend', () => { dragging = false; lastPinchDist = 0; });

  // Reset button
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
// List View
// ============================================================
function renderList() {
  const body = document.getElementById('list-body');
  body.innerHTML = '';

  const sorted = [...agentConfig].sort((a, b) => {
    const deptOrder = { 'C-SUITE': 0, 'OPERATIONS': 1, 'CREATIVE': 2, 'SUBAGENT': 3 };
    return (deptOrder[a.department] ?? 4) - (deptOrder[b.department] ?? 4) || a.name.localeCompare(b.name);
  });

  for (const agent of sorted) {
    const state = agentStates[agent.id] || { status: 'offline' };
    const row = document.createElement('div');
    row.className = `list-row ${state.status}`;
    row.id = `list-agent-${agent.id}`;

    const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '—';
    const taskText = state.currentTask || '—';
    const toolHtml = state.currentTool ? `<span class="tool-badge">${state.currentTool}</span>` : '—';

    row.innerHTML = `
      <span class="list-col col-status"><span class="status-dot"></span><span class="status-text">${state.status}</span></span>
      <span class="list-col col-agent"><span class="agent-abbr" style="background:${agent.color}">${agent.abbreviation}</span>${agent.name}</span>
      <span class="list-col col-dept">${agent.department}</span>
      <span class="list-col col-task"><span class="task-text">${taskText}</span></span>
      <span class="list-col col-tool">${toolHtml}</span>
      <span class="list-col col-time"><span class="time-text">${timeSince}</span></span>
    `;
    attachAgentClick(row, agent.id);
    body.appendChild(row);
  }
}

function updateList(agentId) {
  const row = document.getElementById(`list-agent-${agentId}`);
  if (!row) { renderList(); return; }
  const agent = agentConfig.find(a => a.id === agentId);
  const state = agentStates[agentId] || { status: 'offline' };
  row.className = `list-row ${state.status}`;

  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '—';
  const taskText = state.currentTask || '—';
  const toolHtml = state.currentTool ? `<span class="tool-badge">${state.currentTool}</span>` : '—';

  row.innerHTML = `
    <span class="list-col col-status"><span class="status-dot"></span><span class="status-text">${state.status}</span></span>
    <span class="list-col col-agent"><span class="agent-abbr" style="background:${agent.color}">${agent.abbreviation}</span>${agent.name}</span>
    <span class="list-col col-dept">${agent.department}</span>
    <span class="list-col col-task"><span class="task-text">${taskText}</span></span>
    <span class="list-col col-tool">${toolHtml}</span>
    <span class="list-col col-time"><span class="time-text">${timeSince}</span></span>
  `;
  row.classList.add('list-row-flash');
  setTimeout(() => row.classList.remove('list-row-flash'), 1000);
}

// ============================================================
// Cards View
// ============================================================
function renderCards() {
  const container = document.getElementById('cards-container');
  container.innerHTML = '';

  for (const agent of agentConfig) {
    const state = agentStates[agent.id] || { status: 'offline' };
    const card = createCard(agent, state);
    container.appendChild(card);
  }
}

function createCard(agent, state) {
  const card = document.createElement('div');
  card.className = `agent-card ${state.status}`;
  card.id = `card-agent-${agent.id}`;
  card.style.setProperty('--agent-color', agent.color);

  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '—';
  const taskText = state.currentTask || 'No active task';
  const toolHtml = state.currentTool ? `<span class="card-tool">${state.currentTool}</span>` : '';
  const statusLabel = state.status.toUpperCase();

  card.innerHTML = `
    <div class="card-header">
      <div class="card-orb" style="background: ${agent.color}">${agent.abbreviation}</div>
      <div class="card-info">
        <div class="card-name">${agent.name}</div>
        <div class="card-dept">${agent.department}</div>
      </div>
      <span class="card-status-badge">${statusLabel}</span>
    </div>
    <div class="card-task">${taskText}</div>
    <div class="card-footer">
      <div>${toolHtml}</div>
      <span class="card-time">${timeSince}</span>
    </div>
  `;
  attachAgentClick(card, agent.id);
  return card;
}

function updateCards(agentId) {
  const agent = agentConfig.find(a => a.id === agentId);
  if (!agent) return;
  const state = agentStates[agentId] || { status: 'offline' };
  const old = document.getElementById(`card-agent-${agentId}`);
  const card = createCard(agent, state);
  if (old) old.replaceWith(card);
  else renderCards();
}

// ============================================================
// Graph View
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
  const depts = {};
  for (const agent of agentConfig) {
    if (!depts[agent.department]) depts[agent.department] = [];
    depts[agent.department].push(agent);
  }

  const deptList = Object.keys(depts);
  graphNodes = [];

  const cx = graphCanvas.width / 2;
  const cy = graphCanvas.height / 2;
  const clusterRadius = Math.min(cx, cy) * 0.55;

  deptList.forEach((dept, di) => {
    const angle = (di / deptList.length) * Math.PI * 2 - Math.PI / 2;
    const clusterX = Math.cos(angle) * clusterRadius;
    const clusterZ = Math.sin(angle) * clusterRadius;

    const agents = depts[dept];
    agents.forEach((agent, ai) => {
      const subAngle = (ai / agents.length) * Math.PI * 2 + 0.3;
      const spread = 55 + agents.length * 20;
      graphNodes.push({
        id: agent.id,
        department: dept,
        color: agent.color,
        abbreviation: agent.abbreviation,
        name: agent.name,
        wx: clusterX + Math.cos(subAngle) * spread,
        wz: clusterZ + Math.sin(subAngle) * spread,
        radius: 26
      });
    });
  });
}

function drawGraph() {
  const ctx = graphCtx;
  const tv = getThemeVars();
  const W = graphCanvas.width, H = graphCanvas.height;
  ctx.clearRect(0, 0, W, H);

  if (graphNodes.length === 0) return;

  const cx = W / 2 + graphTransform.panX;
  const cy = H / 2 + graphTransform.panY;

  // Group nodes by department and project positions
  const deptGroups = {};
  const projected = [];
  for (const node of graphNodes) {
    const t = graphTransform3D(node.wx, 0, node.wz);
    const p = graphProject(t.x, t.y, t.z, cx, cy);
    const r = node.radius * p.scale;
    const proj = { ...node, sx: p.sx, sy: p.sy, r, depth: t.z };
    projected.push(proj);
    if (!deptGroups[node.department]) deptGroups[node.department] = [];
    deptGroups[node.department].push(proj);
  }
  projectedGraphNodes = projected;

  // Collect drawables for depth sorting
  const drawables = [];

  // Department cluster glows and labels
  for (const [dept, nodes] of Object.entries(deptGroups)) {
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
      depth: avgDepth + 100, // draw behind everything
      draw: () => {
        const glow = ctx.createRadialGradient(avgSx, avgSy, 0, avgSx, avgSy, glowR);
        glow.addColorStop(0, tv.clusterBg);
        glow.addColorStop(1, tv.clusterBg.replace(/[\d.]+\)$/, '0)'));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(avgSx, avgSy, glowR, 0, Math.PI * 2);
        ctx.fill();

        // Department label above topmost node
        ctx.fillStyle = tv.deptLabel;
        ctx.font = `${Math.max(9, Math.round(11 * avgScale))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(dept, avgSx, topSy - 12 * avgScale);
      }
    });

    // Intra-department connections
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const lineDepth = Math.max(nodes[i].depth, nodes[j].depth);
        drawables.push({
          depth: lineDepth + 50,
          draw: () => {
            ctx.beginPath();
            ctx.moveTo(nodes[i].sx, nodes[i].sy);
            ctx.lineTo(nodes[j].sx, nodes[j].sy);
            ctx.strokeStyle = tv.graphLine;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        });
      }
    }
  }

  // Cross-department connections
  const deptKeys = Object.keys(deptGroups);
  for (let i = 0; i < deptKeys.length; i++) {
    for (let j = i + 1; j < deptKeys.length; j++) {
      const a = deptGroups[deptKeys[i]];
      const b = deptGroups[deptKeys[j]];
      let minDist = Infinity, bestA, bestB;
      for (const na of a) {
        for (const nb of b) {
          const d = Math.hypot(na.sx - nb.sx, na.sy - nb.sy);
          if (d < minDist) { minDist = d; bestA = na; bestB = nb; }
        }
      }
      if (bestA && bestB) {
        const lineDepth = Math.max(bestA.depth, bestB.depth);
        drawables.push({
          depth: lineDepth + 50,
          draw: () => {
            ctx.beginPath();
            ctx.moveTo(bestA.sx, bestA.sy);
            ctx.lineTo(bestB.sx, bestB.sy);
            ctx.strokeStyle = tv.graphLineCross;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 8]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        });
      }
    }
  }

  // Agent spheres
  const now = Date.now();
  for (const node of projected) {
    const state = agentStates[node.id] || { status: 'offline' };
    const status = state.status;
    const isActive = status === 'active';

    drawables.push({
      depth: node.depth,
      draw: () => {
        // Active pulse ring
        if (isActive) {
          const pulse = ((now % 2000) / 2000);
          ctx.beginPath();
          ctx.arc(node.sx, node.sy, node.r + pulse * 15 * (node.r / node.radius), 0, Math.PI * 2);
          ctx.strokeStyle = node.color + Math.round((1 - pulse) * 60).toString(16).padStart(2, '0');
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        drawSphere(ctx, node.sx, node.sy, node.r, node.color, node.abbreviation, status);

        // Agent name below sphere
        ctx.fillStyle = isActive ? tv.graphNameActive : tv.graphNameDim;
        ctx.font = `${Math.max(8, Math.round(10 * (node.r / node.radius)))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(node.name, node.sx, node.sy + node.r + 14 * (node.r / node.radius));
      }
    });
  }

  // Depth sort: larger depth (farther) draws first
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

  // Touch support
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
// Agent Detail Panel
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
  const agent = agentConfig.find(a => a.id === selectedAgentId);
  if (!agent) return;
  const state = agentStates[selectedAgentId] || { status: 'offline' };
  const logs = agentLogs[selectedAgentId] || [];
  const tools = agentToolCounts[selectedAgentId] || {};

  // Title
  document.getElementById('agent-detail-title').textContent = agent.name.toUpperCase();

  // Header
  const isActive = state.status === 'active';
  document.getElementById('agent-detail-header').innerHTML = `
    <div class="detail-orb ${isActive ? 'glow' : ''}" style="background: ${agent.color}; --c: ${agent.color}">${agent.abbreviation}</div>
    <div class="detail-agent-info">
      <div class="detail-agent-name">${agent.name}</div>
      <div class="detail-agent-dept">${agent.department}</div>
    </div>
    <span class="detail-status-badge ${state.status}">${state.status.toUpperCase()}</span>
  `;

  // Status section
  const timeSince = state.lastActivity ? getTimeSince(state.lastActivity) : '—';
  const taskText = state.currentTask || 'None';
  const toolText = state.currentTool || '—';
  const eventCount = logs.length;

  document.getElementById('agent-detail-status').innerHTML = `
    <div class="detail-status-grid">
      <div class="detail-stat">
        <div class="detail-stat-label">LAST ACTIVE</div>
        <div class="detail-stat-value">${timeSince}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">EVENTS</div>
        <div class="detail-stat-value">${eventCount}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">CURRENT TOOL</div>
        <div class="detail-stat-value">${toolText}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">TOOLS USED</div>
        <div class="detail-stat-value">${Object.keys(tools).length}</div>
      </div>
    </div>
    <div class="detail-stat" style="margin-top: 8px">
      <div class="detail-stat-label">CURRENT TASK</div>
      <div class="detail-stat-value task">${taskText}</div>
    </div>
  `;

  // Tool usage bars
  const toolEntries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  const maxCount = toolEntries.length > 0 ? toolEntries[0][1] : 1;
  if (toolEntries.length === 0) {
    document.getElementById('agent-detail-tools').innerHTML = '<div class="detail-no-logs">No tools used yet</div>';
  } else {
    document.getElementById('agent-detail-tools').innerHTML = toolEntries.map(([name, count]) => `
      <div class="detail-tool-bar">
        <span class="detail-tool-name">${name}</span>
        <div class="detail-tool-track"><div class="detail-tool-fill" style="width: ${(count / maxCount) * 100}%"></div></div>
        <span class="detail-tool-count">${count}</span>
      </div>
    `).join('');
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

function recordAgentEvent(agentId, oldStatus, newStatus, tool, task) {
  if (!agentLogs[agentId]) agentLogs[agentId] = [];
  const timeStr = `${Math.floor((Date.now() - (window._startTime || Date.now())) / 1000)}s`;
  agentLogs[agentId].unshift({ timeStr, oldStatus, newStatus, tool, task });
  // Keep max 100 entries per agent
  if (agentLogs[agentId].length > 100) agentLogs[agentId].length = 100;

  // Track tool counts
  if (tool) {
    if (!agentToolCounts[agentId]) agentToolCounts[agentId] = {};
    agentToolCounts[agentId][tool] = (agentToolCounts[agentId][tool] || 0) + 1;
  }

  // Update detail panel if this agent is selected
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
  const agent = agentConfig.find(a => a.id === agentId);
  const agentName = agent ? agent.name : `@${agentId}`;

  let text = `<span class="time">${timeStr}</span> <span class="marker">[*]</span> <span class="agent-ref">${agentName}</span> <span class="transition">${oldStatus.toUpperCase()} > ${newStatus.toUpperCase()}</span>`;
  if (tool) text += ` <span class="tool-name">${tool}</span>`;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = text;
  activityLogEl.insertBefore(entry, activityLogEl.firstChild);
  while (activityLogEl.children.length > 50) activityLogEl.removeChild(activityLogEl.lastChild);
}

function updateStats() {
  let active = 0, idle = 0, offline = 0;
  // Count from all known agents (config + any in state)
  const allIds = new Set([...agentConfig.map(a => a.id), ...Object.keys(agentStates)]);
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
      agentConfig = msg.config;
      agentStates = msg.states;
      renderCurrentLayout();
      updateStats();
    }

    if (msg.type === 'config_update') {
      agentConfig = msg.config;
      renderCurrentLayout();
      updateStats();
    }

    if (msg.type === 'update') {
      const agent = msg.agent;

      // If this agent isn't in config yet, it's a dynamically registered agent
      // (config_update may arrive after the first state update)
      if (!agentConfig.find(a => a.id === agent.id)) {
        agentConfig.push({
          id: agent.id,
          name: `@${agent.id}`,
          abbreviation: agent.id.substring(0, 3).toUpperCase(),
          department: 'SUBAGENT',
          color: DYNAMIC_COLORS[agentConfig.length % DYNAMIC_COLORS.length],
          gridPosition: { row: Math.floor(agentConfig.length / 4), col: (agentConfig.length % 4) * 3 + 2 },
          dynamic: true
        });
        renderCurrentLayout();
      }

      const oldState = agentStates[agent.id] || { status: 'offline' };
      const oldStatus = oldState.status || 'offline';

      if (oldStatus !== agent.status || oldState.currentTool !== agent.currentTool) {
        addLogEntry(agent.id, oldStatus, agent.status, agent.currentTool);
        recordAgentEvent(agent.id, oldStatus, agent.status, agent.currentTool, agent.currentTask);
      }

      agentStates[agent.id] = agent;
      updateView(agent.id);
      updateStats();
    }
  };

  ws.onclose = () => setTimeout(connect, 2000);
}

// ============================================================
// Init
// ============================================================
window.addEventListener('resize', renderCurrentLayout);

// Set initial layout from localStorage
switchLayout(currentLayout);
animateIso();
animateGraph();
connect();
