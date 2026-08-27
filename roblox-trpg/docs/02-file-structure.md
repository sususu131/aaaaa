# 阶段1 MVP — 项目文件结构设计

```
roblox-trpg/
├── package.json                  # 根脚本：一键启动前后端（concurrently）
├── README.md                     # 项目说明 + 运行指南
├── docs/
│   ├── 01-requirements-analysis.md   # 步骤1 需求分析
│   └── 02-file-structure.md          # 本文件
│
├── frontend/                     # ── 前端：React + Vite ──
│   ├── package.json
│   ├── vite.config.js            # dev 代理 /socket.io → :3000（含 ws）
│   ├── index.html
│   └── src/
│       ├── main.jsx              # React 挂载入口
│       ├── App.jsx               # 顶层状态机：lobby ↔ room
│       ├── styles.css            # 基础样式（简洁功能型）
│       ├── lib/
│       │   └── socket.js         # socket.io-client 单例连接
│       └── components/
│           ├── LobbyScreen.jsx   # 入口页：输入名字 / 创建房间 / 加入房间
│           ├── RoomScreen.jsx    # 房间容器：房间ID展示、离开按钮
│           ├── PlayerList.jsx    # 玩家列表（实时同步）
│           └── ChatPanel.jsx     # 聊天区：消息流 + 输入框
│
├── server/                       # ── 后端：Node + Express + Socket.io ──
│   ├── package.json
│   ├── src/
│   │   ├── index.js              # 入口：Express + HTTP + Socket.io 启动
│   │   ├── config.js             # 端口、房间上限、消息长度等常量
│   │   ├── util/
│   │   │   └── roomCode.js       # 6位房间码生成（去除易混淆字符）
│   │   ├── rooms/
│   │   │   └── roomManager.js    # 房间管理：创建/加入/离开/容量校验
│   │   ├── players/
│   │   │   └── playerManager.js  # 玩家管理：注册/移除/列表查询
│   │   └── sockets/
│   │       └── handlers.js       # websocket通信：事件绑定与广播
│   └── test/
│       └── smoke.test.js         # 步骤9：socket.io-client 自动化冒烟测试
│
└── database/                     # ── SQLite ──
    ├── package.json
    ├── index.js                  # 连接管理 + 启动自动建表
    ├── schema.sql                # 全部表结构（含未来扩展预留表）
    ├── seed.sql                  # 未来副本/技能种子数据（仅数据，无逻辑）
    └── data/                     # .gitignore：roblox_trpg.db 运行时生成
```

## 模块职责

| 模块 | 职责 | 备注 |
|------|------|------|
| frontend/lib/socket.js | 维护唯一 socket 连接 | 同源连接，走 Vite 代理 |
| frontend/App.jsx | 全局状态（玩家名/房间/玩家列表/消息） | 纯状态机，组件无业务 |
| server/rooms/roomManager | 内存 Map 运行时权威状态 + SQLite 持久化 | 房间上限 3 人 |
| server/players/playerManager | socket_id ↔ 玩家会话映射 | 断线即移除 |
| server/sockets/handlers | 事件入口，调用 manager，广播结果 | 所有业务校验在此触发 |
| database/index.js | better-sqlite3 单例，启动执行 schema/seed | 幂等建表 |

## 数据流

```
浏览器 ──socket.io──▶ handlers.js ──▶ roomManager / playerManager ──▶ database (SQLite)
                      │
                      └──广播──▶ 房间内所有 socket
```
