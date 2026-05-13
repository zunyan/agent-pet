const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve terminal-client static files
const terminalClientPath = path.resolve(__dirname, '..', '..', 'terminal-client', 'dist');
console.log('[Server] Serving terminal-client from:', terminalClientPath);
app.use(express.static(terminalClientPath));

// PTY Management
const terminals = new Map(); // sessionId -> { pty, ws, pid }
const sessions = new Map(); // sessionId -> { id, cwd, pid, status, toolCount, lastToolSummary, state, startedAt }
const outputBuffers = new Map(); // sessionId -> string[] (for reconnection)

// Hook events from external Claude Code sessions (VSCode, CLI, etc.)
// Fields: { id, cwd, status, startedAt, lastActivity, toolCount, lastTool,
//          lastToolSummary, completedAt, waitingMessage, firstPrompt }
// firstPrompt: UserPromptSubmit 首次到达时写入 prompt.slice(0,80)，后续不覆盖
const hookTasks = new Map();
const transcriptPathCache = new Map();
const transcriptPromptCache = new Map();
const transcriptTitleCache = new Map();
const transcriptPermissionModeCache = new Map();

// State detection patterns
const STATE_PATTERNS = {
  thinking: /thinking|思考|thought/i,
  working: /using tool|使用工具|tool call|invoking|executing/i,
  reading: /reading|阅读|reading files/i
};

// Tool name extraction
const TOOL_PATTERN = /Using tool:\s*(.+?)(?:\n|$)|Tool:\s*(.+?)(?:\n|$)/i;

// Binary frame types
const FRAME_PTY = 0x00;
const FRAME_JSON = 0x01;

// Helper: create binary frame
function frame(type, data) {
  if (typeof data === 'string') {
    data = new TextEncoder().encode(data);
  }
  const header = Buffer.from([type]);
  return Buffer.concat([header, Buffer.from(data)]);
}

// Helper: parse binary frame
function parseFrame(buffer) {
  if (buffer.length < 1) return null;
  const type = buffer[0];
  const data = buffer.slice(1);
  return { type, data };
}

// Resolve claude executable path (cached for module lifetime).
// Resolution order:
//   1. AGENT_PET_CLAUDE_BIN env var (manual override)
//   2. Non-Windows: 'claude' (let PATH/system resolve)
//   3. Windows: `where claude.cmd` (first match)
//   4. Windows: common npm install locations (APPDATA/LOCALAPPDATA)
let _cachedClaudeBin = null;
function resolveClaudeBin() {
  if (_cachedClaudeBin) return _cachedClaudeBin;

  // 1. Manual override
  if (process.env.AGENT_PET_CLAUDE_BIN) {
    _cachedClaudeBin = process.env.AGENT_PET_CLAUDE_BIN;
    return _cachedClaudeBin;
  }

  // 2. Non-Windows: rely on PATH lookup by pty.spawn
  if (process.platform !== 'win32') {
    _cachedClaudeBin = 'claude';
    return _cachedClaudeBin;
  }

  // 3. Windows: try `where claude.cmd` (swallow stderr to keep console clean)
  const { execSync } = require('child_process');
  const fs = require('fs');
  try {
    const out = execSync('where claude.cmd', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/)[0].trim();
    if (first) {
      _cachedClaudeBin = first;
      return _cachedClaudeBin;
    }
  } catch (_) {
    // not on PATH; fall through to common install locations
  }

  // 4. Windows: check common npm install locations
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'claude.cmd'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        _cachedClaudeBin = candidate;
        return _cachedClaudeBin;
      }
    } catch (_) {
      // ignore and continue
    }
  }

  throw new Error(
    "claude executable not found. Please ensure 'claude' is in PATH, or set AGENT_PET_CLAUDE_BIN env var to the full path."
  );
}

// Spawn PTY with proper settings
function spawnPty(cwd, sessionId, cols = 120, rows = 40) {
  const pty = require('node-pty');
  const claudeBin = resolveClaudeBin();
  const args = ['--dangerously-skip-permissions', '--session-id', sessionId];
  const opts = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env },
  };
  if (process.platform === 'win32') opts.useConpty = true;
  return pty.spawn(claudeBin, args, opts);
}

// Generate session ID (use UUID format to match hook)
function generateId() {
  return crypto.randomUUID();
}

// Update session state based on PTY output
function updateSessionState(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Update state based on patterns
  if (STATE_PATTERNS.thinking.test(data)) {
    session.state = 'thinking';
  } else if (STATE_PATTERNS.working.test(data)) {
    session.state = 'working';
    // Try to extract tool name
    const match = data.match(TOOL_PATTERN);
    if (match) {
      const toolName = match[1] || match[2] || 'unknown';
      session.lastToolSummary = toolName;
      session.toolCount = (session.toolCount || 0) + 1;
    }
  }
}

function buildHookSummary(toolName, toolInput) {
  switch (toolName) {
    case 'Bash': return 'Bash: ' + (toolInput.command || '').slice(0, 60);
    case 'Edit':
    case 'Write':
    case 'Read': return toolName + ': ' + (toolInput.file_path || '');
    case 'Agent': return 'Agent: ' + (toolInput.description || '').slice(0, 50);
    default: return toolName;
  }
}

function clampFirstPrompt(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : '';
}

function cleanPromptText(text) {
  let value = String(text || '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<ide_opened_file>.*$/gm, '')
    .replace(/<system-reminder>.*$/gm, '')
    .replace(/<local-command-caveat>.*$/gm, '')
    .replace(/<command-name>.*$/gm, '')
    .replace(/<command-message>.*$/gm, '')
    .replace(/<command-args>.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value;
}

function isUserContextText(text) {
  const value = String(text || '').trim();
  return /^<(ide_opened_file|system-reminder|local-command-caveat|command-name|command-message|command-args)>/i.test(value)
    || /^The user opened the file .+ in the IDE\./i.test(value);
}

function contentToPromptText(content) {
  if (typeof content === 'string') {
    return cleanPromptText(content);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return cleanPromptText(content
    .filter(part => part
      && part.type === 'text'
      && typeof part.text === 'string'
      && !isUserContextText(part.text))
    .map(part => part.text)
    .join('\n'));
}

function findTranscriptPath(sessionId) {
  if (transcriptPathCache.has(sessionId)) {
    return transcriptPathCache.get(sessionId);
  }

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!sessionId || !fs.existsSync(projectsDir)) {
    return null;
  }

  const stack = [projectsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
        transcriptPathCache.set(sessionId, fullPath);
        return fullPath;
      }
    }
  }
  return null;
}

function readFirstPromptFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  if (transcriptPromptCache.has(transcriptPath)) {
    return transcriptPromptCache.get(transcriptPath);
  }

  let text = '';
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    transcriptPromptCache.set(transcriptPath, '');
    return '';
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.type !== 'user' || !item.message || item.message.role !== 'user' || item.isMeta) {
        continue;
      }
      const prompt = clampFirstPrompt(contentToPromptText(item.message.content));
      if (prompt) {
        transcriptPromptCache.set(transcriptPath, prompt);
        return prompt;
      }
    } catch (_) {
      // Ignore malformed transcript lines.
    }
  }
  transcriptPromptCache.set(transcriptPath, '');
  return '';
}

function readTitleFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  if (transcriptTitleCache.has(transcriptPath)) {
    return transcriptTitleCache.get(transcriptPath);
  }

  let text = '';
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    transcriptTitleCache.set(transcriptPath, '');
    return '';
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const title = clampFirstPrompt(item.aiTitle || item.title || item.sessionTitle);
      if (item.type === 'ai-title' && title) {
        transcriptTitleCache.set(transcriptPath, title);
        return title;
      }
    } catch (_) {
      // Ignore malformed transcript lines.
    }
  }

  transcriptTitleCache.set(transcriptPath, '');
  return '';
}

function normalizePermissionMode(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readPermissionModeFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  if (transcriptPermissionModeCache.has(transcriptPath)) {
    return transcriptPermissionModeCache.get(transcriptPath);
  }

  let text = '';
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    transcriptPermissionModeCache.set(transcriptPath, '');
    return '';
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const mode = normalizePermissionMode(item.permissionMode || item.permission_mode);
      if (mode) {
        transcriptPermissionModeCache.set(transcriptPath, mode);
        return mode;
      }
    } catch (_) {
      // Ignore malformed transcript lines.
    }
  }
  transcriptPermissionModeCache.set(transcriptPath, '');
  return '';
}

function hydrateFirstPrompt(task, rawPrompt, sessionId) {
  if (!task || task.firstPrompt) return;

  const transcriptPath = task.transcriptPath || findTranscriptPath(sessionId);
  const transcriptPrompt = readFirstPromptFromTranscript(transcriptPath);
  if (transcriptPrompt) {
    task.firstPrompt = transcriptPrompt;
    if (transcriptPath && !task.transcriptPath) {
      task.transcriptPath = transcriptPath;
    }
    return;
  }

  const directPrompt = clampFirstPrompt(rawPrompt);
  if (directPrompt) {
    task.firstPrompt = directPrompt;
  }
}

function hydrateSessionTitle(task, sessionId) {
  if (!task || task.sessionTitle) return;

  const transcriptPath = task.transcriptPath || findTranscriptPath(sessionId);
  const transcriptTitle = readTitleFromTranscript(transcriptPath);
  if (transcriptTitle) {
    task.sessionTitle = transcriptTitle;
    if (transcriptPath && !task.transcriptPath) {
      task.transcriptPath = transcriptPath;
    }
    return;
  }

  hydrateFirstPrompt(task, undefined, sessionId);
  if (task.firstPrompt) {
    task.sessionTitle = task.firstPrompt;
  }
}

function hydratePermissionMode(task, rawPermissionMode, sessionId) {
  if (!task || task.permissionMode) return;

  const directMode = normalizePermissionMode(rawPermissionMode);
  if (directMode) {
    task.permissionMode = directMode;
    return;
  }

  const transcriptPath = task.transcriptPath || findTranscriptPath(sessionId);
  const transcriptMode = readPermissionModeFromTranscript(transcriptPath);
  if (transcriptMode) {
    task.permissionMode = transcriptMode;
    if (transcriptPath && !task.transcriptPath) {
      task.transcriptPath = transcriptPath;
    }
  }
}

// Notification types that genuinely mean "waiting for user input".
// Other notification types (auth_success, elicitation_complete,
// elicitation_response, ...) are pure status updates and must not flip
// a task into the waiting state.
const WAITING_NOTIFICATION_TYPES = ['permission_prompt', 'idle_prompt', 'elicitation_dialog'];

function processHookEvent(data) {
  const sessionId = data.session_id || 'unknown';
  const payload = data.data && typeof data.data === 'object' ? data.data : {};
  const cwd = data.cwd || payload.cwd || '';
  const toolName = data.tool_name || payload.tool_name || '';
  const hookEvent = data.hook_event_name || '';
  const promptValue = data.prompt !== undefined ? data.prompt : payload.prompt;
  const hookPid = data.pid ?? data.process_id ?? payload.pid ?? payload.process_id ?? null;
  const toolInput = data.tool_input || payload.tool_input || {};
  const message = data.message ?? payload.message;
  const notificationTypeValue = data.notification_type || payload.notification_type;
  const permissionRequired = data.permission_required || payload.permission_required;
  const transcriptPath = data.transcript_path || payload.transcript_path || null;
  const permissionMode = data.permissionMode || data.permission_mode || payload.permissionMode || payload.permission_mode;
  const timestamp = new Date().toISOString();

  if (hookEvent === 'UserPromptSubmit' || promptValue !== undefined) {
    const existing = hookTasks.get(sessionId);
    if (!existing) {
      const task = {
        id: sessionId, cwd, status: 'working',
        startedAt: timestamp, lastActivity: timestamp,
        toolCount: 0, lastTool: '', lastToolSummary: 'Processing...', completedAt: null,
        pid: hookPid,
        transcriptPath
      };
      hydrateFirstPrompt(task, promptValue, sessionId);
      hydratePermissionMode(task, permissionMode, sessionId);
      hookTasks.set(sessionId, task);
    } else {
      existing.status = 'working';
      existing.lastActivity = timestamp;
      existing.completedAt = null;
      if (transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = transcriptPath;
      }
      if (hookPid != null) {
        existing.pid = hookPid;
      }
      if (cwd && !existing.cwd) {
        existing.cwd = cwd;
      }
      hydrateFirstPrompt(existing, promptValue, sessionId);
      hydratePermissionMode(existing, permissionMode, sessionId);
    }
    return;
  }

  // R1: PermissionRequest must short-circuit BEFORE the toolName branch.
  // Real PermissionRequest payloads include tool_name (Bash/Edit/...), so
  // without this guard they would be claimed by the toolName branch and
  // never set status to 'waiting'. This is the highest-ROI fix.
  if (hookEvent === 'PermissionRequest' || permissionRequired) {
    const fallbackTarget = toolInput.command || toolInput.file_path || '';
    const waitingMessage = message
      ? String(message).slice(0, 80)
      : `${toolName || 'Permission'}: ${fallbackTarget}`.slice(0, 80);
    const existing = hookTasks.get(sessionId);
    if (existing) {
      existing.status = 'waiting';
      existing.lastActivity = timestamp;
      if (hookPid != null) {
        existing.pid = hookPid;
      }
      if (cwd && !existing.cwd) {
        existing.cwd = cwd;
      }
      if (transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = transcriptPath;
      }
      hydrateFirstPrompt(existing, promptValue, sessionId);
      hydratePermissionMode(existing, permissionMode, sessionId);
      existing.waitingMessage = waitingMessage;
      existing.lastToolSummary = waitingMessage;
      existing.completedAt = null;
    } else {
      const task = {
        id: sessionId, cwd, status: 'waiting',
        startedAt: timestamp, lastActivity: timestamp,
        pid: hookPid,
        toolCount: 0, lastTool: toolName || '',
        lastToolSummary: waitingMessage,
        waitingMessage,
        completedAt: null,
        transcriptPath
      };
      hydrateFirstPrompt(task, promptValue, sessionId);
      hydratePermissionMode(task, permissionMode, sessionId);
      hookTasks.set(sessionId, task);
    }
    console.log(`[hook] PermissionRequest -> waiting session=${sessionId} msg="${waitingMessage}"`);
    return;
  }

  if (toolName) {
    const summary = buildHookSummary(toolName, toolInput);
    const existing = hookTasks.get(sessionId);

    // R2: AskUserQuestion always means "waiting" — regardless of whether
    // this is a brand-new task or an existing long-running session where
    // Claude raises a mid-flow question. Previously only the new-task path
    // set 'waiting'; existing sessions were stuck on 'working'.
    // IMPORTANT: only intercept on PreToolUse. PostToolUse for the same
    // tool means the user already answered, and must fall through to R6
    // (PostToolUse + waiting -> working) so the task can resume. Without
    // this guard the task is stuck on 'waiting' forever after answering.
    if (toolName === 'AskUserQuestion' && hookEvent === 'PreToolUse') {
      const question = toolInput.questions
        && toolInput.questions[0] && toolInput.questions[0].question;
      const waitingMessage = (question ? String(question) : 'AskUserQuestion').slice(0, 80);
      if (existing) {
        existing.status = 'waiting';
        existing.lastActivity = timestamp;
        if (hookPid != null) {
          existing.pid = hookPid;
        }
        if (cwd && !existing.cwd) {
          existing.cwd = cwd;
        }
        if (transcriptPath && !existing.transcriptPath) {
          existing.transcriptPath = transcriptPath;
        }
        hydrateFirstPrompt(existing, promptValue, sessionId);
        hydratePermissionMode(existing, permissionMode, sessionId);
        existing.toolCount = (existing.toolCount || 0) + 1;
        existing.lastTool = toolName;
        existing.lastToolSummary = summary;
        existing.waitingMessage = waitingMessage;
        existing.completedAt = null;
      } else {
        const task = {
          id: sessionId, cwd, status: 'waiting',
          startedAt: timestamp, lastActivity: timestamp,
          pid: hookPid,
          toolCount: 1, lastTool: toolName, lastToolSummary: summary,
          waitingMessage,
          completedAt: null,
          transcriptPath
        };
        hydrateFirstPrompt(task, promptValue, sessionId);
        hydratePermissionMode(task, permissionMode, sessionId);
        hookTasks.set(sessionId, task);
      }
      console.log(`[hook] AskUserQuestion -> waiting session=${sessionId}`);
      return;
    }

    if (existing) {
      if (hookPid != null) {
        existing.pid = hookPid;
      }
      if (cwd && !existing.cwd) {
        existing.cwd = cwd;
      }
      if (transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = transcriptPath;
      }
      hydrateFirstPrompt(existing, promptValue, sessionId);
      hydratePermissionMode(existing, permissionMode, sessionId);
      // R6: PostToolUse arriving while in 'waiting' means the user has
      // already approved and the tool has finished — flip back to 'working'
      // so the task doesn't stay stuck on waiting forever. Other status
      // transitions stay unchanged.
      if (hookEvent === 'PostToolUse' && existing.status === 'waiting') {
        existing.status = 'working';
        existing.completedAt = null;
        console.log(`[hook] PostToolUse -> working (was waiting) session=${sessionId}`);
      } else if (hookEvent === 'PreToolUse' && existing.status === 'waiting') {
        // R7: PreToolUse for a new tool while still in 'waiting' means the
        // user rejected the previous PermissionRequest (n / ESC) and Claude
        // moved on to a different tool. Without this branch the session
        // stays stuck on 'waiting' forever (yellow). AskUserQuestion's
        // PreToolUse is intercepted by R2 above and never reaches here.
        existing.status = 'working';
        existing.completedAt = null;
        console.log(`[hook] PreToolUse(${toolName}) -> working (was waiting) session=${sessionId}`);
      } else if (existing.status !== 'completed' && existing.status !== 'interrupted' && existing.status !== 'waiting') {
        existing.status = 'working';
        existing.completedAt = null;
      }
      existing.lastActivity = timestamp;
      existing.toolCount = (existing.toolCount || 0) + 1;
      existing.lastTool = toolName;
      existing.lastToolSummary = summary;
    } else {
      const task = {
        id: sessionId, cwd,
        status: 'working',
        startedAt: timestamp, lastActivity: timestamp,
        pid: hookPid,
        toolCount: 1, lastTool: toolName, lastToolSummary: summary, completedAt: null,
        transcriptPath
      };
      hydrateFirstPrompt(task, promptValue, sessionId);
      hydratePermissionMode(task, permissionMode, sessionId);
      hookTasks.set(sessionId, task);
    }
  } else if (message || notificationTypeValue) {
    // R4: Only treat notifications that genuinely mean "waiting for user"
    // as waiting. Notification types like auth_success / elicitation_complete
    // / elicitation_response are pure status updates and should not flip
    // the task to waiting. Backwards compatibility: a notification with no
    // notification_type but a free-form message (curl simulations) still
    // counts as waiting.
    const existing = hookTasks.get(sessionId);
    if (existing && existing.status !== 'completed' && existing.status !== 'interrupted') {
      const notificationType = notificationTypeValue;
      const isWaitingNotification = notificationType
        ? WAITING_NOTIFICATION_TYPES.includes(notificationType)
        : Boolean(message);

      existing.lastActivity = timestamp;
      if (hookPid != null) {
        existing.pid = hookPid;
      }
      if (cwd && !existing.cwd) {
        existing.cwd = cwd;
      }
      if (transcriptPath && !existing.transcriptPath) {
        existing.transcriptPath = transcriptPath;
      }
      hydrateFirstPrompt(existing, promptValue, sessionId);
      hydratePermissionMode(existing, permissionMode, sessionId);
      if (isWaitingNotification) {
        existing.status = 'waiting';
        existing.waitingMessage = String(message || notificationType || '').slice(0, 80);
        console.log(`[hook] Notification(${notificationType || 'msg-only'}) -> waiting session=${sessionId}`);
      }
    }
  } else if (hookEvent === 'StopFailure') {
    const existing = hookTasks.get(sessionId);
    if (existing) {
      existing.status = 'interrupted';
      existing.completedAt = timestamp;
      existing.lastActivity = timestamp;
      existing.lastToolSummary = 'Interrupted';
    }
  } else if (hookEvent === 'Stop' || !hookEvent) {
    // Only a real Stop event marks a task complete. Other lifecycle hooks
    // such as SubagentStop/SessionStart must not flip long-running sessions
    // to completed.
    const existing = hookTasks.get(sessionId);
    if (existing) {
      existing.status = 'completed';
      existing.completedAt = timestamp;
      existing.lastActivity = timestamp;
    }
  } else {
    const existing = hookTasks.get(sessionId);
    if (existing) {
      existing.lastActivity = timestamp;
    }
  }
}

// Buffer output for reconnection
function bufferOutput(sessionId, data) {
  if (!outputBuffers.has(sessionId)) {
    outputBuffers.set(sessionId, []);
  }
  const buffer = outputBuffers.get(sessionId);
  buffer.push(data);
  // Keep max 1000 lines
  if (buffer.length > 1000) {
    buffer.shift();
  }
}

// Get buffered output
function getBufferedOutput(sessionId) {
  return outputBuffers.get(sessionId) || [];
}

// Clear buffered output
function clearBufferedOutput(sessionId) {
  outputBuffers.delete(sessionId);
}

// WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('[Server] New WebSocket connection');

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const buffer = Buffer.from(message);
      const frame = parseFrame(buffer);

      if (!frame) {
        console.error('[Server] Invalid frame received');
        return;
      }

      if (frame.type === FRAME_JSON) {
        // JSON control message
        const data = JSON.parse(frame.data.toString());
        handleMessage(ws, data);
      } else if (frame.type === FRAME_PTY) {
        // PTY raw input
        const input = frame.data.toString();
        if (ws.sessionId) {
          writeToPty(ws.sessionId, input);
        }
      }
    } catch (err) {
      console.error('[Server] Error handling message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Server] WebSocket disconnected');
    // Don't kill PTY on disconnect - just detach
    for (const [sessionId, term] of terminals.entries()) {
      if (term.ws === ws) {
        term.ws = null;
        break;
      }
    }
  });
});

// Heartbeat to detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// Handle incoming JSON messages
function handleMessage(ws, data) {
  const { type, sessionId, cwd, cols, rows } = data;

  switch (type) {
    case 'init':
      // Client wants to attach to a session
      if (sessionId) {
        attachSession(ws, sessionId);
      }
      break;

    case 'create':
      createSession(ws, cwd, cols || 120, rows || 40);
      break;

    case 'resize':
      resizePty(sessionId, cols, rows);
      break;

    case 'kill':
      killSession(sessionId);
      break;

    default:
      console.log('[Server] Unknown message type:', type);
  }
}

// Create new PTY session
function createSession(ws, cwd, cols = 120, rows = 40) {
  const id = generateId();
  const workingDir = cwd || process.cwd();

  console.log(`[Server] Creating session ${id} in ${workingDir}`);

  try {
    const pty = spawnPty(workingDir, id, cols, rows);

    terminals.set(id, { pty, ws, pid: pty.pid });
    ws.sessionId = id;

    const session = {
      id,
      cwd: workingDir,
      pid: pty.pid,
      status: 'running',
      state: 'idle',
      toolCount: 0,
      lastToolSummary: '',
      startedAt: new Date().toISOString(),
      firstPrompt: null,
      sessionTitle: null
    };
    sessions.set(id, session);
    outputBuffers.set(id, []);

    // Handle PTY exit
    pty.onExit(({ exitCode }) => {
      console.log(`[Server] PTY ${id} exited with code ${exitCode}`);
      terminals.delete(id);
      const s = sessions.get(id);
      if (s) {
        s.status = 'exited';
      }
      broadcastSessions();
      clearBufferedOutput(id);
    });

    // Forward output to attached client
    pty.onData((data) => {
      bufferOutput(id, data);
      updateSessionState(id, data);
      const term = terminals.get(id);
      if (term && term.ws && term.ws.readyState === WebSocket.OPEN) {
        term.ws.send(frame(FRAME_PTY, data));
      }
    });

    // Send ready message
    ws.send(frame(FRAME_JSON, JSON.stringify({
      type: 'ready',
      sessionId: id,
      pid: pty.pid,
      cwd: workingDir
    })));

    broadcastSessions();
    console.log(`[Server] Session ${id} created with PID ${pty.pid}`);
  } catch (err) {
    console.error('[Server] Error creating session:', err);
    ws.send(frame(FRAME_JSON, JSON.stringify({ type: 'error', message: err.message })));
  }
}

// Attach to existing session
function attachSession(ws, sessionId) {
  const term = terminals.get(sessionId);
  const session = sessions.get(sessionId);

  if (!term || !session) {
    ws.send(frame(FRAME_JSON, JSON.stringify({ type: 'error', message: 'Session not found' })));
    return;
  }

  console.log(`[Server] Attaching to session ${sessionId}`);

  // Update ws reference
  term.ws = ws;
  ws.sessionId = sessionId;

  // Send ready message
  ws.send(frame(FRAME_JSON, JSON.stringify({
    type: 'ready',
    sessionId: sessionId,
    pid: session.pid,
    cwd: session.cwd
  })));

  // Send buffered output (last 100 lines)
  const buffer = getBufferedOutput(sessionId);
  if (buffer.length > 0) {
    const recentOutput = buffer.slice(-100).join('');
    ws.send(frame(FRAME_PTY, '\r\n[Reconnected - showing last output]\r\n'));
    ws.send(frame(FRAME_PTY, recentOutput));
  }
}

// Write to PTY
function writeToPty(sessionId, input) {
  const term = terminals.get(sessionId);
  if (term) {
    term.pty.write(input);
  }
}

// Resize PTY
function resizePty(sessionId, cols, rows) {
  const term = terminals.get(sessionId);
  if (term) {
    term.pty.resize(cols, rows);
  }
}

// Kill session
function killSession(sessionId) {
  const term = terminals.get(sessionId);
  if (term) {
    console.log(`[Server] Killing session ${sessionId}`);
    term.pty.kill();
    terminals.delete(sessionId);
  }
  sessions.delete(sessionId);
  clearBufferedOutput(sessionId);
  broadcastSessions();
}

// List all sessions
function listSessions(ws) {
  const sessionList = Array.from(sessions.values());
  ws.send(frame(FRAME_JSON, JSON.stringify({ type: 'sessions', sessions: sessionList })));
}

// Broadcast session list to all connected clients
function broadcastSessions() {
  const sessionList = Array.from(sessions.values());
  const message = frame(FRAME_JSON, JSON.stringify({ type: 'sessions', sessions: sessionList }));

  for (const [, term] of terminals) {
    if (term.ws && term.ws.readyState === WebSocket.OPEN) {
      term.ws.send(message);
    }
  }
}

function normalizeHookTask(task) {
  hydrateFirstPrompt(task, undefined, task.id);
  hydrateSessionTitle(task, task.id);
  hydratePermissionMode(task, undefined, task.id);
  // 保证 firstPrompt/startedAt 字段始终存在（缺失时显式为 null），前端可稳定 destruct
  return {
    ...task,
    type: 'auto',
    pid: task.pid ?? null,
    firstPrompt: task.firstPrompt || null,
    sessionTitle: task.sessionTitle || task.firstPrompt || null,
    permissionMode: task.permissionMode || null,
    startedAt: task.startedAt || null
  };
}

function broadcastHookUpdate() {
  const tasks = Array.from(hookTasks.values()).map(normalizeHookTask);
  const message = frame(FRAME_JSON, JSON.stringify({ type: 'hook-update', tasks }));
  for (const [, term] of terminals) {
    if (term.ws && term.ws.readyState === WebSocket.OPEN) {
      term.ws.send(message);
    }
  }
}

// API endpoints
app.get('/api/sessions', (req, res) => {
  // 合并策略见 technical-design §3.3：firstPrompt/startedAt 优先取 hookTask，pid 优先取 session
  const list = Array.from(sessions.values()).map((session) => {
    const hookTask = hookTasks.get(session.id);
    return {
      id: session.id,
      type: 'manual',
      cwd: session.cwd ?? null,
      pid: session.pid ?? (hookTask && hookTask.pid) ?? null,
      status: session.status ?? null,
      state: session.state ?? null,
      toolCount: session.toolCount ?? 0,
      lastToolSummary: session.lastToolSummary ?? null,
      firstPrompt: (hookTask && hookTask.firstPrompt) || session.firstPrompt || null,
      sessionTitle: (hookTask && hookTask.sessionTitle) || session.sessionTitle || (hookTask && hookTask.firstPrompt) || session.firstPrompt || null,
      permissionMode: (hookTask && hookTask.permissionMode) || session.permissionMode || null,
      startedAt: (hookTask && hookTask.startedAt) || session.startedAt || null
    };
  });
  res.json(list);
});

app.post('/api/sessions', (req, res) => {
  const { cwd } = req.body;
  if (!cwd) {
    return res.status(400).json({ error: 'cwd is required' });
  }

  const id = generateId();
  const workingDir = cwd;

  try {
    const pty = spawnPty(workingDir, id, 120, 40);

    terminals.set(id, { pty, ws: null, pid: pty.pid });

    const session = {
      id,
      cwd: workingDir,
      pid: pty.pid,
      status: 'running',
      state: 'idle',
      toolCount: 0,
      lastToolSummary: '',
      startedAt: new Date().toISOString()
    };
    sessions.set(id, session);
    outputBuffers.set(id, []);

    pty.onExit(({ exitCode }) => {
      terminals.delete(id);
      const s = sessions.get(id);
      if (s) {
        s.status = 'exited';
      }
      broadcastSessions();
      clearBufferedOutput(id);
    });

    pty.onData((data) => {
      bufferOutput(id, data);
      updateSessionState(id, data);
      const term = terminals.get(id);
      if (term && term.ws && term.ws.readyState === WebSocket.OPEN) {
        term.ws.send(frame(FRAME_PTY, data));
      }
    });

    res.json(session);
    console.log(`[Server] Session ${id} created via REST API`);
  } catch (err) {
    console.error('[Server] Error creating session:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  killSession(id);
  res.json({ success: true });
});

// Receive Claude Code hook events
app.post('/api/hook', (req, res) => {
  try {
    processHookEvent(req.body);
    broadcastHookUpdate();
    res.json({ status: 'ok' });
  } catch (err) {
    res.json({ status: 'ok' }); // Always return ok to avoid Claude Code errors
  }
});

// Get hook-tracked tasks
app.get('/api/hooks', (req, res) => {
  const tasks = Array.from(hookTasks.values()).map(normalizeHookTask);
  // Sort: working/waiting first, then interrupted, then completed
  const statusOrder = { working: 0, waiting: 0, interrupted: 1, completed: 2 };
  tasks.sort((a, b) => {
    const ao = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
    const bo = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
    if (ao !== bo) return ao - bo;
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });
  res.json(tasks.slice(0, 10));
});

// Dismiss a hook task
app.delete('/api/hooks/:id', (req, res) => {
  hookTasks.delete(req.params.id);
  broadcastHookUpdate();
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve terminal-client for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(terminalClientPath, 'index.html'));
});

// Start server
const PORT = 3456;
server.listen(PORT, () => {
  console.log(`[Server] Terminal server running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket server running on ws://localhost:${PORT}`);
});
