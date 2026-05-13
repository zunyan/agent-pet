# test-api-sessions-returns-new-fields

## 测试目标

`GET /api/sessions` 返回数组的每一项必须显式包含 `firstPrompt` / `startedAt` / `pid` 三个字段；key 必须存在且不得缺失。其中：

- `firstPrompt` 类型为 `null | string`（未触发 prompt 时显式为 `null`，禁止 undefined 或空串占位）
- `startedAt` 类型为 `string`（ISO 8601，`new Date().toISOString()` 产物）
- `pid` 类型为 `number | null`

## 前置条件

- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：干净环境或已知 2 个待创建 session 的 id 唯一

## 测试步骤

1. 创建会话 A，并触发一次 UserPromptSubmit（有 prompt）：

   ```bash
   ID_A=$(curl -s -X POST http://localhost:3456/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/projects/foo"}' | jq -r .id)

   curl -s -X POST http://localhost:3456/api/hook \
     -H "Content-Type: application/json" \
     -d "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$ID_A\",\"cwd\":\"D:/projects/foo\",\"data\":{\"prompt\":\"hello\"}}"
   ```

2. 创建会话 B，**不** 触发任何 hook：

   ```bash
   ID_B=$(curl -s -X POST http://localhost:3456/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/projects/bar"}' | jq -r .id)
   ```

3. 请求 `curl -s http://localhost:3456/api/sessions`，分别取出 A / B 两项

## 预期结果

- 两项对象都显式包含 `firstPrompt`、`startedAt`、`pid` 三个 key（用 `in` 运算符 / `Object.keys` 可见）
- A 项 `firstPrompt === "hello"`；B 项满足 `'firstPrompt' in item && (item.firstPrompt === null || typeof item.firstPrompt === 'string')`（允许 null 或合法字符串，不再强制要求一定为 null）
- 两项 `startedAt` 字段均为 ISO 字符串，满足 `typeof startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(startedAt) && !isNaN(new Date(startedAt).getTime())`；`pid` 均为正整数或 `null`

## 技术要点

- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.2 字段规范、§3.3 合并策略、§6 「空值降级」
- 涉及字段：返回项的 `firstPrompt / startedAt / pid`
