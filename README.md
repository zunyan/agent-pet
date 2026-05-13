# claw-pet (桌面宠物)

A desktop companion pet for Claude Code

## 效果预览

![Working](pets/pet-desktop/assets/sprites/working/frame_001.png)

Claude Code 工作时，桌宠会显示 Working 动画。

## 安装 Installation

```bash
# 1. 克隆仓库
git clone https://github.com/zunyan/agent-pet.git
cd agent-pet

# 2. 安装 CLI 工具
cd packages/agent-pet
npm install
npm link

# 3. 初始化（配置 Claude Code Hooks）
agent-pet init

# 4. 启动桌面宠物
agent-pet start
```

安装完成后，Claude Code 启动时桌面宠物会自动启动。

## 常用命令

| 命令 | 说明 |
|------|------|
| `agent-pet init` | 初始化并配置 Claude Code Hooks |
| `agent-pet start` | 启动桌面宠物 |
| `agent-pet stop` | 停止桌面宠物 |
| `agent-pet skin [name]` | 切换/查看皮肤 |
| `agent-pet build` | 构建桌面宠物 |
| `agent-pet setting` | 打开设置界面 |

## 功能特性

- **桌面宠物展示**：支持多种状态动画（idle、thinking、working、success、error）
- **任务面板**：显示 Claude Code 的任务和会话，支持首条 prompt 预览
- **权限提醒**：等待权限确认时显示通知
- **多会话区分**：同项目会话使用相同颜色条区分

## 开发者文档 Developer Guide

本地开发 claw-pet 源码请参考 [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)
