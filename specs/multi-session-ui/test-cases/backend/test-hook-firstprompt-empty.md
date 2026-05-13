# test-hook-firstprompt-empty

## 测试目标

`data.prompt` 缺失或为空字符串时，`firstPrompt` 保持 null/undefined，服务不应抛错。

## 前置条件

- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：`hookTasks` 中不存在 `sessionId=TEST-FP-003` 和 `TEST-FP-003B`

## 测试步骤

1. 先用 `POST /api/sessions` 创建 `TEST-FP-003`（或通过 hook 创建占位）。发一个 body 无 `prompt` 字段的 hook：

   ```bash
   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d '{"hook_event_name":"UserPromptSubmit","session_id":"TEST-FP-003","cwd":"/tmp/c","data":{}}'
   ```

2. 对另一 sessionId `TEST-FP-003B` 重复一次，`data.prompt` 显式为 `""`：

   ```bash
   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d '{"hook_event_name":"UserPromptSubmit","session_id":"TEST-FP-003B","cwd":"/tmp/c2","data":{"prompt":""}}'
   ```

3. `curl -s http://localhost:3456/api/sessions`，检查两项的 `firstPrompt`
4. 观察 terminal-server 控制台/日志输出

## 预期结果

- 两次 `POST /api/hook` 均返回 200 响应
- `GET /api/sessions` 对应项中 `firstPrompt` 为 `null` 或缺失（未被写成字符串 `"undefined"`）
- terminal-server 日志中无 uncaught exception / 500 错

## 技术要点

- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.1 L304-L317、§5.1 `clampFirstPrompt` 对非字符串/空值的兜底
- 涉及字段：`hookTasks[sessionId].firstPrompt`
