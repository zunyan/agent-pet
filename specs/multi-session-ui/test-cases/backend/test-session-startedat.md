# test-session-startedat

## 测试目标

`POST /api/sessions` 创建 session 时，返回体和内存对象都应写入 `startedAt`（ISO 8601 字符串，`new Date().toISOString()` 产物）。

## 前置条件

- 环境：terminal-server 已启动（默认 `http://localhost:3456`）
- 数据：目标 cwd 目录存在：`D:/projects/foo`（或任意合法本机路径）

## 测试步骤

1. 发起创建请求：

   ```bash
   curl -s -X POST http://localhost:3456/api/sessions \
     -H "Content-Type: application/json" \
     -d '{"cwd":"D:/projects/foo"}'
   ```

2. 解析响应 JSON，取 `startedAt` 字段
3. 再 `curl -s http://localhost:3456/api/sessions`，找到同 `id` 的项，比对 `startedAt`

## 预期结果

- 响应 JSON 中包含 `startedAt` 字段
- `typeof response.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(response.startedAt) && !isNaN(new Date(response.startedAt).getTime())`
- `GET /api/sessions` 中该项 `startedAt` 与创建响应一致

## 技术要点

- 对应设计文档：`specs/multi-session-ui/technical-design.md` §3.1 L620-L629「追加 `startedAt`」、§3.2 字段规范
- 涉及字段：`sessions[id].startedAt`
- 注：类型已定板为 ISO 8601 字符串（`new Date().toISOString()` 产物，对齐现有 `packages/terminal-server/src/index.js` 里 hook 路径的 `toISOString()` 风格），前端用 `new Date(isoString).getTime()` 解析即可
