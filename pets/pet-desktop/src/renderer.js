// Pet states
const STATES = {
  IDLE: 'idle',
  IDLE_LONG: 'idle_long',
  WORKING: 'working',
  THINKING: 'thinking',
  SUCCESS: 'success',
  ERROR: 'error'
};

function permissionModeBadge(mode) {
  switch (String(mode || '').toLowerCase()) {
    case 'auto':
      return { label: 'Auto', className: 'auto', title: 'Claude auto mode' };
    case 'plan':
      return { label: 'Plan', className: 'plan', title: 'Claude plan mode' };
    case 'acceptedits':
      return { label: 'Edits', className: 'edits', title: 'Claude accept edits mode' };
    case 'bypasspermissions':
      return { label: 'Bypass', className: 'bypass', title: 'Claude bypass permissions mode' };
    default:
      return null;
  }
}

// 首条 prompt 前 60 字；超出用省略号字符截断
function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// Project stripe colors: same project keeps one color, visible projects avoid collisions.
const PROJECT_STRIPE_COLORS = [
  '#4FC3F7',
  '#FFB74D',
  '#81C784',
  '#BA68C8',
  '#F06292',
  '#7986CB',
  '#4DB6AC',
  '#E57373',
  '#DCE775',
  '#9575CD',
  '#64B5F6',
  '#FF8A65'
];
const FALLBACK_PROJECT_STRIPE_COLOR = 'hsl(0, 0%, 70%)';

function stableHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

function normalizeProjectKey(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function projectKeyFor(item) {
  if (!item) return '';
  return normalizeProjectKey(
    item.projectId ||
    item.project_id ||
    item.projectPath ||
    item.project_path ||
    item.repository ||
    item.repo ||
    item.cwd ||
    item.project ||
    item.projectName ||
    item.project_name ||
    item.name ||
    ''
  );
}

function colorIndexForProject(key, projectColorIndexes) {
  if (projectColorIndexes.has(key)) {
    return projectColorIndexes.get(key);
  }

  const preferred = stableHash(key) % PROJECT_STRIPE_COLORS.length;
  const usedIndexes = new Set(projectColorIndexes.values());
  let colorIndex = preferred;

  for (let offset = 0; offset < PROJECT_STRIPE_COLORS.length; offset++) {
    const candidate = (preferred + offset) % PROJECT_STRIPE_COLORS.length;
    if (!usedIndexes.has(candidate)) {
      colorIndex = candidate;
      break;
    }
  }

  projectColorIndexes.set(key, colorIndex);
  return colorIndex;
}

function stripeColorForProject(item, projectColorIndexes) {
  const key = projectKeyFor(item);
  if (!key) return FALLBACK_PROJECT_STRIPE_COLOR;
  const colorIndex = colorIndexForProject(key, projectColorIndexes);
  return PROJECT_STRIPE_COLORS[colorIndex];
}

// 相对时间文案
function formatRelativeTime(startedAt) {
  if (!startedAt) return '';
  const ts = startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime();
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h 前`;
  return `${Math.floor(s / 86400)}d 前`;
}

// 绝对时间（tooltip 用）
function formatAbsoluteTime(startedAt) {
  if (!startedAt) return '';
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Default animation configuration (fallback)
const DEFAULT_ANIMATION_CONFIG = {
  [STATES.IDLE]: { fps: 8, frames: 12, loop: true },
  [STATES.IDLE_LONG]: { fps: 4, frames: 8, loop: true },
  [STATES.WORKING]: { fps: 10, frames: 10, loop: true },
  [STATES.THINKING]: { fps: 6, frames: 9, loop: true },
  [STATES.SUCCESS]: { fps: 8, frames: 8, loop: false },
  [STATES.ERROR]: { fps: 8, frames: 10, loop: false }
};

// Default sprite path (for 'default' skin)
const DEFAULT_SPRITE_PATH = '../assets/sprites';

// Skin config (received from main process)
let skinConfig = null;

// State transitions after certain events
const STATE_TRANSITIONS = {
  [STATES.SUCCESS]: STATES.IDLE,
  [STATES.ERROR]: STATES.IDLE,
  [STATES.WORKING]: STATES.IDLE
};

// Auto-switch interval (4 seconds)
const AUTO_SWITCH_INTERVAL = 4000;

class Pet {
  constructor() {
    this.currentState = STATES.IDLE;
    this.currentFrame = 0;
    this.isAnimating = false;
    this.animationTimer = null;
    this.autoSwitchTimer = null;
    this.sprite = document.getElementById('pet-sprite');
    this.container = document.getElementById('pet-container');
    this.taskDriven = false;
    this.successShown = false;
    this.spritePath = DEFAULT_SPRITE_PATH;
    this.animationConfig = { ...DEFAULT_ANIMATION_CONFIG };

    this.init();
  }

  init() {
    // Load sprites for all states
    this.loadAllSprites().then(() => {
      this.startAnimation();
      this.startAutoSwitch();
      this.bindEvents();
    });
  }

  // Apply skin configuration from main process
  applySkinConfig(config) {
    if (!config) return;

    skinConfig = config;
    this.skinName = config.name;
    this.spritePath = config.spritePath || DEFAULT_SPRITE_PATH;

    // Merge skin config with defaults for missing states
    for (const [state, stateConfig] of Object.entries(config.states || {})) {
      const upperState = state.toUpperCase();
      if (STATES[upperState]) {
        this.animationConfig[STATES[upperState]] = {
          ...DEFAULT_ANIMATION_CONFIG[STATES[upperState]],
          ...stateConfig
        };
      }
    }

    // Reload sprites if already loaded
    if (this.sprites && Object.keys(this.sprites).length > 0) {
      this.loadAllSprites().then(() => {
        // Restart animation with new sprites
        this.currentFrame = 0;
        if (this.isAnimating) {
          clearTimeout(this.animationTimer);
          this.animate();
        }
      });
    }

    // Apply theme
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  }

  async loadAllSprites() {
    this.sprites = {};

    for (const state of Object.values(STATES)) {
      this.sprites[state] = [];
      const config = this.animationConfig[state];
      if (!config) continue;

      for (let i = 1; i <= config.frames; i++) {
        const frameNum = String(i).padStart(3, '0');
        const img = new Image();
        const src = `${this.spritePath}/${state}/frame_${frameNum}.png`;

        try {
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = src;
          });
          this.sprites[state].push(src);
        } catch (e) {
          console.warn(`Failed to load sprite: ${src}`);
        }
      }
    }
  }

  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.animate();
  }

  animate() {
    if (!this.isAnimating) return;

    const config = this.animationConfig[this.currentState];
    const frames = this.sprites[this.currentState];

    if (!frames || frames.length === 0) return;

    this.container.dataset.state = this.currentState;

    // Update sprite
    this.sprite.src = frames[this.currentFrame];

    // Next frame
    this.currentFrame++;

    // Check if animation ended
    if (this.currentFrame >= config.frames) {
      if (config.loop) {
        this.currentFrame = 0;
      } else {
        this.currentFrame = config.frames - 1;
        // Transition to next state
        const nextState = STATE_TRANSITIONS[this.currentState];
        if (nextState) {
          setTimeout(() => this.setState(nextState), 100);
        }
        return;
      }
    }

    // Schedule next frame
    const delay = 1000 / config.fps;
    this.animationTimer = setTimeout(() => this.animate(), delay);
  }

  setState(newState) {
    if (this.currentState === newState) return;

    this.currentState = newState;
    this.currentFrame = 0;
    this.container.dataset.state = newState;

    // Restart animation with new state
    clearTimeout(this.animationTimer);
    this.animate();
  }

  startAutoSwitch() {
    // Idle 状态累计计时器，用于触发 idle_long（问号/阶段性唤醒）
    this.idleDuration = 0;

    this.autoSwitchTimer = setInterval(() => {
      // 有任务时由 updateTasks 驱动，不走这里
      if (this.taskDriven) {
        this.idleDuration = 0;
        return;
      }

      // success/error 动画不打断
      if (this.currentState === STATES.SUCCESS || this.currentState === STATES.ERROR) {
        return;
      }

      this.idleDuration += AUTO_SWITCH_INTERVAL;

      // 每 20 秒左右出现一次 idle_long（问号/阶段性唤醒），其余 idle
      let newState;
      if (this.idleDuration >= 20000 && this.currentState !== STATES.IDLE_LONG) {
        newState = STATES.IDLE_LONG;
        this.idleDuration = 0;
      } else if (this.currentState === STATES.IDLE_LONG) {
        // idle_long 持续约 4 秒后切回 idle
        if (this.idleDuration >= 4000) {
          newState = STATES.IDLE;
          this.idleDuration = 0;
        }
      } else {
        newState = STATES.IDLE;
      }

      if (newState && newState !== this.currentState) {
        this.setState(newState);
      }
    }, AUTO_SWITCH_INTERVAL);
  }

  handleClick() {
    // Play click animation
    this.sprite.classList.remove('floating');
    this.sprite.classList.add('click-effect');

    // Show success state briefly
    this.setState(STATES.SUCCESS);

    // Remove click effect class
    setTimeout(() => {
      this.sprite.classList.remove('click-effect');
      this.sprite.classList.add('floating');
    }, 300);
  }

  bindEvents() {
    let suppressNextClick = false;
    let dragPointerId = null;
    let dragStartPos = { x: 0, y: 0 };

    const finishDrag = (e) => {
      if (dragPointerId === null) return;
      if (e && e.pointerId !== undefined && e.pointerId !== dragPointerId) return;

      const pointerId = dragPointerId;
      dragPointerId = null;
      try {
        if (this.container.hasPointerCapture(pointerId)) {
          this.container.releasePointerCapture(pointerId);
        }
      } catch (err) {
        // Pointer capture can already be released by the browser.
      }
      window.electronAPI.dragEnd();
    };

    const pointerScreenPoint = (e) => ({
      x: Number.isFinite(e.screenX) ? e.screenX : window.screenX + e.clientX,
      y: Number.isFinite(e.screenY) ? e.screenY : window.screenY + e.clientY
    });

    // Click interaction
    this.container.addEventListener('click', (e) => {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
        return;
      }
      this.handleClick();
    });

    // Double click
    this.container.addEventListener('dblclick', () => {
      this.setState(STATES.WORKING);
    });

    // Drag handling — simplified: renderer only sends start/end,
    // main process tracks mouse via electron.screen API
    this.container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Prevent default to stop any native drag behavior / ghost image
      e.preventDefault();
      const point = pointerScreenPoint(e);
      dragPointerId = e.pointerId;
      dragStartPos = point;
      suppressNextClick = false;
      this.container.setPointerCapture(e.pointerId);
      window.electronAPI.dragStart(point.x, point.y);
    });

    this.container.addEventListener('pointermove', (e) => {
      if (e.pointerId !== dragPointerId) return;
      const point = pointerScreenPoint(e);
      if (Math.abs(point.x - dragStartPos.x) > 3 || Math.abs(point.y - dragStartPos.y) > 3) {
        suppressNextClick = true;
      }
    });

    this.container.addEventListener('pointerup', finishDrag);
    this.container.addEventListener('pointercancel', finishDrag);
    document.addEventListener('mouseup', finishDrag);

    // Prevent native drag behavior on the image element
    this.sprite.addEventListener('dragstart', (e) => {
      e.preventDefault();
    });

    // Add floating class initially
    this.sprite.classList.add('floating');
  }

  updateTasks(tasks) {
    // approval-alert: track waiting state on body class for potential future hooks
    // (no CSS currently consumes this — kept as a stable extension point)
    const hasWaiting = Array.isArray(tasks) && tasks.some(t => t && t.status === 'waiting');
    document.body.classList.toggle('has-waiting', hasWaiting);

    const activeTasks = tasks.filter(t => t.status === 'working' || t.status === 'waiting');
    const hasInterrupted = tasks.some(t => t.status === 'interrupted');
    const allDone = tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'interrupted');

    if (hasInterrupted && activeTasks.length === 0) {
      // 有中断任务 → 红色 error 动画
      this.taskDriven = true;
      if (this.currentState !== STATES.ERROR) {
        this.setState(STATES.ERROR);
      }
    } else if (activeTasks.length >= 4) {
      // 4+ 活跃任务 → 高负荷 thinking 动画
      this.taskDriven = true;
      this.successShown = false;
      if (this.currentState !== STATES.THINKING) {
        this.setState(STATES.THINKING);
      }
    } else if (activeTasks.length > 0) {
      // 1-3 个活跃任务 → working 动画
      this.taskDriven = true;
      this.successShown = false;
      if (this.currentState !== STATES.WORKING) {
        this.setState(STATES.WORKING);
      }
    } else if (allDone && !this.successShown) {
      // 全部完成 → success 动画（只播一次）
      this.taskDriven = true;
      this.successShown = true;
      if (this.currentState !== STATES.SUCCESS) {
        this.setState(STATES.SUCCESS);
      }
    } else if (tasks.length === 0) {
      // 无任务 → 交回给 auto-switch，仅在从有任务变为无任务时重置 idle 计时器
      if (this.taskDriven) {
        this.idleDuration = 0;
      }
      this.taskDriven = false;
      this.successShown = false;
    }
  }

  requestSkin(skinName) {
    window.electronAPI.setSkin(skinName);
  }
}

// Task list renderer - unified view for tasks AND sessions
class TaskList {
  constructor() {
    this.panel = document.getElementById('task-panel');
    this.tasks = [];
    this.sessions = [];
    this.tickTimer = null;
    this.hoveredItemKey = null;
    this.lastTooltipPayload = null;
    this.projectColorIndexes = new Map();
    this.startRelativeTimeTick();
  }

  setTasks(tasks) {
    this.tasks = tasks || [];
    this.render();
  }

  setSessions(sessions) {
    this.sessions = sessions || [];
    this.render();
  }

  // 相对时间每 30s 刷一次（设计 §4.2 / AC-4）
  startRelativeTimeTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.render();
    }, 30000);
  }

  showTooltip(cardEl, item) {
    const key = this.itemKey(item);
    this.hoveredItemKey = key;
    const displayPrompt = item.sessionTitle || item.firstPrompt || '';
    const prompt = (displayPrompt && displayPrompt.trim())
      ? displayPrompt
      : '（用户尚未输入任何 prompt）';
    const rect = cardEl.getBoundingClientRect();
    const payload = {
      key,
      cwd: item.cwd || '',
      startedAt: formatAbsoluteTime(item.startedAt) || '',
      prompt,
      anchor: {
        x: Math.round(window.screenX + rect.left),
        y: Math.round(window.screenY + rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
    const payloadKey = JSON.stringify(payload);
    if (payloadKey === this.lastTooltipPayload) return;

    this.lastTooltipPayload = payloadKey;
    window.electronAPI.showTooltip(payload);
  }

  hideTooltip() {
    this.hoveredItemKey = null;
    this.lastTooltipPayload = null;
    window.electronAPI.hideTooltip();
  }

  itemKey(item) {
    return `${item.itemType || ''}:${item.id || ''}`;
  }

  findItemByKey(items, key) {
    if (!key) return null;
    return items.find(item => this.itemKey(item) === key) || null;
  }

  reportWindowHeight() {
    if (!window.electronAPI || !window.electronAPI.resizePetWindow) return;
    requestAnimationFrame(() => {
      const panelHeight = this.panel && this.panel.classList.contains('visible')
        ? this.panel.offsetHeight
        : 0;
      const petHeight = document.getElementById('pet-container')?.offsetHeight || 0;
      const bottomPadding = 10;
      window.electronAPI.resizePetWindow(petHeight + panelHeight + bottomPadding);
    });
  }

  render() {
    // Combine tasks and sessions
    const allItems = [
      ...this.tasks.map(t => ({ ...t, itemType: 'task' })),
      ...this.sessions.map(s => ({ ...s, itemType: 'session' }))
    ];

    this.panel.classList.add('visible');
    this.panel.innerHTML = '';
    const hoveredItem = this.findItemByKey(allItems, this.hoveredItemKey);
    if (!hoveredItem) {
      this.hideTooltip();
    }

    for (const item of allItems) {
      const div = document.createElement('div');
      const itemStatus = item.status || 'running';
      div.className = `task-item ${itemStatus}`;
      div.dataset.type = item.itemType;
      div.dataset.id = item.id;
      div.dataset.cwd = item.cwd || '';
      // Left 4px stripe is assigned per project.
      const stripe = document.createElement('div');
      stripe.className = 'task-stripe';
      stripe.style.background = stripeColorForProject(item, this.projectColorIndexes);
      div.appendChild(stripe);

      const indicator = document.createElement('div');
      indicator.className = 'task-indicator';
      div.appendChild(indicator);

      const content = document.createElement('div');
      content.className = 'task-content';

      // 第一行：项目名 + 非默认 Claude permission mode 徽标
      const header = document.createElement('div');
      header.className = 'task-header';

      const project = document.createElement('span');
      project.className = 'task-project';
      project.textContent = this.extractProjectName(item.cwd);
      header.appendChild(project);

      const permissionBadge = permissionModeBadge(item.permissionMode);
      if (permissionBadge) {
        const badge = document.createElement('span');
        badge.className = `task-badge ${permissionBadge.className}`;
        badge.textContent = permissionBadge.label;
        badge.title = permissionBadge.title;
        header.appendChild(badge);
      }
      // Default/manual 不渲染徽标，避免列表噪音
      content.appendChild(header);

      // 第二行：首条 prompt 前 60 字（无值显示占位）
      const promptEl = document.createElement('div');
      promptEl.className = 'task-prompt';
      const displayPrompt = item.sessionTitle || item.firstPrompt || '';
      if (displayPrompt && String(displayPrompt).trim()) {
        promptEl.textContent = truncate(String(displayPrompt), 60);
      } else {
        promptEl.classList.add('placeholder');
        promptEl.textContent = '等待首条对话…';
      }
      content.appendChild(promptEl);

      // 第三行：lastToolSummary — 放在 .task-content（NOT .task-header）以避开右上角绝对定位的 .kill-btn
      if (item.lastToolSummary) {
        const summaryLine = document.createElement('div');
        summaryLine.className = 'task-summary-line';

        const summary = document.createElement('span');
        summary.className = 'task-summary';
        if (item.status === 'completed') {
          summary.textContent = '✓ ' + item.lastToolSummary;
        } else {
          summary.textContent = item.lastToolSummary;
        }
        summaryLine.appendChild(summary);
        content.appendChild(summaryLine);
      }

      div.appendChild(content);

      // 右下角相对时间
      const timeEl = document.createElement('span');
      timeEl.className = 'task-time';
      timeEl.textContent = formatRelativeTime(item.startedAt);
      div.appendChild(timeEl);

      // Single click handler
      div.addEventListener('click', () => {
        console.log('[Renderer] Click on item:', item.itemType, item.id);
        if (item.itemType === 'task') {
          window.electronAPI.openProject(item.cwd);
        } else {
          window.electronAPI.openTerminalClient(item.id);
        }
      });

      // Tooltip hover 绑定
      div.addEventListener('mouseenter', () => this.showTooltip(div, item));
      div.addEventListener('mouseleave', () => this.hideTooltip());

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'kill-btn';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.itemType === 'session') {
          window.electronAPI.claudeKill(item.id);
        } else {
          window.electronAPI.dismissTask(item.id);
        }
      });
      div.appendChild(closeBtn);

      this.panel.appendChild(div);

      if (this.itemKey(item) === this.hoveredItemKey) {
        this.showTooltip(div, item);
      }
    }

    // Add button at bottom
    const addRow = document.createElement('div');
    addRow.className = 'add-row';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '+';

    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cwd = await window.electronAPI.selectWorkingDirectory();
      if (cwd) {
        await window.electronAPI.claudeSpawn(cwd);
      }
    });

    addRow.appendChild(addBtn);
    this.panel.appendChild(addRow);
    this.reportWindowHeight();
  }

  extractProjectName(cwd) {
    if (!cwd) return 'unknown';
    // Extract last folder name from path, handle both / and \
    const parts = cwd.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || 'unknown';
  }
}

// Initialize pet when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const pet = new Pet();
  const taskList = new TaskList();

  // Listen for task updates from main process
  window.electronAPI.onTasksUpdate((tasks) => {
    taskList.setTasks(tasks);
    pet.updateTasks(tasks);
  });

  // Listen for sessions updates from main process
  window.electronAPI.onSessionsUpdate((sessions) => {
    taskList.setSessions(sessions);
  });

  // Listen for skin config from main process
  window.electronAPI.onSkinConfig((config) => {
    console.log('[Pet] Received skin config:', config.name, config.displayName);
    pet.applySkinConfig(config);
  });
});
