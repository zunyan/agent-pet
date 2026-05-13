const { app, BrowserWindow, Menu, ipcMain, screen, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn } = require('child_process');

// Default animation config (fallback for missing states)
const DEFAULT_ANIMATION_CONFIG = {
  idle: { fps: 8, frames: 12, loop: true },
  idle_long: { fps: 4, frames: 8, loop: true },
  working: { fps: 10, frames: 10, loop: true },
  thinking: { fps: 6, frames: 9, loop: true },
  success: { fps: 8, frames: 8, loop: false },
  error: { fps: 8, frames: 10, loop: false }
};

// Global directories
const GLOBAL_PET_DIR = path.join(os.homedir(), '.agent-pet');
const GLOBAL_SKINS_DIR = path.join(GLOBAL_PET_DIR, 'skins');
const GLOBAL_SKIN_CONFIG = path.join(GLOBAL_PET_DIR, 'skin-config.json');

// Parse --skin command-line argument
function getSkinName() {
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--skin') {
      return args[i + 1];
    }
  }
  // Fall back to global config
  const globalSkin = readGlobalSkinConfig();
  return globalSkin || 'default';
}

// Read global skin config from ~/.agent-pet/skin-config.json
function readGlobalSkinConfig() {
  try {
    if (fs.existsSync(GLOBAL_SKIN_CONFIG)) {
      const data = fs.readFileSync(GLOBAL_SKIN_CONFIG, 'utf-8');
      const config = JSON.parse(data);
      return config.skin || null;
    }
  } catch (err) {
    // ignore
  }
  return null;
}

// Load skin manifest - returns { name, displayName, states }
function loadSkinManifest(skinName) {
  let manifestPath;
  let manifest;

  if (skinName === 'default') {
    // Default skin uses the built-in sprites directory
    manifestPath = path.join(__dirname, '..', 'assets', 'sprites', 'manifest.json');
  } else {
    // Check global skins directory first
    const globalPath = path.join(GLOBAL_SKINS_DIR, skinName, 'manifest.json');
    if (fs.existsSync(globalPath)) {
      manifestPath = globalPath;
    } else {
      // Fall back to bundled skins directory
      manifestPath = path.join(__dirname, '..', 'assets', 'skins', skinName, 'manifest.json');
    }
  }

  try {
    if (fs.existsSync(manifestPath)) {
      const data = fs.readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(data);
    } else {
      console.warn(`Skin manifest not found: ${manifestPath}, using default`);
      manifest = { name: 'default', displayName: '默认皮肤', states: DEFAULT_ANIMATION_CONFIG };
    }
  } catch (err) {
    console.error(`Failed to load skin manifest: ${err.message}`);
    manifest = { name: 'default', displayName: '默认皮肤', states: DEFAULT_ANIMATION_CONFIG };
  }

  // Merge with default config for missing states
  const mergedStates = { ...DEFAULT_ANIMATION_CONFIG };
  for (const [state, config] of Object.entries(manifest.states || {})) {
    mergedStates[state] = { ...DEFAULT_ANIMATION_CONFIG[state], ...config };
  }

  return {
    name: manifest.name || skinName,
    displayName: manifest.displayName || skinName,
    states: mergedStates
  };
}

// Get sprite base path for a skin
function getSkinSpritePath(skinName) {
  if (skinName === 'default') {
    return path.join(__dirname, '..', 'assets', 'sprites');
  }
  // Check global skins directory first
  const globalPath = path.join(GLOBAL_SKINS_DIR, skinName);
  if (fs.existsSync(globalPath)) {
    return globalPath;
  }
  // Fall back to bundled skins directory
  return path.join(__dirname, '..', 'assets', 'skins', skinName);
}

// Resolve skin: returns manifest and resolved skin name
function resolveSkin(skinName) {
  const manifest = loadSkinManifest(skinName);
  return {
    ...manifest,
    name: manifest.name || skinName
  };
}

let mainWindow;
let isDragging = false;
let dragInterval = null;
let dragStartMouse = { x: 0, y: 0 };
let dragStartWindow = { x: 0, y: 0 };
let tooltipWindow = null;
let pendingTooltip = null;
let tooltipReady = false;
let wsMap = {}; // sessionId -> WebSocket

// approval-alert: track sessions that have already been notified during the
// current waiting cycle. Cleared on exit of waiting state. Not persisted
// across process restarts (acceptable per AC-6).
//   key   = sessionId
//   value = { notifiedAt: number, lastStatus: string, cwd: string }
const notifiedSessions = new Map();

// approval-alert: edge-triggered logging state. reconcileApprovalAlerts runs
// every 1s; without these guards the badge / flashFrame log lines spam the
// console on every poll. We only log when the observed value transitions.
// Sentinels (-1, null) guarantee the first real value is always logged.
let lastLoggedBadge = -1;
let lastLoggedFlashOn = null;

// approval-alert: extract project short name (last path segment) from cwd
function extractProjectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// approval-alert: build notification body following FR-1 fallback rules
function buildApprovalNotificationBody(task) {
  const project = extractProjectName(task && task.cwd);
  const toolName = (task && task.lastTool) ? String(task.lastTool).trim() : '';
  const message = (task && task.waitingMessage) ? String(task.waitingMessage).slice(0, 80).trim() : '';

  if (!project) {
    // cwd missing → drop project segment entirely
    return 'A task is waiting for your approval';
  }
  if (!toolName && !message) {
    return `[${project}] A task is waiting for your approval`;
  }
  if (toolName && message) {
    return `[${project}] ${toolName}: ${message}`;
  }
  // Only one of toolName / message present
  return `[${project}] ${toolName || message}`;
}

// approval-alert: pop a single OS notification for a freshly-entered waiting task
function showApprovalNotification(task) {
  if (!Notification.isSupported()) {
    console.log('[approval-alert] Notification API unavailable, fallback to overlay+flash only');
    return;
  }
  try {
    const body = buildApprovalNotificationBody(task);
    const n = new Notification({
      title: 'Claude Code needs your approval',
      body,
      silent: false
    });
    n.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    n.show();
    console.log(`[approval-alert] notify session=${task && task.id} cwd=${task && task.cwd}`);
  } catch (e) {
    console.log(`[approval-alert] notification skipped: ${e.message}`);
  }
}

// approval-alert: per-poll edge-detection driver. Consumes the unfiltered
// hookTasks array (NOT renderer's filteredTasks) so notifications survive
// the sessions-vs-hooks dedup that exists for UI purposes only.
function reconcileApprovalAlerts(hookTasks) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // 1. Build current waiting set from raw hook tasks
  const currentWaiting = new Map();
  if (Array.isArray(hookTasks)) {
    for (const t of hookTasks) {
      if (t && t.status === 'waiting' && t.id) {
        currentWaiting.set(t.id, t);
      }
    }
  }

  // 2. Edge: entered waiting → notify (deduped per cycle by lastStatus check)
  for (const [id, task] of currentWaiting) {
    const prev = notifiedSessions.get(id);
    if (!prev || prev.lastStatus !== 'waiting') {
      showApprovalNotification(task);
      notifiedSessions.set(id, {
        notifiedAt: Date.now(),
        lastStatus: 'waiting',
        cwd: task.cwd || ''
      });
    }
  }

  // 3. Edge: exited waiting → drop tracking entry so next entry re-notifies
  for (const id of [...notifiedSessions.keys()]) {
    if (!currentWaiting.has(id)) {
      notifiedSessions.delete(id);
    }
  }

  // 4. flashFrame: keep flashing while any waiting task exists and the window
  //    is unfocused. Stop only when no waiting tasks remain (focus event
  //    handles the focus-driven stop separately, see createWindow()).
  const hasWaiting = currentWaiting.size > 0;
  try {
    if (hasWaiting && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
      // Edge-triggered: only log when transitioning from off/unknown -> on
      if (lastLoggedFlashOn !== true) {
        console.log('[approval-alert] flashFrame on');
        lastLoggedFlashOn = true;
      }
    } else if (!hasWaiting) {
      mainWindow.flashFrame(false);
      if (lastLoggedFlashOn === true) {
        console.log('[approval-alert] flashFrame off');
        lastLoggedFlashOn = false;
      }
    }
  } catch (e) {
    console.log(`[approval-alert] flashFrame skipped: ${e.message}`);
  }

  // 5. Badge count = waiting task count. setBadgeCount is a no-op on Windows
  //    and silently degrades on unsupported Linux desktops; we still call it
  //    unconditionally so the count clears correctly across platforms.
  try {
    const badge = hasWaiting ? currentWaiting.size : 0;
    app.setBadgeCount(badge);
    // Edge-triggered: only log when badge value actually changes. Suppresses
    // the once-per-second `badge=0` heartbeat that previously flooded stdout.
    if (badge !== lastLoggedBadge) {
      console.log(`[approval-alert] badge=${badge}`);
      lastLoggedBadge = badge;
    }
  } catch (e) {
    console.log(`[approval-alert] setBadgeCount skipped: ${e.message}`);
  }
}



// Initialize skin configuration
const skinName = getSkinName();
const skinConfig = loadSkinManifest(skinName);
const skinSpritePath = getSkinSpritePath(skinName);

console.log(`[DesktopPet] Loading skin: ${skinConfig.displayName} (${skinName})`);

// Task watching
let taskPollInterval = null;

const PANEL_WIDTH = 260;
const TOOLTIP_WIDTH = 360;
const TOOLTIP_GAP = 8;
const MIN_WINDOW_HEIGHT = 220;
const MAX_WINDOW_HEIGHT = 900;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Remove default menu
  mainWindow.setMenu(null);

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);

  mainWindow.webContents.on('context-menu', () => {
    contextMenu.popup();
  });

  mainWindow.on('closed', () => {
    if (tooltipWindow && !tooltipWindow.isDestroyed()) {
      tooltipWindow.close();
    }
    mainWindow = null;
  });

  // Safety: stop dragging if window loses focus or is hidden
  mainWindow.on('blur', () => {
    if (isDragging) return;
    stopDrag();
  });

  // approval-alert: stop flashFrame as soon as the user looks at the window
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.flashFrame(false);
      } catch (e) {
        // flashFrame can throw on some Linux WMs; safe to ignore
      }
    }
  });

  // Start polling task events after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    startTaskPolling();
    // Send skin config and sprite path to renderer
    mainWindow.webContents.send('skin-config', {
      ...skinConfig,
      spritePath: skinSpritePath
    });
  });
}

function createTooltipWindow() {
  if (tooltipWindow && !tooltipWindow.isDestroyed()) return tooltipWindow;

  tooltipReady = false;
  tooltipWindow = new BrowserWindow({
    width: TOOLTIP_WIDTH,
    height: 140,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'tooltip-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  tooltipWindow.setMenu(null);
  tooltipWindow.setIgnoreMouseEvents(true);
  tooltipWindow.loadFile(path.join(__dirname, 'tooltip.html'));

  tooltipWindow.webContents.on('did-finish-load', () => {
    tooltipReady = true;
    if (pendingTooltip && tooltipWindow && !tooltipWindow.isDestroyed()) {
      tooltipWindow.webContents.send('tooltip-data', pendingTooltip);
    }
  });

  tooltipWindow.on('closed', () => {
    tooltipWindow = null;
    pendingTooltip = null;
    tooltipReady = false;
  });

  return tooltipWindow;
}

function positionTooltipWindow(anchor, size) {
  if (!tooltipWindow || tooltipWindow.isDestroyed()) return;
  const width = Math.ceil(Number(size && size.width) || TOOLTIP_WIDTH);
  const height = Math.ceil(Number(size && size.height) || 140);
  const gap = TOOLTIP_GAP;
  const point = {
    x: Math.round(anchor.x + anchor.width / 2),
    y: Math.round(anchor.y + anchor.height / 2)
  };
  const display = screen.getDisplayNearestPoint(point);
  const workArea = display.workArea;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const rightX = anchor.x + anchor.width + gap;
  const leftX = anchor.x - width - gap;
  const rightSpace = workRight - rightX;
  const leftSpace = leftX - workArea.x;
  const x = rightSpace >= width || rightSpace >= leftSpace ? rightX : leftX;
  const y = clamp(anchor.y, workArea.y + gap, Math.max(workArea.y + gap, workBottom - height - gap));

  tooltipWindow.setBounds({
    x: Math.round(clamp(x, workArea.x + gap, Math.max(workArea.x + gap, workRight - width - gap))),
    y: Math.round(y),
    width,
    height
  });
}

function showTooltipWindow(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !payload || !payload.anchor) return;
  const win = createTooltipWindow();
  const wasVisible = win.isVisible();
  pendingTooltip = payload;
  if (tooltipReady) {
    win.webContents.send('tooltip-data', payload);
  }
  positionTooltipWindow(payload.anchor, { width: TOOLTIP_WIDTH, height: 140 });
  if (wasVisible) {
    win.showInactive();
  }
}

function hideTooltipWindow() {
  pendingTooltip = null;
  if (tooltipWindow && !tooltipWindow.isDestroyed()) {
    tooltipWindow.hide();
  }
}

function stopDrag() {
  if (dragInterval) {
    clearInterval(dragInterval);
    dragInterval = null;
  }
  isDragging = false;
}

function startTaskPolling() {
  // Poll every 1 second
  taskPollInterval = setInterval(async () => {
    await refreshAll();
  }, 1000);

  // Initial read
  refreshAll();
}

async function refreshAll() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    // Fetch hook tasks from terminal-server
    let hookTasks = [];
    try {
      const hookResp = await fetch('http://localhost:3456/api/hooks');
      hookTasks = await hookResp.json();
    } catch (e) {}

    // Sort hook tasks
    const statusOrder = { working: 0, waiting: 0, interrupted: 1, completed: 2 };
    hookTasks.sort((a, b) => {
      const ao = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
      const bo = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
      if (ao !== bo) return ao - bo;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });

    // Fetch sessions from terminal-server
    let sessions = [];
    try {
      const resp = await fetch('http://localhost:3456/api/sessions');
      sessions = await resp.json();
    } catch (e) {}

    // Send updates to renderer - filter out tasks that have corresponding sessions
    const sessionIds = new Set(sessions.map(s => s.id));
    const filteredTasks = hookTasks.filter(t => !sessionIds.has(t.id));
    // 透传 firstPrompt/startedAt/pid（未提供时保持原值 undefined）
    const projectedTasks = filteredTasks.slice(0, 5).map(t => ({
      ...t,
      type: t.type || 'auto',
      firstPrompt: t.firstPrompt,
      sessionTitle: t.sessionTitle,
      permissionMode: t.permissionMode,
      startedAt: t.startedAt,
      pid: t.pid
    }));
    mainWindow.webContents.send('tasks-update', projectedTasks);

    // Build task lookup by id
    const taskById = {};
    for (const t of hookTasks) {
      taskById[t.id] = t;
    }

    const mapped = sessions.map(s => {
      const task = taskById[s.id];
      const sessionRunning = s.status === 'running';
      const displayStatus = task && !(sessionRunning && task.status === 'completed')
        ? task.status
        : (sessionRunning ? 'idle' : s.status);
      return {
        id: s.id,
        type: 'manual',
        cwd: (task && task.cwd) || s.cwd,
        pid: s.pid ?? (task && task.pid),
        status: displayStatus,
        state: s.state || 'idle',
        toolCount: task ? (task.toolCount || 0) : (s.toolCount || 0),
        lastToolSummary: task ? (task.lastToolSummary || '') : (s.lastToolSummary || ''),
        // 多会话区分新字段：hookTask 优先（首条 prompt 源自 hook），缺失 fallback 到 session
        firstPrompt: (task && task.firstPrompt) || s.firstPrompt,
        sessionTitle: (task && task.sessionTitle) || s.sessionTitle || (task && task.firstPrompt) || s.firstPrompt,
        permissionMode: (task && task.permissionMode) || s.permissionMode,
        startedAt: (task && task.startedAt) || s.startedAt
      };
    });
    mainWindow.webContents.send('sessions-update', mapped);

    // approval-alert: edge-detect waiting transitions on each poll. Uses
    // the unfiltered hookTasks so renderer's filteredTasks dedup never
    // hides a waiting signal from the notification path.
    try {
      reconcileApprovalAlerts(hookTasks);
    } catch (e) {
      console.error('[approval-alert] reconcile error:', e);
    }

    // Renderer reports exact content height after layout.
  } catch (err) {
    console.error('[Main] Refresh error:', err);
  }
}

ipcMain.on('resize-pet-window', (event, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.min(MAX_WINDOW_HEIGHT, Math.ceil(Number(height) || MIN_WINDOW_HEIGHT))
  );
  const current = mainWindow.getSize();
  if (current[0] !== PANEL_WIDTH || Math.abs(current[1] - nextHeight) > 2) {
    mainWindow.setSize(PANEL_WIDTH, nextHeight);
  }
});

ipcMain.on('show-tooltip', (event, payload) => {
  showTooltipWindow(payload);
});

ipcMain.on('hide-tooltip', () => {
  hideTooltipWindow();
});

ipcMain.on('tooltip-size', (event, size) => {
  if (!pendingTooltip || !pendingTooltip.anchor) return;
  if (size && size.key && size.key !== pendingTooltip.key) return;
  positionTooltipWindow(pendingTooltip.anchor, size);
  if (tooltipWindow && !tooltipWindow.isDestroyed() && !tooltipWindow.isVisible()) {
    tooltipWindow.showInactive();
  }
});


app.whenReady().then(() => {
  // approval-alert: Windows requires an AppUserModelId for system notifications
  // to surface in Action Center reliably. Must be called after whenReady and
  // before the first `new Notification()`. Reverse-DNS form per Electron docs.
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.agentpet.desktop');
    } catch (e) {
      console.log(`[approval-alert] setAppUserModelId skipped: ${e.message}`);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }
});

// Handle drag start from renderer
ipcMain.on('drag-start', (event, { x, y }) => {
  if (isDragging) {
    stopDrag();
  }

  const startX = Number(x);
  const startY = Number(y);
  if (!Number.isFinite(startX) || !Number.isFinite(startY)) {
    console.warn(`[DesktopPet] Ignoring drag-start with invalid point: ${x}, ${y}`);
    return;
  }

  hideTooltipWindow();
  isDragging = true;
  dragStartMouse = { x: startX, y: startY };

  if (mainWindow) {
    const [windowX, windowY] = mainWindow.getPosition();
    dragStartWindow = { x: windowX, y: windowY };
  }

  // Use screen API to track mouse position at OS level every ~16ms (60fps)
  dragInterval = setInterval(() => {
    if (!isDragging || !mainWindow || mainWindow.isDestroyed()) {
      stopDrag();
      return;
    }

    const currentMouse = screen.getCursorScreenPoint();
    if (!Number.isFinite(currentMouse.x) || !Number.isFinite(currentMouse.y)) {
      console.warn(`[DesktopPet] Stopping drag with invalid cursor: ${currentMouse.x}, ${currentMouse.y}`);
      stopDrag();
      return;
    }

    const deltaX = currentMouse.x - dragStartMouse.x;
    const deltaY = currentMouse.y - dragStartMouse.y;
    const rawX = dragStartWindow.x + deltaX;
    const rawY = dragStartWindow.y + deltaY;

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      console.warn(`[DesktopPet] Stopping drag with invalid target: ${rawX}, ${rawY}`);
      stopDrag();
      return;
    }

    const display = screen.getDisplayNearestPoint(currentMouse);
    const workArea = display.workArea;
    const [windowWidth, windowHeight] = mainWindow.getSize();
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const minX = workArea.x - windowWidth + 32;
    const maxX = workArea.x + workArea.width - 32;
    const minY = workArea.y;
    const maxY = workArea.y + workArea.height - 32;
    const nextX = Math.trunc(clamp(rawX, minX, maxX));
    const nextY = Math.trunc(clamp(rawY, minY, maxY));

    try {
      mainWindow.setPosition(nextX, nextY);
    } catch (err) {
      console.warn(`[DesktopPet] Stopping drag after setPosition failed: ${err.message}`);
      stopDrag();
    }
  }, 16);
});

ipcMain.on('drag-end', () => {
  stopDrag();
});

// Open project directory in VSCode
ipcMain.on('open-project', (event, cwd) => {
  exec(`code "${cwd}"`, (err) => {
    if (err) console.error('Failed to open VSCode:', err);
  });
});

// Dismiss a completed task
ipcMain.on('dismiss-task', (event, taskId) => {
  // Dismiss via terminal-server
  fetch(`http://localhost:3456/api/hooks/${taskId}`, { method: 'DELETE' })
    .catch(() => {});
  refreshAll();
});

// Handle skin change request
ipcMain.on('set-skin', (event, skinName) => {
  console.log(`[DesktopPet] Skin change requested: ${skinName}`);
  const resolvedSkin = resolveSkin(skinName);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('skin-config', {
      ...resolvedSkin,
      spritePath: getSkinSpritePath(resolvedSkin.name)
    });
  }
});

// Claude process management
ipcMain.handle('select-working-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Directory'
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('claude-spawn', async (event, cwd) => {
  console.log(`[IPC] claude-spawn called with cwd: ${cwd}`);
  try {
    const response = await fetch('http://localhost:3456/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd })
    });
    const session = await response.json();
    console.log(`[IPC] Session created via terminal-server: ${session.id}`);
    return session;
  } catch (err) {
    console.error('[IPC] Failed to create session:', err);
    throw err;
  }
});

ipcMain.handle('claude-write', async (event, { id, input }) => {
  // Forward to terminal-server via WebSocket
  if (wsMap && wsMap[id]) {
    wsMap[id].send(JSON.stringify({ type: 'write', sessionId: id, input }));
  }
  return true;
});


ipcMain.handle('claude-kill', async (event, id) => {
  console.log(`[IPC] claude-kill called for session ${id}`);
  try {
    await fetch(`http://localhost:3456/api/sessions/${id}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    console.error('[IPC] Failed to kill session:', err);
    return false;
  }
});


// Store terminal windows by sessionId
const terminalWindows = new Map();

ipcMain.handle('open-terminal-client', async (event, sessionId) => {
  const url = `http://localhost:3456/?session=${sessionId}`;
  console.log(`[IPC] Opening terminal client at ${url}`);
  require('child_process').exec(`powershell -Command "Start-Process '${url}'"`);
  return true;
});


ipcMain.handle('get-sessions', async () => {
  try {
    const response = await fetch('http://localhost:3456/api/sessions');
    const sessions = await response.json();
    // Convert to the format expected by renderer
    return sessions.map(s => ({
      id: s.id,
      type: s.type || 'manual',
      cwd: s.cwd,
      pid: s.pid,
      status: s.status,
      firstPrompt: s.firstPrompt,
      permissionMode: s.permissionMode,
      startedAt: s.startedAt,
      lastToolSummary: s.lastToolSummary
    }));
  } catch (err) {
    console.error('[IPC] Failed to get sessions:', err);
    return [];
  }
});
