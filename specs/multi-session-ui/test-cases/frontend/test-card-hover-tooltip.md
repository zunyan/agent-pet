# test-card-hover-tooltip

## 测试目标
鼠标悬停卡片时 tooltip 浮层显示完整 cwd、完整 firstPrompt、PID、启动绝对时间；移出时立即隐藏。

## 前置条件
- 环境：桌宠应用已启动，任务面板已打开
- 数据：一个字段完整的 session

## 测试步骤
1. DevTools Console 注入：
   ```js
   TaskList.render([{
     id: 'full',
     cwd: 'D:/projects/agent-pet/very/deep/path',
     type: 'auto',
     pid: 12345,
     firstPrompt: '帮我实现一个非常复杂的多会话管理需求，包含 tooltip、色条、相对时间等',
     startedAt: new Date('2026-05-12T09:30:00').getTime()
   }]);
   ```
2. 鼠标悬停该卡片，观察 tooltip 浮层出现位置与内容。
3. 鼠标移开卡片，观察 tooltip 是否立即消失。

## 预期结果
- tooltip 出现在卡片右下方外部约 8px 处
- 浮层内容包含 4 项：完整 cwd、完整 firstPrompt（未截断）、PID、启动绝对时间（如 `2026-05-12 09:30:00`）
- 鼠标移开卡片，tooltip 立即隐藏
- 内容均未被 `…` 截断，文字可完整阅读

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md hover tooltip 章节
- 涉及函数/类名：`TaskList.render`、tooltip 浮层节点（`.task-tooltip` 等）
