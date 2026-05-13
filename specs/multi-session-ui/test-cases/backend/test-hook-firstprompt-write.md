# test-hook-firstprompt-write

## 测试目标
UserPromptSubmit hook 首次触发时，对应 hookTask 的 `firstPrompt` 字段应被写入，超过 80 字时截断到前 80 字，不多不少。

## 前置条件
- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：`hookTasks` Map 中不存在 `sessionId=TEST-FP-001`；测试开始前已通过 `POST /api/sessions` 或假定仅由 hook 创建条目

## 测试步骤
1. 构造 120 字的 prompt 字符串（例如 `'a'.repeat(120)`，或 120 个汉字便于肉眼计长）
2. 发送 hook：
   ```bash
   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d '{"hook_event_name":"UserPromptSubmit","session_id":"TEST-FP-001","cwd":"/tmp/a","data":{"prompt":"<120字>"}}'
   ```
3. 调用 `curl -s http://localhost:3456/api/sessions`，在数组中定位 `id === 'TEST-FP-001'` 项

## 预期结果
- 该项 `firstPrompt` 为字符串
- `firstPrompt.length === 80`
- `firstPrompt` 精确等于原 120 字 prompt 的前 80 字，不多不少

## 技术要点
- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.1 L304-L317、§3.2 字段规范、§5.1 `clampFirstPrompt`
- 涉及字段：`hookTasks[sessionId].firstPrompt`
