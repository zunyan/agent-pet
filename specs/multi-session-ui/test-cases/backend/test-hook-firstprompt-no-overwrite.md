# test-hook-firstprompt-no-overwrite

## 测试目标

同一 sessionId 第 2 次及以后触发 UserPromptSubmit 时，`firstPrompt` 不被后续 prompt 覆盖。

## 前置条件

- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：`hookTasks` Map 中不存在 `sessionId=TEST-FP-002`

## 测试步骤

1. 发送第一条 prompt：

   ```bash
   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d '{"hook_event_name":"UserPromptSubmit","session_id":"TEST-FP-002","cwd":"/tmp/b","data":{"prompt":"第一条 prompt"}}'
   ```

2. `curl -s http://localhost:3456/api/sessions`，记录 `id=TEST-FP-002` 项的 `firstPrompt`
3. 发送完全不同的第二条 prompt，`session_id` 仍为 `TEST-FP-002`，`data.prompt` 改为 `"完全不同的第二条 prompt"`
4. 再次 `GET /api/sessions`，读取同一项的 `firstPrompt`

## 预期结果

- 第 2 步读到的 `firstPrompt === "第一条 prompt"`
- 第 4 步读到的 `firstPrompt` 仍等于 `"第一条 prompt"`，未被第二次 prompt 覆盖

## 技术要点

- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.1 L304-L317「已存在时不再更新任何 prompt 字段」、§3.2 覆盖语义「不覆盖」
- 涉及字段：`hookTasks[sessionId].firstPrompt`
