# 前端测试用例索引（同项目多会话区分）

本目录覆盖桌宠任务卡片本期改动点：副标题 firstPrompt、左侧 4px 色条、Auto 徽标、相对时间、摘要截断、hover tooltip、字段缺失退化。

| 编号 | 文件名 | 一句话目标 | 建议执行顺序 |
|------|--------|-----------|-------------|
| FE-01 | test-card-firstprompt-display.md | 副标题按 firstPrompt 截 60 字，无 prompt 显示占位 | 1 |
| FE-02 | test-card-no-prompt-degrade.md | firstPrompt 四种缺失场景均退化占位且无报错 | 2 |
| FE-03 | test-card-stripe-color.md | 左侧色条基于 hash(cwd)，同 cwd 同色 | 3 |
| FE-04 | test-card-auto-badge.md | auto 显示灰色 pill，manual 无徽标 | 4 |
| FE-05 | test-card-summary-truncate.md | 摘要单行省略号截断，不压右下角时间 | 5 |
| FE-06 | test-card-relative-time.md | formatRelativeTime 边界正确，30s 自动刷新 | 6 |
| FE-07 | test-card-hover-tooltip.md | hover 弹出 tooltip 含 cwd/prompt/PID/绝对时间 | 7 |

## 执行约定
- 先静态渲染类（FE-01 ~ FE-05）→ 再时序/交互类（FE-06 ~ FE-07）
- 每个用例均可独立执行，依赖同一份 mock 注入入口
- 测试结果记入 `specs/multi-session-ui/test-results/frontend/`
