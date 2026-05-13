# test-card-no-prompt-degrade

## 测试目标
后端返回的 session 缺失 `firstPrompt` 字段（undefined / null / 空字符串 / 完全不返回）时，UI 退化为占位文案，不显示 "undefined" 也不抛错。

## 前置条件
- 环境：桌宠应用已启动，DevTools 打开 Console 与 Network
- 数据：mock 四种缺失情况的 session

## 测试步骤
1. DevTools Console 注入：
   ```js
   TaskList.render([
     { id: 'u', cwd: 'D:/p', type: 'manual', firstPrompt: undefined, startedAt: Date.now() },
     { id: 'n', cwd: 'D:/p', type: 'manual', firstPrompt: null,      startedAt: Date.now() },
     { id: 'e', cwd: 'D:/p', type: 'manual', firstPrompt: '',        startedAt: Date.now() },
     { id: 'x', cwd: 'D:/p', type: 'manual',                         startedAt: Date.now() }
   ]);
   ```
2. 逐张查看卡片副标题显示。
3. 查看 DevTools Console 是否出现任何 error / warning。

## 预期结果
- 4 张卡片副标题均显示斜体灰色 "等待首条对话…"
- 任何卡片都不显示字符串 "undefined"、"null" 或空白
- Console 无 TypeError、no runtime error、no warning

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 副标题退化策略
- 涉及函数/类名：`TaskList.render`，副标题节点 `.task-subtitle`
