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

---

# 阶段3：AI GM Agent + 世界状态 + 工具调用系统

AI GM 从"聊天机器人"升级为**受服务器规则约束的 Agent**：读取世界状态 → 判断检定 →
调用白名单工具 → 服务器验证+写库 → 叙事。AI 永远不能直接执行 SQL、编造骰子或发放奖励。

## 架构

```
AI → Tool Call → Server 验证（参数/权限/范围/冲突）→ Execute → Tool Result → AI → 最终回答
PLAYER → SERVER → AI → RULE ENGINE → DATABASE → ALL PLAYERS
```

## Tool 系统（16 个，全部白名单 + 审计）

| Tool | 权限 | 说明 |
|------|------|------|
| get_world_state / get_player_state / get_dungeon_state | read | 服务器权威状态查询（跨房间读取被拒绝） |
| roll_dice / skill_check | mutate | **服务器生成随机数**；双骰拼点（1d20 vs 1d20）；技能所有权验证 |
| modify_world_state | mutate | 白名单字段（door_open 等）+ 乐观锁 world_version |
| modify_player_state | mutate | 白名单（hp/状态效果/位置）+ 数值范围验证 |
| grant_item / grant_skill | mutate | **数据库奖励表驱动**：通关验证→防重复→drop_rate/is_guaranteed→写库 |
| complete_dungeon | mutate | 通关登记（grant_skill 的前置条件） |
| create_option | read | 追加行动选项（仍只填入输入框） |
| get_roblox_experience / user / avatar / search_roblox_experiences | read | 封装阶段2服务，CANONICAL_FACT 只读围栏 |
| web_search | read | 服务器搜索适配器（Serper 可插拔），AI 不直连网络 |

## Provider 层（可切换，不锁死格式）

`AI_API_FORMAT=openai`（OpenAI/DeepSeek-OpenAI 兼容）或 `anthropic`
（处理 content[] 的 thinking / tool_use / text）。业务层只调用统一接口。

DeepSeek 配置示例：

```bash
export AI_API_KEY=sk-xxx
export AI_BASE_URL=https://api.deepseek.com
export AI_MODEL=deepseek-v4-flash     # 默认允许 Thinking（reasoning_content 不外显）
# 第三方网关返回 Anthropic 风格时：
export AI_API_FORMAT=anthropic
```

## 新增数据库表

`world_states`（版本号乐观锁）/ `world_events`（who/when/action/before/after/source 审计）/
`player_states`（HP/状态效果）/ `player_items` / `dice_rolls` / `tool_calls`（脱敏审计）/
`player_dungeon_progress`；`dungeons` 增加 `roblox_universe_id` / `roblox_place_id`。
种子新增**阶段3测试奖励数据**（approved 测试夹具：危险感知/开锁能力/果实能力 + 骨架钥匙/撬棍）。

## 测试（46 项）

```bash
npm test                # 16（阶段1/2回归）+ 30（阶段3）
npm run test:stage3     # 仅阶段3（本地 mock AI 端点，无需外网）
```

阶段3 覆盖：普通回答/单工具/多工具/多轮/参数非法/工具不存在/无权限/非法字段/
伪造骰子/伪造奖励/重复领取/未通关领取/正常获得/随机掉落/必得奖励/搜索/
Roblox工具/共享状态/并发一致性/版本冲突/Context集成/压缩保护/超时/429/5xx/
工具失败/无限循环/最大轮次/注入防护/Key不泄露。

## 两浏览器多人演示流程

1. `npm run dev`，打开两个浏览器/无痕窗口访问前端
2. 玩家A 建房 → 玩家B 输入房间ID加入
3. 副本面板：绑定 DOORS（可粘贴 `https://www.roblox.com/games/6516141723/DOORS`，
   无外网时用"数据库登记副本"离线绑定）
4. 玩家A：`@AI 我打开第一扇门` → GM 读取世界状态 → 决定检定 → `skill_check`
   服务器掷双骰 → 按真实结果叙事 → `modify_world_state` → 广播 WORLD_STATE_CHANGED，
   A、B 同时看到
5. `@AI 我们通关了` → `complete_dungeon` → `grant_skill` → 玩家获得「危险感知」，
   另一名玩家看到 SKILL_GAINED 广播
6. 刷新页面：世界状态仍在（数据库），playerId 不变（会话），技能仍在

## 已知限制

- 预览沙箱无外网：Roblox/Web Search/AI 均走各自的"不可用"错误分支（规范行为）
- `dungeon_rewards` 的 currency 类型奖励尚未接入发放工具（表结构已预留）
- Anthropic Provider 已实现但未在真实 Anthropic 端点回归（沙箱无外网）

---

# 阶段3b：Avatar Vision + 初始属性 + 初始技能

绑定 Roblox 用户后：公开资料 → Avatar 图片（全身优先、headshot 兜底）→ **独立 Vision Provider**
→ 候选标签 → **服务器 Rules Engine**（白名单/置信度/限额/冲突）→ 初始属性 + 初始技能 → Player State。
没有 Roblox 账号 = 培根头：全属性 5、0 技能、**Vision 调用次数 = 0**。

## 关键架构：文字 AI 与 Vision 完全分离

| | 文字 AI（跑团） | Vision（看图） |
|---|---|---|
| 配置 | `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | `VISION_API_KEY` / `VISION_BASE_URL` / `VISION_MODEL` |
| 默认模型 | deepseek-v4-flash | deepseek-v4-flash-vision-exp |
| 代码 | `services/ai/` | `services/vision/` |
| 职责 | GM/NPC/叙事/骰子/选项 | 仅视觉观察，输出 UNTRUSTED 候选 |

两套配置互不复用；任一 Provider 故障不影响另一个（已测试）。

## 规则（服务器权威，Vision 不可修改）

- 属性：STR/DEX/CON/PER/INT/LUK，base 5；Clamp 1~10；单次总正加成 ≤6
- 标签白名单 23 个（`ALLOWED_AVATAR_TAGS`），未知标签 REJECTED_UNKNOWN_TAG
- 置信度 < 0.70 → REJECTED_LOW_CONFIDENCE
- 技能：标签 → `avatar_skill_rules` → skills 表（approved）→ 最多 2 个；
  god_mode/admin/infinite_power 等一律 REJECTED_UNKNOWN_SKILL
- 初始技能 `source_type=INITIAL_AVATAR`，与副本技能 `DUNGEON` 严格区分（不能靠长相拿副本技能）
- 状态机：NOT_INITIALIZED → ANALYZING → INITIALIZED / FAILED（可重试）；
  `avatar_snapshot_hash` + UNIQUE 防重复（刷新/重连不重复发放）
- 最终写入使用事务（snapshot/属性/技能/状态 原子提交，失败回滚）

## API 与页面

- `POST /api/vision/avatar/analyze`：服务端自查会话→资料→头像→Vision（玩家不能提交属性/技能/图片）
- `POST /api/vision/avatar/status`：初始化状态回显
- `GET /vision-test`：仅开发环境的调试页（Request/Raw/Parsed/Validation/Final，不显示 Key）

## 数据库

新增 `avatar_initialization`（快照+结果+状态）、`vision_analysis_log`（审计，禁记 Key）；
`player_states` 增加 `attributes`；`skills.source_type` 扩展 `INITIAL_AVATAR`/`DUNGEON`；
种子新增 14 个初始技能（approved 测试夹具）。

## 测试（共 87 项）

```
npm test               # 16（阶段1/2）+ 30（阶段3）+ 41（阶段3b）
npm run test:stage3b   # 仅 Vision（本地 mock Vision/AI 双端点）
```

阶段3b 覆盖：15 类 Avatar 原型 / 低清 / 黑暗 / 遮挡 / 无特征 / 图片文字注入 /
玩家注入 / 未知标签 / 未知技能 / GOD / ADMIN / INFINITE / STR=999 伪造 /
10+技能限额 / 重复初始化 / 培根头(0次Vision) / 401·429·503·超时错误 /
AI↔Vision 配置隔离与互相独立故障 / Key 不泄露 / 属性限额 / 事务一致性。
