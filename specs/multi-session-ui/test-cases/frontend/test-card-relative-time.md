# test-card-relative-time

## 测试目标
`formatRelativeTime` 对 0s / 30s / 5m / 1h / 1d 五个边界返回正确格式；UI 侧 30s `setInterval` 驱动自动刷新。

## 前置条件
- 环境：桌宠应用已启动，任务面板已打开，DevTools Console 可访问该函数
- 数据：一个 session，`startedAt = Date.now() - 20000`（20 秒前）

## 测试步骤
1. 单元测试函数（DevTools Console 粘贴）：
   ```js
   const now = Date.now();
   [
     ['0s',  now],
     ['30s', now - 30 * 1000],
     ['5m',  now - 5 * 60 * 1000],
     ['1h',  now - 60 * 60 * 1000],
     ['1d',  now - 24 * 60 * 60 * 1000]
   ].forEach(([k, t]) => console.log(k, '=>', formatRelativeTime(t)));
   ```
2. UI 验证：注入一个 `startedAt = Date.now() - 20000` 的 session，记下相对时间显示，等候 30 秒观察数值刷新。

## 预期结果
- 函数输出依次为：`刚刚`、`30s 前`、`5m 前`、`1h 前`、`1d 前`
- UI 卡片相对时间初始显示 "20s 前"（或接近），30 秒内自动刷新，无需手动操作
- 刷新后文本变为 "50s 前" 或向分钟级递进

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 相对时间章节
- 涉及函数/类名：`formatRelativeTime`、`TaskList.render`，定时器 `setInterval(30_000)`
