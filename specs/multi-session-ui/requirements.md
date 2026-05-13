# 同项目多会话区分 — 需求文档

## 1. 背景

agent-pet 桌宠在窗口右侧「任务面板」中同时展示来自 `terminal-server` 的两类会话：

- **Auto**（type='auto'）：由 Claude Code hooks 自动上报（VSCode / CLI 直连）
- **Manual**（type='manual'）：桌宠内置终端主动拉起

当用户在同一个项目目录（同 `cwd`）下并行开启多个 Claude Code 会话时，卡片呈现的信息几乎完全一致：

- 项目末段名相同（`extractProjectName(cwd)` 对同 cwd 输出相同文本）
- A/M 徽标只区分来源，不区分"哪一个会话"
- `lastToolSummary` 在会话刚启动时尚未产生，长时间为空或只有 `Processing...`

结果：用户无法快速定位"我刚才问了 X 的那个会话"，需要逐个悬停或点开才能辨认，严重影响多会话并行场景的使用体验。

## 2. 用户故事

- **US-1**：作为用户，我同时在 `agent-pet` 项目下开了 3 个 Claude 会话分别处理"改 UI / 跑测试 / 调 hook 逻辑"，我希望在任务面板里一眼分辨哪张卡片对应哪个会话，不用逐个悬停或打开终端。
- **US-2**：作为用户，我希望同一项目的卡片外观上有视觉关联（同色），但彼此之间又能通过内容区分，不必强行引入序号或手动命名。
- **US-3**：作为用户，悬停卡片时我希望能看到完整路径、完整首句 prompt、PID 和准确启动时间，用于在同项目多会话之间做最终确认。

## 3. 方案范围

采用「**方案 A：自动指纹**」，零用户交互，全部信息自动派生。

### 3.1 功能范围（本期包含）

1. 卡片新增「首条 prompt 前 60 字」行（来源：Claude Code `UserPromptSubmit` hook 上报的 `data.prompt`）
2. 卡片新增「相对启动时间」（刚刚 / 30s 前 / 2m 前 / 1h 前），基于已有 `startedAt`
3. 卡片新增「项目色条」：左侧 4px 竖条，色相由 `hash(cwd) % 6` 映射到 HSL 60° 步进，同项目同色
4. Auto 徽标从红色 A 圆点改为灰色 `Auto` pill；Manual 会话右上角完全不显示徽标
5. 卡片 hover tooltip 浮层：完整 cwd、完整首句 prompt、PID、绝对启动时间
6. 后端在 `UserPromptSubmit` 分支保存 `firstPrompt`（首次写入后不覆盖），入库前截断到 80 字
7. `GET /api/sessions`（以及 hook-update 广播）返回体补齐 `firstPrompt / startedAt / pid` 字段
8. 主进程 `sessions-update` / `tasks-update` 透传上述新字段至渲染进程

### 3.2 不含（明确排除）

- ❌ 用户自定义会话名 / 重命名 / 置顶
- ❌ 本地 JSON 持久化（重启即清空，沿用当前内存 Map 模型）
- ❌ 右键菜单
- ❌ sessionId 短 ID 展示（`#xxxx` 形式）
- ❌ 同项目内序号（同色已经足够视觉聚类）

## 4. 原型

UI 细节与交互以原型为准，本文档不重复描述像素级规范：

- [原型文件](temp/prototype.html)（v3 版，6 张卡片覆盖典型场景）

## 5. 验收标准

以下 6 条验收场景对齐 `temp/prototype.html` 中的 6 张示例卡片；每条均需在真实 agent-pet 运行态中手工复现通过。

### AC-1 首条 prompt 正常展示
在 agent-pet 项目中启动一个 Claude 会话，输入首条 prompt "帮我改一下任务面板的样式，让多会话能区分"。面板卡片第 2 行显示该 prompt 的前 60 字，超出部分以 `…` 截断；第 3 行保留工具摘要。

### AC-2 首条 prompt 为空时显示占位
会话刚创建、hook 尚未上报 `UserPromptSubmit` 时，卡片第 2 行显示灰色斜体占位 "等待首条对话…"，不能为空白或显示 `undefined`。

### AC-3 同项目同色 / 异项目异色
在 `agent-pet` 目录开 2 个会话、在另一任意项目目录开 1 个会话：前两张卡片左侧色条颜色完全一致，第三张与前两张明显不同；任意时刻刷新面板，颜色稳定不抖动。

### AC-4 相对时间动态刷新
会话启动后 10 秒内显示 "刚刚"；1 分钟后显示 "30s 前" / "1m 前" 区间；1 小时后显示 "xx m 前" 或 "1h 前"；面板保持打开不需手动刷新，文案按规则自动推进（最低刷新频率每 30 秒一次）。

### AC-5 Auto / Manual 徽标样式
Auto 会话卡片右上角展示灰色 `Auto` pill（文字 `#666`，背景 `rgba(0,0,0,0.06)`）；Manual 会话右上角完全空白（仅保留 hover 显现的 × 按钮）；原先的红色 A 圆点、M 徽标不再出现。

### AC-6 Hover tooltip 完整信息
鼠标悬停任意卡片 300ms 后弹出 tooltip，包含：完整 cwd、完整首句 prompt（不截断）、PID、绝对启动时间（`YYYY-MM-DD HH:mm:ss`）；tooltip 位于卡片右下角附近且不遮挡卡片主体；鼠标移出 tooltip 消失。
