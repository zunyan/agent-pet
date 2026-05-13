# test-merge-session-hooktask

## 测试目标

同一 sessionId 同时存在于 `sessions` Map（PTY）和 `hookTasks` Map（hook）时，`GET /api/sessions` 合并后的 `firstPrompt` 必须取自 hookTasks 版本（hookTask 优先）。

## 前置条件

- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：准备一个唯一 sessionId `TEST-MERGE-001`（或用 `POST /api/sessions` 拿到真实 id）

## 测试步骤

1. 用 REST 创建一个 PTY 会话（进入 `sessions` Map），记下返回的 `id`：

   ```bash
   ID=$(curl -s -X POST http://localhost:3456/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/projects/foo"}' | jq -r .id)
   ```

2. 用同一个 `$ID` 触发 UserPromptSubmit，让 hookTasks 也有同 key 条目：

   ```bash
   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$ID\",\"cwd\":\"D:/projects/foo\",\"data\":{\"prompt\":\"hook-side prompt\"}}"
   ```

3. `curl -s http://localhost:3456/api/sessions`，定位到 `id === $ID` 项

## 预期结果

- 返回项 `firstPrompt === "hook-side prompt"`，非空（类型为 string）
- 即使 `sessions[id]` 自身也存在 `firstPrompt`（如实现中 POST 写了占位 null），合并结果仍以 hookTasks 为准
- 返回项 `startedAt` 为 ISO 8601 字符串（`new Date().toISOString()` 产物），取 hookTask 或 session 任一存在值即可
- 不会因同 key 存在两份数据而重复出现两项

## 技术要点

- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.3 合并策略 `out.firstPrompt = hookTask.firstPrompt ?? session.firstPrompt ?? null`
- 涉及字段：`sessions[id].firstPrompt` / `hookTasks[id].firstPrompt`，及 `GET /api/sessions` 的合并产物
