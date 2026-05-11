const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');

const PORT = 3456;
const PID_DIR = path.join(os.homedir(), '.agent-pet');
const SERVER_PID_FILE = path.join(PID_DIR, 'terminal-server.pid');

function ensurePidDir() {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function writePidFile(file, pid) {
  ensurePidDir();
  fs.writeFileSync(file, String(pid));
}

function removePidFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

// 返回 true 表示 3456 端口当前被占用
function probePort(port = PORT, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

// 验证是 terminal-server 而不是别的进程占用（通过 /health）
function probeHealth(port = PORT, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json && (json.status === 'ok' || json.ok === true));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealth(maxMs = 5000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeHealth()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function ensureServer() {
  // 1. 端口空闲？直接启
  const occupied = await probePort();
  if (!occupied) {
    return await startServer();
  }
  // 2. 端口占用 → 健康检查
  if (await probeHealth()) {
    console.log('✓ terminal-server already running, reusing');
    return { reused: true };
  }
  // 3. 端口被别的进程占用
  throw new Error(
    `Port ${PORT} is occupied by a non-terminal-server process.\n` +
    `Please free this port before running agent-pet start.\n` +
    `On Windows: netstat -ano | findstr :${PORT}  → then taskkill /PID <pid> /F`
  );
}

async function startServer() {
  const serverEntry = path.resolve(__dirname, '..', '..', '..', 'terminal-server', 'src', 'index.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`terminal-server entry not found: ${serverEntry}`);
  }
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  writePidFile(SERVER_PID_FILE, child.pid);
  console.log(`→ Starting terminal-server (pid ${child.pid})...`);
  const healthy = await waitForHealth(5000);
  if (!healthy) {
    throw new Error('terminal-server failed to become healthy within 5s. Check ~/.agent-pet/ or try `agent-pet stop` and retry.');
  }
  console.log('✓ terminal-server ready');
  return { reused: false, pid: child.pid };
}

async function stopServer() {
  const pid = readPidFile(SERVER_PID_FILE);
  if (!pid) {
    // 没 PID 文件，但端口可能被手动启的 server 占着——不主动杀
    if (await probeHealth()) {
      console.log('⚠ terminal-server running but not managed by agent-pet (no pid file), skipping');
    }
    return;
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid);
      console.log(`→ Stopped terminal-server (pid ${pid})`);
    } catch (e) {
      console.warn(`Failed to stop terminal-server pid ${pid}: ${e.message}`);
    }
  }
  removePidFile(SERVER_PID_FILE);
}

module.exports = {
  ensureServer,
  stopServer,
  startServer,
  readPidFile,
  writePidFile,
  removePidFile,
  isPidAlive,
  probePort,
  probeHealth,
  waitForHealth,
  PORT,
  PID_DIR,
  SERVER_PID_FILE,
};
