# test-card-firstprompt-display

## 测试目标
卡片副标题展示 `firstPrompt` 前 60 字；无 prompt 时显示斜体灰色占位文案 "等待首条对话…"。

## 前置条件
- 环境：桌宠应用已启动（`pnpm --filter pet-desktop dev`），任务面板已打开
- 数据：后端返回两个 session，字段如下
  - session A：`firstPrompt = "帮我修复登录 bug"`
  - session B：`firstPrompt = null`

## 测试步骤
1. 在 DevTools Console 注入 mock 响应或直接调用 `TaskList.render([...])`：
   ```js
   TaskList.render([
     { id: 'a', cwd: 'D:/proj/a', type: 'manual', firstPrompt: '帮我修复登录 bug', startedAt: Date.now() },
     { id: 'b', cwd: 'D:/proj/b', type: 'manual', firstPrompt: null, startedAt: Date.now() }
   ]);
   ```
2. 观察两张卡片的副标题区域。
3. 若存在超过 60 字的 prompt，追加一个长 prompt 卡片验证截断。

## 预期结果
- session A 副标题显示完整文本 "帮我修复登录 bug"，若超过 60 字则尾部带 "…"
- session B 副标题显示斜体灰色 "等待首条对话…"，非纯文字样式
- DevTools Console 无报错

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 副标题渲染章节
- 涉及函数/类名：`TaskList.render`，副标题节点 `.task-subtitle`
