# test-card-stripe-color

## 测试目标
卡片左侧 4px 色条基于 `hash(cwd)` 取色：相同 cwd 同色，不同 cwd 不同色；色相取自 HSL 调色盘 `hsl(H, 70%, 55%)`，H ∈ {0, 60, 120, 180, 240, 300}。

## 前置条件
- 环境：桌宠应用已启动，任务面板已打开
- 数据：3 个 session，cwd 分布为 A / A / B
  - card1：`cwd = "D:/projects/agent-pet"`
  - card2：`cwd = "D:/projects/agent-pet"`
  - card3：`cwd = "D:/projects/other-project"`

## 测试步骤
1. 在 DevTools Console 注入：
   ```js
   TaskList.render([
     { id: '1', cwd: 'D:/projects/agent-pet', type: 'manual', startedAt: Date.now() },
     { id: '2', cwd: 'D:/projects/agent-pet', type: 'manual', startedAt: Date.now() },
     { id: '3', cwd: 'D:/projects/other-project', type: 'manual', startedAt: Date.now() }
   ]);
   ```
2. 肉眼对比 3 张卡片左侧 4px 色条颜色。
3. DevTools Elements 选中色条元素，检查 `background-color` 计算值。

## 预期结果
- card1 与 card2 色条颜色完全一致
- card3 色条颜色与前两张明显不同
- 三条色条的 HSL 色相 H 均属于集合 {0, 60, 120, 180, 240, 300}，饱和度 70%，亮度 55%

## 技术要点
- 对应设计文档：specs/multi-session-ui/technical-design.md 色条章节
- 涉及函数/类名：`stripeColorFor(cwd)`、`TaskList.render`
