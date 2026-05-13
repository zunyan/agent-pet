# 同项目多会话区分 — 技术设计

## 1. 总体架构

```
Claude Code Hook (UserPromptSubmit)
        │  HTTP POST /api/hook
        ▼
┌────────────────────────────────────────────┐
│ terminal-server (packages/terminal-server) │
│  - hookTasks Map  ←── 新增 firstPrompt     │
│  - sessions Map   ←── 新增 startedAt       │
│  GET /api/sessions  ──► 合并后返回         │
│  WebSocket hook-update ──► broadcast       │
└────────────────────────────────────────────┘
        │  HTTP + WS
        ▼
┌────────────────────────────────────────────┐
│ pet-desktop main process (main.js)         │
│  refreshPanel() 合并 sessions + hookTasks  │
│  通过 IPC 'sessions-update' / 'tasks-      │
│  update' 透传新字段                        │
└────────────────────────────────────────────┘
        │  IPC
        ▼
┌────────────────────────────────────────────┐
│ pet-desktop renderer (renderer.js)         │
│  TaskList.render() 重写卡片 DOM            │
│  - stripeColorFor(cwd) → 左色条            │
│  - formatRelativeTime(ts) → 右下角时间     │
│  - buildTooltip() → hover 浮层             │
└────────────────────────────────────────────┘
```

## 2. 数据流

1. Claude Code 在用户发送 prompt 时触发 `UserPromptSubmit` hook → POST `/api/hook` 带 `{sessionId, cwd, prompt, ...}`
2. 后端在 [packages/terminal-server/src/index.js#L304-L317](../../packages/terminal-server/src/index.js#L304-L317) 分支：
   - 若 hookTask 不存在：创建并写入 `firstPrompt=prompt.slice(0,80)`、`startedAt=now`
   - 若 hookTask 已存在：不覆盖 `firstPrompt`（本期不再维护 `lastPrompt`）
3. `GET /api/sessions` / `GET /api/tasks` / `broadcastHookUpdate()` 返回体附带新字段
4. 主进程 [pets/pet-desktop/src/main.js#L263-L276](../../pets/pet-desktop/src/main.js#L263-L276) 在 `mapped` 中透传
5. Renderer 在 `TaskList.render()`（[pets/pet-desktop/src/renderer.js#L335-L441](../../pets/pet-desktop/src/renderer.js#L335-L441)）据此构造新卡片 DOM

## 3. 后端变更点

### 3.1 `packages/terminal-server/src/index.js`

| 位置 | 函数 / 代码块 | 变更说明 |
|---|---|---|
| L19 | `sessions` Map 结构注释 | 追加字段：`startedAt`（创建时写入）、`firstPrompt` |
| L23 | `hookTasks` Map 结构注释 | 追加字段：`firstPrompt` |
| L304-L317 | `UserPromptSubmit` 分支（`data.prompt !== undefined`） | 新建 hookTask 时写入 `firstPrompt`（≤80 字）；已存在时不再更新任何 prompt 字段（严禁覆盖 `firstPrompt`） |
| L620-L629 | `POST /api/sessions` 创建 session 对象 | 追加 `startedAt: new Date().toISOString()`；`firstPrompt: null`（占位，等 hook 回填；禁止用空串） |
| L602-L604 | `GET /api/sessions` | 返回体合并：对每个 session，若 `hookTasks.get(id)` 存在，优先取 hookTask 的 `firstPrompt / startedAt`，缺失才 fallback 到 session 自身 |
| 相关广播 | `broadcastHookUpdate()`（L591-L599） | 广播 payload 自然携带新字段，无需额外代码（仅确认 hookTasks 字段已更新） |

> 本期仅保存 `firstPrompt`（首条 prompt 作为会话任务指纹）。`lastPrompt` 暂不引入，因为方案 A 前端 UI 不消费它；未来若有 UI 需求，需同步引入截断规则（建议 ≤4KB）再启用。

### 3.2 字段规范

| 字段 | 类型 | 约束 | 写入时机 | 覆盖语义 |
|---|---|---|---|---|
| `firstPrompt` | string \| null | `≤ 80` 字符，入库前 `prompt.slice(0, 80)`；无值时显式为 `null`（禁止 undefined / 空串占位） | `UserPromptSubmit` 首次到达时 | 不覆盖；一旦非空值写入，后续 prompt 不再更新 |
| `startedAt` | string (ISO 8601, `new Date().toISOString()`) | 对齐现有 `packages/terminal-server/src/index.js` 里 hook 路径的 `toISOString()` 风格，前端用 `new Date(isoString).getTime()` 解析 | hookTask / session 首次创建时 | 不覆盖 |
| `pid` | number \| null | 复用现有字段 | Manual 会话已有；Auto 会话若 hook payload 无 pid，置 `null` | — |

### 3.3 合并策略

`GET /api/sessions` 返回的每一项按如下优先级组装：

```
out.firstPrompt = hookTask.firstPrompt ?? session.firstPrompt ?? null
out.startedAt   = hookTask.startedAt   ?? session.startedAt   ?? null
out.pid         = session.pid ?? hookTask.pid ?? null
```

`hookTasks` 优先，因为 prompt 源自 hook。`firstPrompt` 字段在返回体中**必须存在**，无值时显式为 `null`（前端对 `null / undefined / ""` 都会退化为占位文案「等待首条对话…」）。

## 4. 前端变更点

### 4.1 `pets/pet-desktop/src/main.js`

| 位置 | 函数 | 变更说明 |
|---|---|---|
| L263-L276 | `refreshPanel()` 中 `sessions.map()` | 透传字段扩充：新增 `firstPrompt / startedAt`；`pid` 已有继续透传 |
| L245-L255 附近 | `tasks-update` 的 `filteredTasks` 投影 | 同样补齐 `firstPrompt / startedAt / pid`（如尚未透传） |

### 4.2 `pets/pet-desktop/src/renderer.js`

| 位置 | 函数 | 变更说明 |
|---|---|---|
| 顶层工具区 | 新增 `stripeColorFor(cwd: string): string` | 见 §5.2 伪码 |
| 顶层工具区 | 新增 `formatRelativeTime(ts: number): string` | 见 §5.3 伪码 |
| 顶层工具区 | 新增 `truncate(text: string, n: number): string` | 简单 slice + `…` |
| 顶层工具区 | 新增 `tooltipSingleton`（模块级单例） | 见 §5.4 |
| L335-L441 | `TaskList.render()` | 按原型重写卡片 DOM：色条 / 项目名+Auto pill / 首条 prompt 行 / 工具摘要行 / 右下角相对时间 / hover 绑定 tooltip |
| 新增方法 | `TaskList.startTickLoop()` | `setInterval` 30s 刷一次相对时间；面板隐藏时清理 |
| 样式 | `index.html` 或内联 | 新增类：`.task-stripe`、`.task-prompt`、`.task-prompt-placeholder`、`.task-time`、`.auto-pill`、`.task-tooltip` |

> **相对时间刷新节奏**：规格以 30s 刷新为准（`setInterval` 间隔 30_000ms），最低满足 requirements AC-4 的"至少 30s 刷新一次"要求。原型 `temp/prototype.html` 使用 10s 仅为演示效果，编码时务必按 30s 实现。

### 4.3 DOM 结构（规范描述，非代码）

```
div.task-item.<status>
├── div.task-stripe           ← 色条，inline-style backgroundColor
├── div.task-content
│   ├── div.task-header
│   │   ├── span.task-project   ← extractProjectName(cwd)
│   │   └── span.auto-pill      ← 仅 type='auto' 时渲染
│   ├── div.task-prompt         ← firstPrompt 前 60 字；空值时加 .task-prompt-placeholder
│   └── div.task-footer
│       ├── span.task-tool-summary   ← 现 lastToolSummary，含 padding-right 避开时间
│       └── span.task-time           ← formatRelativeTime(startedAt)
└── button.close-btn           ← 现有
```

### 4.4 关键样式规格（与原型对齐）

以下像素级 / 色值级决定固化为规格，编码实现时必须按此执行，不得自由发挥：

| 元素/类名 | 属性 | 值 |
| --- | --- | --- |
| `.task-stripe`（左侧色条） | width | 4px |
| `.task-stripe` | position | absolute; left: 0; top: 0; bottom: 0 |
| `.task-stripe` | background | `hsl(H, 70%, 55%)` — H 由 `hash(cwd) % 6 * 60` 得到 |
| `.task-summary`（lastToolSummary 行） | padding-right | 56px（给右下角相对时间让位） |
| `.task-summary` | text-overflow | ellipsis |
| `.task-summary` | white-space | nowrap |
| `.task-summary` | overflow | hidden |
| `.task-time`（右下角相对时间） | position | absolute; right: 8px; bottom: 4px |
| `.task-time` | font-size | 10px |
| `.task-time` | color | `var(--text-secondary)` |
| Auto 标签（`.task-badge.auto` 或 `.auto-pill`） | color | `#666` (`var(--text-secondary)`) |
| Auto 标签 | background | `rgba(0, 0, 0, 0.06)` |
| Auto 标签 | border | `1px solid rgba(0, 0, 0, 0.12)` |
| Auto 标签 | padding | 1px 6px |
| Auto 标签 | border-radius | 3px |
| Auto 标签 | font-size | 10px |
| Auto 标签 | font-weight | 600 |
| Prompt 副标题 | font-size | 12px |
| Prompt 副标题 | color | `var(--text-primary)` |
| Prompt 副标题（占位态） | font-style | italic |
| Prompt 副标题（占位态） | color | `var(--text-secondary)` |

## 5. 算法 / 函数签名

### 5.1 首条 prompt 截断

```
function clampFirstPrompt(raw: string): string
  if typeof raw !== 'string' return ''
  return raw.slice(0, 80)
```

卡片展示时再 slice 到 60 字（后端存 80 字保留 tooltip 用的余量）。

### 5.2 色条 hash 伪码

```
function stripeColorFor(cwd: string): string
  if !cwd return 'hsl(0, 0%, 70%)'
  // 累加字符码：稳定、零依赖
  h = 0
  for c in cwd: h = (h * 31 + c.charCodeAt(0)) >>> 0
  idx = h % 6              // 0..5
  hue = idx * 60           // 0/60/120/180/240/300
  return `hsl(${hue}, 70%, 55%)`
```

### 5.3 相对时间伪码

```
function formatRelativeTime(ts: number|null): string
  if !ts return ''
  delta = Math.max(0, Date.now() - ts) / 1000    // 秒
  if delta < 10 return '刚刚'
  if delta < 60 return `${Math.floor(delta)}s 前`
  if delta < 3600 return `${Math.floor(delta/60)}m 前`
  if delta < 86400 return `${Math.floor(delta/3600)}h 前`
  return `${Math.floor(delta/86400)}d 前`
```

### 5.4 Tooltip 单例

- 模块加载时在 `document.body` 追加一个 `div.task-tooltip`，`display: none`；
- 卡片 `mouseenter`：填充 cwd / firstPrompt / pid / 绝对时间，定位到卡片右下方外部 8px，`display: block`；
- 卡片 `mouseleave`：`display: none`；
- 面板重新 `render()` 时保证 tooltip 单例不被重建。

## 6. 兼容性与回滚

| 场景 | 表现 |
|---|---|
| 后端未升级、前端已升级 | 接口无新字段 → 第 2 行显示占位 "等待首条对话…"；相对时间空字符串；色条仍生效（cwd 已有）；整体降级但不报错 |
| 前端未升级、后端已升级 | 渲染逻辑未读取新字段，卡片外观不变；无 regression |
| Hook 从未触发过（纯 Manual，用户未发 prompt） | `firstPrompt=null` → 占位文案；功能正常 |
| `startedAt` 缺失 | `formatRelativeTime(null) === ''`，右下角空白，不渲染错乱文本 |
| prompt 含换行或 HTML | 渲染使用 `textContent` 赋值（不走 `innerHTML`），天然转义 |

**回滚**：两端分别回退相关 commit 即可；新字段不落盘，无数据迁移问题。

### 6.1 持久化与重启语义

本期无持久化，`hookTasks` 与 `sessions` 仅存在于 terminal-server 内存中；进程重启后全部清零。`startedAt` 仅在 `POST /api/sessions`（Manual）或 hookTask 首次创建（Auto）时写入一次，不存在"重连恢复"场景。

### 6.2 已知风险（推迟处理）

相对时间 30s 定时刷新 + refreshPanel 推送可能造成卡片 DOM 重建，若实测 tooltip 出现闪烁，再在实施阶段引入局部 DOM diff 替代 `innerHTML` 全量清空。默认先采用最简单的全量重渲染实现。

## 7. 预留测试关注点（供测试工程师写用例）

1. **hook 字段完整性**：POST `/api/hook` 带 prompt → `GET /api/sessions` 返回项应包含 `firstPrompt / startedAt`
2. **firstPrompt 不覆盖**：同一 sessionId 连续两次 `UserPromptSubmit`，`firstPrompt` 保持第一次的值
3. **firstPrompt 80 字截断**：发送 200 字 prompt，后端存储字段长度 ≤ 80
4. **合并优先级**：hookTask 和 session 同时存在时，`GET /api/sessions` 返回的 `firstPrompt` 取自 hookTask
5. **Manual 会话创建**：POST `/api/sessions` 后返回项 `startedAt` 为当前时间戳，`pid` 非空
6. **色条稳定性**：同一 cwd 多次调用 `stripeColorFor()` 返回完全相同色值
7. **色条区分性**：6 个明显不同的 cwd 字符串应能映射到至少 3 种不同色相（抽样不强制全命中 6 色）
8. **相对时间边界**：ts = now-9s 显示 "刚刚"；now-61s 显示 "1m 前"；now-3601s 显示 "1h 前"
9. **Tooltip 单例**：快速 hover 多张卡片，DOM 中 `.task-tooltip` 元素始终只有 1 个
10. **空值降级**：mock 接口返回无新字段时，卡片第 2 行显示占位、右下角不出现 `NaN 前`
11. **Auto pill 渲染条件**：type='manual' 的卡片 DOM 中不应出现 `.auto-pill` 节点

## 8. 变更记录

### 架构决策历史

- 2026-05-12 — 本期只存 `firstPrompt`，不引入 `lastPrompt`（方案 A 前端 UI 不消费）
- 2026-05-12 — 无持久化，sessions 重启清零，`startedAt` 仅创建时写入一次，不考虑 reconnect 场景
- 2026-05-12 — tooltip 闪烁风险推迟到实施阶段，默认采用 `innerHTML` 全量重渲染

### 开发变更记录

| 日期 | 提交人 | 变更点 | 说明 |
|---|---|---|---|
| | | | |
