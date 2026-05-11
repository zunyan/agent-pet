const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const {
  ensureServer,
  stopServer,
  writePidFile,
  readPidFile,
  removePidFile,
  isPidAlive,
  PID_DIR,
} = require('../utils/server-control');

const PET_PID_FILE = path.join(PID_DIR, 'pet-desktop.pid');

async function restart() {
  console.log('🔄 Restarting agent-pet...');

  // 1. 按 PID 精确停止 pet-desktop（避免误杀其他 Electron 应用）
  const petPid = readPidFile(PET_PID_FILE);
  if (petPid && isPidAlive(petPid)) {
    try {
      process.kill(petPid);
      console.log(`→ Stopped pet-desktop (pid ${petPid})`);
    } catch (e) {
      console.warn(`Failed to stop pet-desktop pid ${petPid}: ${e.message}`);
    }
  }
  removePidFile(PET_PID_FILE);

  // 2. 停止 terminal-server
  await stopServer();

  // 等待进程清理 + 端口释放
  await new Promise(r => setTimeout(r, 500));

  // 3. 重启 terminal-server
  try {
    await ensureServer();
  } catch (e) {
    console.error(`❌ Failed to start terminal-server: ${e.message}`);
    process.exit(1);
  }

  // 4. 查找 pet-desktop 目录
  const possiblePaths = [
    path.join(__dirname, '../../../../pets/pet-desktop'),
    path.join(process.cwd(), 'pets/pet-desktop'),
    path.join(os.homedir(), '.agent-pet/pets/pet-desktop')
  ];

  let desktopPath = null;
  for (const p of possiblePaths) {
    if (require('fs').existsSync(p)) {
      desktopPath = p;
      break;
    }
  }

  if (!desktopPath) {
    console.error('❌ pet-desktop not found');
    return;
  }

  const nodeModulesPath = path.join(desktopPath, 'node_modules');
  const electronPath = path.join(nodeModulesPath, '.bin/electron');
  const mainPath = path.join(desktopPath, 'src/main.js');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log('🚀 Starting desktop pet...');

  let child;
  if (process.platform === 'win32') {
    // Windows: 直接启动 electron.exe（与 start.js 保持一致，不再走 PowerShell）
    const electronExe = path.join(nodeModulesPath, 'electron/dist/electron.exe');
    child = spawn(electronExe, [mainPath], {
      cwd: desktopPath,
      env,
      detached: true,
      stdio: 'ignore'
    });
  } else {
    child = spawn(electronPath, [mainPath], {
      detached: true,
      env,
      cwd: desktopPath,
      stdio: 'ignore'
    });
  }
  child.unref();
  writePidFile(PET_PID_FILE, child.pid);

  console.log(`✅ Desktop pet restarted (pid ${child.pid})`);

  // 等待一小段时间让进程启动
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

module.exports = { restart };
