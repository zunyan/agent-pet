# 同项目多会话区分 — 后端测试用例

## 环境说明

- 被测服务：`packages/terminal-server/src/index.js`（Express/Node，默认端口 `3456`）
- 基础 URL：`http://localhost:3456`
- 关键端点：`POST /api/sessions`、`GET /api/sessions`、`POST /api/hook`
- 关键 hook 事件：`UserPromptSubmit`
- 关键内存结构：`sessions` Map（PTY 会话）、`hookTasks` Map（hook 上报）

## 用例清单

| 编号 | 文件名 | 一句话目标 | 建议执行顺序 |
|---|---|---|---|
| 1 | [test-hook-firstprompt-write.md](test-hook-firstprompt-write.md) | UserPromptSubmit 首次触发写入 `firstPrompt` 并截断到 80 字 | 1 |
| 2 | [test-hook-firstprompt-no-overwrite.md](test-hook-firstprompt-no-overwrite.md) | 同 sessionId 二次触发不覆盖 `firstPrompt` | 2 |
| 3 | [test-hook-firstprompt-empty.md](test-hook-firstprompt-empty.md) | prompt 缺失/空串时不抛错，`firstPrompt` 保持 null | 3 |
| 4 | [test-session-startedat.md](test-session-startedat.md) | `POST /api/sessions` 写入合法 ISO 字符串 `startedAt` | 4 |
| 5 | [test-api-sessions-returns-new-fields.md](test-api-sessions-returns-new-fields.md) | `GET /api/sessions` 每项显式包含 `firstPrompt / startedAt / pid` | 5 |
| 6 | [test-merge-session-hooktask.md](test-merge-session-hooktask.md) | sessions 与 hookTasks 同 key 时，`firstPrompt` 取 hookTasks 版本 | 6 |

## 执行建议

- 顺序 1 → 2 → 3 → 4 → 5 → 6；每个用例使用独立 sessionId，彼此无状态污染
- 每轮执行前确认服务端无残留会话：可通过 `GET /api/sessions` 观测，必要时 `DELETE /api/sessions/:id` 清理
- 所有断言以 `GET /api/sessions` 的合并返回体为准；必要时同时观察 terminal-server 控制台日志确认无未捕获异常

## 关联设计文档

- `specs/multi-session-ui/requirements.md`
- `specs/multi-session-ui/technical-design.md`（重点 §3.1 / §3.2 / §3.3 / §5.1 / §6）
