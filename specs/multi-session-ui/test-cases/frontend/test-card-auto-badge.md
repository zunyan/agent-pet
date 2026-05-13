# test-card-auto-badge

## 测试目标
`type = 'auto'` 的卡片右上角显示灰色 "Auto" pill；`type = 'manual'` 右上角无徽标（只有 hover 时出现的关闭按钮）。

## 前置条件
- 环境：桌宠应用已启动，任务面板已打开
- 数据：两个 session，type 分别为 auto 与 manual

## 测试步骤
1. DevTools Console 注入：
   ```js
   TaskList.render([
     { id: 'a', cwd: 'D:/p', type: 'auto',   firstPrompt: '自动任务 A', startedAt: Date.now() },
     { id: 'm', cwd: 'D:/p', type: 'manual', firstPrompt: '手动任务 M', startedAt: Date.now() }
   ]);
   ```
2. 分别观察两张卡片右上角区域。
3. 鼠标悬停两张卡片，确认 manual 卡片关闭按钮正常显现。

## 预期结果
- auto 卡片右上角有文字 "Auto" 的小 pill，文字色 `#666`，背景 `rgba(0, 0, 0, 0.06)`，尺寸小圆角
- manual 卡片右上角无任何徽标；hover 时仅出现关闭按钮，不出现 Auto 标签
- pill 不会遮挡副标题或相对时间

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 类型徽标章节
- 涉及函数/类名：`TaskList.render`，节点 `.task-badge-auto`
