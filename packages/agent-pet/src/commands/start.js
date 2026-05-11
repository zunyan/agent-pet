const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const { ensureServer, writePidFile, PID_DIR } = require('../utils/server-control');

const PET_PID_FILE = path.join(PID_DIR, 'pet-desktop.pid');

async function start() {
  console.log('🐾 Starting agent-pet...');

  // 先确保 terminal-server 已运行
  try {
    await ensureServer();
  } catch (e) {
    console.error(`❌ Failed to start terminal-server: ${e.message}`);
    process.exit(1);
  }

  // 查找 pet-desktop 目录
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
    console.log('Please ensure pet-desktop is installed');
    return;
  }

  // 检查 node_modules
  const nodeModulesPath = path.join(desktopPath, 'node_modules');
  if (!require('fs').existsSync(nodeModulesPath)) {
    console.log('📦 Installing dependencies...');
    const { execSync } = require('child_process');
    try {
      execSync('npm install', { cwd: desktopPath, stdio: 'inherit' });
    } catch (e) {
      console.error('❌ Failed to install dependencies');
      return;
    }
  }

  // 启动 Electron
  console.log('🚀 Launching desktop pet...');

  const electronPath = path.join(nodeModulesPath, '.bin/electron');
  const mainPath = path.join(desktopPath, 'src/main.js');

  // 移除 ELECTRON_RUN_AS_NODE 环境变量
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  let child;
  if (process.platform === 'win32') {
    // Windows: 直接启动 electron
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

  console.log(`✅ Desktop pet started in background (pid ${child.pid})`);

  // 等待一小段时间让进程启动
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

module.exports = { start };
