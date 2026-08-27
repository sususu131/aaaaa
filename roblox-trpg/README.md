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
- **未来预留**：`dungeons`（Roblox体验→副本）、`skills`（含 `source_type` /
  `skill_type` / `effect_data` / 审核状态）、`items`、`currencies`、
  `dungeon_rewards`（多类型奖励：技能/物品/货币/特殊，支持概率/必得/可选）、
  `player_skills`（玩家技能 + 获得来源）
- **种子数据只预置测试用副本基础资料**（Doors / Jailbreak / Blox Fruits），
  **不预写任何技能与奖励** —— 技能/奖励必须由副本设计流水线产出并审核。

未来成长逻辑：完成副本 → 获得该体验相关技能。技能设计走
[副本设计流水线](docs/03-dungeon-design-pipeline.md)：
AI Web Search 真实资料 → 分析玩法 → 设计候选（`source_type` 区分
official/inspired/original）→ 规则系统审核 → 发放。

## 开发文档

- [步骤1 需求分析](docs/01-requirements-analysis.md)
- [步骤2 文件结构设计](docs/02-file-structure.md)
- [副本设计流水线（AI Web Search 规范）](docs/03-dungeon-design-pipeline.md)

---

# 阶段2：AI GM + Roblox 公开信息系统

## 新增能力

- **临时玩家身份**：服务器生成 `player_xxxx` + 高熵 sessionToken（SHA-256 哈希入库，
  HttpOnly Cookie，客户端不能指定 playerId，token 不进 URL）
- **@AI**：聊天中显式 `@AI` 触发 AI GM；`@玩家` 只提及不触发 AI
- **AI GM**：OpenAI 兼容 API（Key 仅存服务端环境变量）；错误按真实原因提示
  （未配置/限速/余额不足/鉴权失败/超时），无静默失败
- **Structured Output**：gm_response = narrative + options + events +
  memory_update + rule_requests + source_references；AI 无权改任何游戏状态，
  只能提交 rule_requests 等待规则引擎审批
- **AI 行动选项**：点击只填入输入框，玩家可修改后自行发送（建议而非强制）
- **Roblox Information Service**（服务端代理，浏览器/AI 不直连）：
  - 用户公开资料（按 User ID / username）、头像 headshot/全身
  - Experience URL 解析 → placeId → universeId → 官方详情/图标/统计
  - 体验搜索（多结果交玩家选择，不自动选定）
  - TTL 缓存（体验30分钟/用户6小时/缩略图12小时），失败兜底旧缓存，
    无缓存返回 ROBLOX_DATA_UNAVAILABLE
- **Roblox 身份可选绑定**：提供公开 User ID 即显示头像；不绑定 = 培根头
  （绝不要求登录/密码/Cookie）
- **Context 系统**：10 分区构建（SYSTEM_RULES / WORLD_SETTING / WORLD_STATE /
  PLAYER_STATE / CURRENT_LOCATION / CURRENT_DUNGEON / NPC_STATE / RECENT_EVENTS /
  IMPORTANT_MEMORIES / ROBLOX_SOURCE_DATA）
- **Context Viewer**：分类展示 + token 占用（开发期全员可见）
- **Context 自动压缩**：70% 提示 / 80% 准备 / 90% 强制压缩；
  世界设定/玩家状态/副本进度/关键资料不压缩（真实数据回查数据库）
- **安全**：玩家输入一律 UNTRUSTED_INPUT；2000 字符上限；
  玩家/房间级 AI 频率限制；Roblox 资料以只读围栏注入，防 Prompt Injection

## 架构红线

```
PLAYER → SERVER → AI → RULE ENGINE → DATABASE → ALL PLAYERS   （正确）
PLAYER → AI → DATABASE                                        （禁止）

ROBLOX API → SERVER → SOURCE DATA → AI CONTEXT → AI GM        （正确）
浏览器/浏览器密钥 → ROBLOX API                                 （禁止）
```

## 运行（阶段2）

```bash
# 配置 AI GM（可选，未配置时按真实原因提示错误）
export AI_API_KEY=sk-xxx            # 或复制 server/.env.example
export AI_BASE_URL=https://api.openai.com/v1
export AI_MODEL=gpt-4o-mini

npm run dev                          # 后端 :3000 + 前端 :5173
npm test                             # 16 项断言组
```

## 阶段2 目录新增

```
server/src/
├── services/roblox/    robloxHttp / robloxCache / robloxUsers /
│                       robloxThumbnails / robloxExperiences / robloxSearch
├── services/ai/        aiGm / structuredOutput / contextBuilder /
│                       contextCompressor / promptRules / rateLimiter
├── sessions/           sessionManager（临时身份）
└── routes/             apiRoutes（/api/roblox/*、/api/session/cookie）
frontend/src/components/
├── ActionOptions.jsx   ContextViewer.jsx  DungeonPanel.jsx
└── RobloxBindPanel.jsx MentionBox（内置于 ChatPanel）
```

数据库新增：`sessions` / `roblox_profiles` / `room_memories` /
`context_summaries` / `ai_rule_requests`；`rooms` 增加 `current_experience`，
`players` 增加 `uid` 与 `roblox_profile_id`。

设计文档：[阶段2架构确认](docs/04-stage2-architecture.md)
