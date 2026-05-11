const path = require('path');
const { stopServer, readPidFile, removePidFile, isPidAlive, PID_DIR } = require('../utils/server-control');

const PET_PID_FILE = path.join(PID_DIR, 'pet-desktop.pid');

async function stop() {
  console.log('🛑 Stopping agent-pet...');

  // 1. 通过 PID 精确停止 pet-desktop（避免误杀其他 Electron 应用）
  const petPid = readPidFile(PET_PID_FILE);
  if (petPid && isPidAlive(petPid)) {
    try {
      process.kill(petPid);
      console.log(`→ Stopped pet-desktop (pid ${petPid})`);
    } catch (e) {
      console.warn(`Failed to stop pet-desktop pid ${petPid}: ${e.message}`);
    }
  } else if (petPid) {
    console.log(`pet-desktop pid ${petPid} already stopped`);
  } else {
    console.log('ℹ️  pet-desktop pid file not found (was it started by agent-pet?)');
  }
  removePidFile(PET_PID_FILE);

  // 2. 停止 terminal-server
  await stopServer();

  console.log('✅ agent-pet stopped');
  process.exit(0);
}

module.exports = { stop };
