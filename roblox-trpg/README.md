# Roblox灾变：现实崩坏

多人 AI 跑团网页游戏。全球突变，Roblox 降临现实——没有账号的人将变成培根头。

**当前进度：阶段1 MVP —— 多人房间 + 实时聊天 + 基础玩家同步。**

## 功能（阶段1）

- 输入名字 → 创建房间 → 获得 6 位房间ID
- 其他玩家凭房间ID加入（单房间上限 3 人）
- 实时聊天，所有玩家同步可见
- 玩家进入/离开实时同步（玩家列表 + 系统消息）
- 数据库已为未来扩展预留：技能 / 副本奖励 / 玩家技能成长线

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + Vite 5 |
| 后端 | Node.js + Express + Socket.io |
| 数据库 | SQLite（Node 22 内置 `node:sqlite`，零依赖） |

要求 Node.js ≥ 22.5。

## 运行

```bash
cd roblox-trpg

# 1. 安装依赖（根目录 + 三个子包）
npm install
npm install --prefix database   # 无外部依赖，仅初始化
npm install --prefix server
npm install --prefix frontend

# 2. 一键启动（后端 :3000 + 前端 :5173）
npm run dev
```

浏览器打开 `http://localhost:5173`。开多个标签页/窗口即可模拟多名玩家。

## 测试

```bash
npm test          # = npm test --prefix server
```

端到端冒烟测试覆盖：建房、加入、满员拒绝、错误房间码、聊天广播、离开/断线同步（8 项断言组）。

## 目录结构

```
roblox-trpg/
├── frontend/   # React + Vite：入口页 / 房间界面 / 聊天界面 / 玩家列表
├── server/     # Express + Socket.io：server入口 / 房间管理 / 玩家管理 / websocket通信
├── database/   # SQLite：schema（含预留表）/ seed / 连接管理
└── docs/       # 需求分析、结构设计文档
```

## 数据库（含未来预留）

- **阶段1 使用**：`rooms`、`players`、`messages`
- **未来预留**：`dungeons`（Roblox体验→副本）、`skills`（技能）、
  `dungeon_rewards`（副本掉落）、`player_skills`（玩家技能 + 获得来源）

未来成长逻辑：完成副本 → 获得该体验相关技能
（Doors→危险感知 / Jailbreak→开锁能力 / Blox Fruits→果实能力），种子数据已就位。

## 开发文档

- [步骤1 需求分析](docs/01-requirements-analysis.md)
- [步骤2 文件结构设计](docs/02-file-structure.md)
