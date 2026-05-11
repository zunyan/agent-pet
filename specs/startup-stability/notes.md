# 启动稳定性与跨机器兼容性修复 — 变更笔记

**分支**: `fix/startup-stability`
**基础分支**: `main`
**涉及包**: `terminal-server`、`pet-desktop`、`agent-pet` CLI

本笔记按 commit 拆分记录变更摘要，详细 review 请直接看 PR diff。

---

## Commit 1: fix(terminal-server): 动态定位 claude.cmd 替代硬编码路径

### 问题
`packages/terminal-server/src/index.js:61` 硬编码了开发者本机的 npm 全局路径：
```js
pty.spawn('C:\\Users\\kezun\\AppData\\Roaming\\npm\\claude.cmd', ...)
```
其他用户/机器跑会 ENOENT 报错。非 Windows 分支正确依赖 PATH，问题仅在 Windows。

### 修复
- 新增 `resolveClaudeBin()` 辅助函数，按优先级解析：
  1. `AGENT_PET_CLAUDE_BIN` 环境变量（手动覆盖）
  2. 非 Windows：`'claude'`（沿用 PATH）
  3. Windows：`where claude.cmd`（取首条结果）
  4. Windows 兜底：`%APPDATA%\npm\claude.cmd`、`%LOCALAPPDATA%\npm\claude.cmd`
  5. 全部失败 → throw 带修复指引的 Error
- 模块级缓存 `_cachedClaudeBin`，进程生命周期内只解析一次
- `spawnPty` 简化：Windows / 非 Windows 共用 spawn 路径，仅 `useConpty` 标志按平台差异化

### 影响
- 行为不变：非 Windows 完全等价（`'claude'`）
- 改善：Windows 用户首次安装无需改源码即可启动
- 文件：`packages/terminal-server/src/index.js` 一个文件，+71/-19

---

## Commit 2: fix(pet-desktop): 把空 catch 替换为节流诊断日志

### 问题
`pets/pet-desktop/src/main.js` 有两处 `catch (e) {}` + 一处 `.catch(() => {})`，全部空吞错误：
- 用户排查"server 没启动"等问题时，主进程 console 完全无输出
- 实际触发频率：每秒两次（refreshAll 1s 轮询）

### 修复
- 新增模块级 `logConnError(key, err)` 工具，特性：
  - 自动识别 `ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET` 等连接错误
  - 连接错误 30s 节流（同 key 30s 内只打印一次），避免每秒刷屏
  - 其他错误每次都打（如 JSON 解析失败、HTTP 5xx）
  - Map 内部 key 数量恒为 3，无内存增长
- 替换三处空错误处理：`hooks fetch failed` / `sessions fetch failed` / `hook delete failed`

### 影响
- server 未启动时，每 30s 主进程会打印一次警告，方便定位
- server 健康时无变化
- 文件：`pets/pet-desktop/src/main.js` 一个文件，+19/-3

---

## Commit 3: feat(agent-pet): start/stop 同步管理 terminal-server + 修复误杀其他 Electron 应用

### 问题 #1：start 不启动 server
`agent-pet start` 仅 spawn pet-desktop，不启 `packages/terminal-server`。后果：
- Claude Code 的 hook 报 `UserPromptSubmit error`（因为 hook 直接 POST 到 localhost:3456）
- pet-desktop 拿不到任务数据（fetch 全部失败）
- 用户必须手动跑两次 `npm start`

### 问题 #2：stop 误杀其他 Electron 应用
`agent-pet stop` 用 `taskkill /F /IM electron.exe`（Windows）或 `pkill -f electron`（POSIX）。
**所有正在运行的 Electron 应用（VSCode / Discord / Slack / Cursor / ...）会被一并杀掉**。

### 修复
1. **新增 `packages/agent-pet/src/utils/server-control.js`**（约 170 行），导出：
   - `ensureServer()`：端口探测 → `/health` 验证 → 启动新实例 / 复用现有 / 友好报错
   - `stopServer()`：按 `~/.agent-pet/terminal-server.pid` 精确杀进程
   - `probePort` / `probeHealth` / `waitForHealth` 等工具
   - PID 文件统一存放 `~/.agent-pet/`
   - 端口被非 terminal-server 进程占用时**不主动杀**，给修复指引
   - 端口已被 terminal-server 占用但无 PID 文件（用户手动启的）时**复用不接管**

2. **`start.js`**：主流程顶部 `await ensureServer()`；spawn pet-desktop 后写 `pet-desktop.pid`

3. **`stop.js`**：完全重写
   - 按 PID 杀 pet-desktop（不再误杀其他 Electron）
   - 调 `stopServer()` 停 terminal-server
   - 清理 PID 文件

4. **`restart.js`**：统一改造为"按 PID 停 + ensureServer + spawn"，与 start.js 路径一致；删除原 PowerShell `Start-Process -WindowStyle Hidden` 分支

### 影响
- ✅ `agent-pet start` 一条命令搞定（不再需要手动启 server）
- ✅ `agent-pet stop` 不再误杀其他 Electron 应用
- ✅ 多次 start 自动复用，不再 EADDRINUSE
- ✅ 用户已手动启 server 时被尊重（复用 + stop 时不接管）
- 文件：`packages/agent-pet/src/commands/{start,stop,restart}.js` + 新建 `utils/server-control.js`，+254/-79

---

## 跨平台兼容性

- `process.kill(pid)` 在 Windows 由 libuv 映射为 `TerminateProcess`（硬终止），符合 Electron 主进程退出预期
- `process.kill(pid, 0)` 跨平台一致地用作存活探测
- `where` / `execSync` 仅 Windows 路径使用，POSIX 走 PATH 继承
- 未引入新 npm 依赖，纯 Node 内置模块

## 自测

- 所有改动文件 `node --check` 通过
- 三个修复点文件零重叠，可独立 review/revert
- 端口冲突场景（probePort + probeHealth 双重判定）已通过单元逻辑确认
- 用户实测：start/stop 仍需在用户机器手动验收（Auto mode 限制）

## 后续 PR 候选（不在本 PR 范围）

- terminal-server `server.listen` 加 `error` 事件处理，遇 EADDRINUSE 友好退出
- `setting.js:802` 也用 3456 端口，与 terminal-server 冲突
- `packages/terminal-server/src/index.js` REST 路径 `POST /api/sessions` 与 WebSocket `createSession` 大量逻辑重复，可抽 `registerSession` 辅助
