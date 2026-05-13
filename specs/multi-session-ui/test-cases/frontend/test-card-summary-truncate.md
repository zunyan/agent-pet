# test-card-summary-truncate

## 测试目标
第三行 `lastToolSummary` 过长时以省略号截断，且不与右下角相对时间重合。

## 前置条件
- 环境：桌宠应用已启动，任务面板已打开
- 数据：一个 session，`lastToolSummary` 长度超过 80 字

## 测试步骤
1. DevTools Console 注入：
   ```js
   TaskList.render([{
     id: 'long',
     cwd: 'D:/p',
     type: 'manual',
     firstPrompt: '测试截断',
     lastToolSummary: '这是一段非常非常长的工具调用摘要'.repeat(8),
     startedAt: Date.now()
   }]);
   ```
2. 观察卡片第三行摘要文本尾部显示。
3. DevTools Elements 定位 `.task-summary` 节点，检查计算后的 CSS：`padding-right`、`text-overflow`、`white-space`、`overflow`。
4. 对比右下角相对时间区域是否被遮挡。

## 预期结果
- 摘要文本以 `…` 结尾（单行截断）
- `.task-summary` 样式包含 `padding-right: 56px`、`text-overflow: ellipsis`、`white-space: nowrap`、`overflow: hidden`
- 右下角相对时间完整可见，不被摘要覆盖

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 摘要行章节
- 涉及函数/类名：`TaskList.render`，节点 `.task-summary`、`.task-time`
