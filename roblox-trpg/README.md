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

---

# 阶段4：Roblox Dungeon Design Pipeline（副本设计流水线）

Roblox Experience → Canonical Snapshot → **Dungeon Designer AI**（独立于 GM 的 Prompt）→
Schema/Semantic/Rules/Canonical 四层验证 → DRAFT → REVIEW → APPROVED → **PUBLISHED（immutable）**。

**复用（零重写）**：阶段2 Roblox Information Service（HTTP/缓存/体验解析）、
阶段3 Provider 抽象与 structuredOutput、既有 dungeons/skills/dungeon_rewards 表、
阶段3b Vision Provider（图标分析可选，输出仅为 CANONICAL_FACT_CANDIDATE）。

## 核心纪律

- **Canonical vs Original**：canonical_facts 只接受快照中真实字段（伪造 → `INVALID_CANONICAL_FACT`）；
  场景/NPC/敌人/事件/Boss 全部盖 `TRPG_ORIGINAL`；奖励候选 `DUNGEON_GENERATED`
- **AI 永不自动发布**；PUBLISHED 后修改 = 新 version（旧版本可复现）
- **幂等**：同 source + snapshotHash + prompt_version + model 复用成功 Draft（`force` 可强制重生成）
- **Snapshot/Prompt/Model/Token 全记录**：`dungeon_design_runs`（input_snapshot 含 Roblox 资料快照）
- **声明式事件**：仅允许 MODIFY_WORLD_FLAG / SET_SCENE / SPAWN_ENCOUNTER / ADD_MEMORY（禁止代码执行）
- **限额**：Scenes≤50 / Encounters≤100 / NPC≤50 / Enemies≤100 / Events≤200 / Rewards≤50 / 描述≤5000
- **数值规则**：difficulty 1~10、party 1~3、enemy hp 1~1000 / damage 0~500；无限金币/无敌/权限类 → `OVERPOWERED_REWARD`
- 错误码：`INVALID_SOURCE / ROBLOX_DATA_UNAVAILABLE / DUNGEON_DESIGN_AI_FAILED /
  DUNGEON_VALIDATION_FAILED / INVALID_TRANSITION / IMMUTABLE_VERSION`（无 500 Unknown）

## 新增文件

```
server/src/services/dungeon/   dungeonDesigner.js / dungeonValidation.js / dungeonPipeline.js
server/src/routes/             dungeonRoutes.js
server/test/                   stage4-pipeline.test.js（42 项）
database/                      migrations.js（迁移框架）
frontend/src/components/       DungeonDesigner.jsx
```

## 数据库迁移（database/migrations.js，幂等）

- `dungeons` + `uid`（内部主键，不用 placeId；唯一索引）
- 新表：`dungeon_versions`（版本 + 状态机 + immutable）、`dungeon_design_runs`
  （snapshot/provider/model/prompt_version/token usage）、`dungeon_reviews`

## 新增 API

| 方法/路径 | 说明 |
|---|---|
| `POST /api/dungeons/design` | 生成设计（{source:{type,url/placeId/universeId}, force?, includeVisionIcon?}） |
| `GET /api/dungeons/:id` / `.../versions` / `.../versions/:v` / `.../diff?from&to` | 查询与差异 |
| `GET /api/dungeon-design-runs/:id` | 生成记录（snapshot/model/tokens） |
| `POST /api/dungeon-versions/:id/submit-review` | DRAFT → REVIEW |
| `POST /api/dungeon-versions/:id/review` | REVIEW → APPROVED/REJECTED（含原因） |
| `POST /api/dungeon-versions/:id/publish` | 仅 APPROVED → PUBLISHED |

## 使用

房间内点击「副本设计」→ 粘贴 Roblox URL（如 `https://www.roblox.com/games/6516141723/DOORS`）→
解析显示官方信息 → 生成副本设计 → 预览（Canonical 与 TRPG Original 分区展示）→
提交审核 → 批准 → 发布；多版本时可查看版本差异。

```
npm run test:stage4    # 42 项（mock AI/Vision + 脚本化 Roblox stub，无需外网）
npm test               # 129 项全套件
```

---

# 阶段5：Dungeon Runtime（已发布副本运行系统）

PUBLISHED Dungeon Version → **Dungeon Instance**（一次实际游戏）：2~3 人共享同一个世界、
行动经服务器排队裁定、AI GM（复用，非第二套）驱动叙事、双骰拼点战斗（复用）、
场景推进、Boss 阶段、声明式事件、通关结算（复用 Reward Validation Chain）、
奖励幂等发放、全程事件日志（可重放数据）、断线恢复。

**复用（零重写）**：Session/@AI/@玩家/聊天（阶段2）、Dice Engine/World State 乐观锁/
Tool Registry/Player State/属性系统（阶段3）、Definition/版本/奖励表（阶段4）、
Context 压缩（阶段2）。AI GM 仍是同一个 Agent/Provider 体系，仅新增 Runtime 专用 Prompt 与输出模式。

## 新增结构

- `dungeon_instances`：uid / version_id / room_id / 状态机（WAITING→RUNNING→COMPLETED/FAILED/ABORTED）/
  current_scene_id / world_state_version / party（座位制 JSON）
- `instance_actions`：队列 + sequence + 状态（PENDING/PROCESSING/RESOLVED/REJECTED/FAILED）+ client_action_id 幂等
- `instance_events`：ACTION/ROLL/STATE_CHANGE/SCENE_TRANSITION/COMBAT/REWARD/NARRATION… 单调 sequence（Replay 数据）
- `instance_combats`：turn/round/enemy_states/player_states/boss_phase/version（乐观锁 Combat Lock）
- `reward_grants`：grant_uid + UNIQUE(instance_id, player_id, reward_key)（奖励幂等）

## 新增文件

```
server/src/services/runtime/   instanceManager.js / runtimeEngine.js / combatEngine.js / rewardEngine.js
server/src/routes/             runtimeRoutes.js
server/test/                   stage5-runtime.test.js（51 项）
frontend/src/components/       DungeonRuntime.jsx
```

## API（阶段5）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/dungeons` | 副本列表（含已发布版本） |
| `POST /api/dungeon-instances` | 在玩家当前房间创建实例（仅 PUBLISHED；同房间唯一活跃实例） |
| `POST /api/dungeon-instances/:id/join` | 加入（仅 WAITING；2~3 人；运行中禁止） |
| `POST /api/dungeon-instances/:id/start` | 开始（≥2 人；初始化场景/世界/事件） |
| `POST /api/dungeon-instances/:id/actions` | 提交 Action（`await:true` 同步返回结果；幂等键 `clientActionId`） |
| `GET /api/dungeon-instances/:id` | 完整快照（断线恢复：场景/队伍/HP/属性/技能/战斗/世界状态） |
| `GET /api/dungeon-instances/:id/events` | 事件日志（Replay） |
| `POST /api/dungeon-instances/:id/leave` | 离开 |

## 运行与多人演示

```
npm test              # 180 项全套件（16+30+41+42+51）
npm run test:stage5   # 仅阶段5
npm run dev
```

1. 「副本设计」生成→审核→发布一个副本（或测试库中已有）
2. 浏览器A 建房，浏览器B 加入房间
3. 任一玩家开「副本运行」→ 选已发布版本 → 创建实例；另一玩家同面板点「加入实例」
4. 「开始」（≥2人）→ 共享场景出现；聊天 `@AI ...` 或面板「行动」提交动作
5. 服务器排队裁定：叙事/双骰战斗/场景推进/事件 → 全体实时同步（Socket.IO）
6. 击败 Boss → `@AI 我们完成了` → COMPLETED → 奖励经验证发放 → 技能进入玩家技能库
7. 刷新页面：`instance:sync` + GET 快照恢复；房主断线副本不消失

## 防作弊与幂等

客户端只能提交 Action 文本；骰子/HP/金币/技能/场景跳转/Boss 数值全部服务器裁定。
client_action_id / tool_call_id / reward_grant_id 三层幂等；并发 Action 串行队列 + 乐观锁。

---

# 阶段6：Persistent Character Progression（长期角色成长）

Session ≠ Dungeon Instance ≠ Character：**Character = 扩展后的 players 行**（零第二套系统）。
玩家拥有长期角色：等级/XP/HP/属性/技能/装备/物品/货币，全部服务器权威 + 乐观锁 + 交易日志。

## 复用（零重建）

- 属性系统：阶段3b `player_states.attributes`（base）+ 修正/装备计算（不重写）
- 技能：`player_skills`/`skills`（3b 初始技能 + 4/5 副本技能统一库存）
- 背包：`player_items` 扩展（堆叠规则/来源/元数据）
- 货币：`currencies` 表（阶段2 已有金币）
- 奖励：阶段5 Reward Validation Chain + reward_grants 幂等
- Avatar：阶段3b 初始化结果直接作为角色初始属性/技能来源

## 核心机制

- **Stats**：total = base + 永久修正 + 装备加成 + 临时修正（限实例），Clamp 1~10；装备不写回 base
- **XP/Level**：数据驱动阈值（`leveling.js` 集中配置）；升级服务器计算 → `LEVEL_UP` 事件；AI 无 XP 通道
- **HP**：damage/heal/death(DOWNED)/revive 全部服务器执行；副本内死亡不污染长期角色（结束按快照恢复），
  仅当 Definition 声明 `permadeath` 才有服务器验证的永久后果
- **技能**：唯一性（重复→升级）；声明式效果（HEAL/DAMAGE/ROLL_MODIFIER/STAT_MODIFIER/ADVANTAGE/…）；
  回合制冷却 + 次数限制；AI 只能 `skill_use` 请求，服务器验证所有权/状态/冷却/次数
- **装备**：weapon/armor/accessory_1/accessory_2 槽；所有权+可装备性服务器验证；替换回背包
- **物品**：STACKABLE 堆叠 / NON_STACKABLE 恒1 / UNIQUE 拒绝重复
- **快照**：副本开始时存角色快照；副本内用实例状态；结束经验证回写（临时效果自动清除）
- **并发**：`players.version` 乐观锁 + 冲突重试（并发 XP +100/+100/+100 → 无丢失）
- **审计**：`character_transactions`（XP/LEVEL/HP/CURRENCY/ITEM/SKILL/EQUIPMENT/STAT，old/new 值）

## 新增文件

```
server/src/services/character/   characterService.js / leveling.js
server/src/routes/               characterRoutes.js
server/test/                     stage6-character.test.js（65 项）
frontend/src/components/         CharacterPanel.jsx
```

## Migration（003_stage6_character_progression）

`players.version`；`player_skills` +level/source_type/cooldown/uses；`skills` +cooldown_turns/max_uses；
`items` +kind/slot/stacking/stat_bonus；新表 `character_equipment` / `character_modifiers` /
`player_currency` / `character_transactions` / `instance_character_snapshots`。
注意：迁移先于种子执行（种子可引用新列）。

## API（阶段6）

`GET /api/character` · `/api/character/stats|skills|inventory|equipment` ·
`POST /api/character/skills/:id/use` · `POST /api/character/equipment/equip|unequip`
（无任何客户端修改 XP/等级/属性/HP/技能/物品/货币 的端点）

## 成长闭环（完成标准）

新玩家进入 → 自动创建 Character → Avatar Vision/Bacon Head 初始属性与技能（3b 复用）→
进入副本（快照）→ 战斗/事件 → 通关 → Reward Validation → XP/技能/物品/装备/货币结算 →
角色更新 → 离开 → 重新进入：角色仍在（Persistent Progression Loop ✅）。

```
npm test              # 245 项全套件（16+30+41+42+51+65）
npm run test:stage6   # 仅阶段6
```

---

# 阶段7：AI GM Runtime 2.0（多轮 Tool Calling + Web Search + Streaming + 限时抉择）

AI GM 从"单次请求→单次回答"升级为真正的 **Agent Runtime**：
`User → AI → Tool → Server → Tool Result → AI → … → Final Answer`（0~8 轮，预算硬限制）。

## 核心能力

- **Agent Loop**（`agentRuntime.js`）：MAX_TOOL_ROUNDS=8 / MAX_TOOLS=16 / MAX_SEARCHES=4 / MAX_DURATION；
  同一轮多个 Tool Call 全部执行；`tool_call_id` 幂等；最终回答按 `finish_reason` 判定（不依赖 content）
- **Tool Registry 升级**：22 个工具；权限模型（READ_ONLY/GAME_ACTION/REWARD/WEB/ROBLOX/ADMIN/AI_INTERNAL）；
  Context-aware 可见性（lobby/room/dungeon 范围过滤）；新增 `get_character / get_scene / damage_player / heal_player / use_skill / roblox_search`
- **Web Search**：AI 只发请求，服务器执行 SearchProvider（Serper/可扩展）；查询 ≤500 字符、单次 ≤4 query、
  单请求 ≤4 次搜索；结果以 `<external_search_result>` UNTRUSTED 围栏注入，`[来源N]` 编号，URL 仅来自 Provider
- **Roblox Search**：与 web_search 分离，优先 Roblox API（CANONICAL_FACT）
- **Provider**：OpenAI 兼容（含 DeepSeek：`reasoning_content` 透传不丢弃）/ Anthropic / **Responses API Adapter**
  （message/function_call/function_call_output，与 Chat Completions 严格分离）；统一 AgentResponse 归一化
- **Streaming**：SSE 解析 + 事件协议 `AI_START / AI_TEXT_DELTA / AI_TOOL_START / AI_TOOL_ARGUMENTS /
  AI_TOOL_RESULT / AI_SEARCH_START / AI_SEARCH_RESULT / AI_COMPLETE / AI_ERROR`（经 Socket.IO `agent:event` 广播）；
  非流式端点自动回退
- **Tool Trace**：`agent_runs` / `agent_tool_calls`（round/tool_call_id/args/result/duration/status）；
  `GET /api/agent-runs(:id)` 逐轮查看（Replay 视角）
- **限时抉择（QTE）**：GM 输出 `timed_event`（如 DOORS 躲 Rush）→ 前端进度条倒计时 →
  `POST /api/dungeon-instances/:id/timed-choice`（幂等，首个选择生效）→ 超时未选择：服务器执行失败后果
  （伤害/可致死/全队倒下→副本失败）；deadline 钳制 3s~60s
- **Agent Queue / Lock**：复用阶段5 实例串行队列（同实例单 pipeline）；断线不中断进行中的 Agent
- **错误恢复**：429/401/402/403/超时/非法 JSON/未知工具/畸形参数（允许重试）/5xx 全分类处理
- **安全**：AI 输出全部 UNTRUSTED；搜索注入围栏；工具参数防作弊（damage 1~50、目标存在性）；
  Trace 不泄露 API Key；Room Isolation（工具只能访问当前房间/实例）

## 新增文件

```
server/src/services/ai/agentRuntime.js          Agent Loop + 预算 + Trace
server/src/services/ai/providers/responsesAdapter.js   Responses API Adapter
server/src/services/ai/tools/getCharacter.js / getScene.js / damageHeal.js / useSkill.js / robloxSearch.js
server/test/stage7-agent.test.js                82 项测试
```

## Migration（004_stage7_agent_runtime）

`agent_runs`（uid/room/instance/player/scope/status/rounds/tool_calls/searches/budget/error）、
`agent_tool_calls`（agent_run_id/round/tool_call_id/tool_name/arguments/result/duration_ms/status）

## 配置

```bash
# DeepSeek（OpenAI 兼容；Thinking Mode 的 reasoning_content 自动透传）
export AI_API_KEY=sk-xxx AI_BASE_URL=https://api.deepseek.com AI_MODEL=deepseek-v4-flash
export AI_API_FORMAT=openai        # openai | anthropic | responses
export AI_STREAM=on                # off 关闭流式
# Web Search（可选，未配置时返回 SEARCH_UNAVAILABLE）
export SEARCH_PROVIDER=serper SERPER_API_KEY=xxx
# Agent 预算
export AGENT_MAX_TOOL_ROUNDS=8 AGENT_MAX_TOOLS=16 AGENT_MAX_SEARCHES=4 AGENT_MAX_DURATION_MS=60000
```

```
npm test              # 327 项全套件（16+30+41+42+51+65+82）
npm run test:stage7   # 仅阶段7
```

---

# 阶段8：Quest & Objective System（任务系统 + 目标系统 + 分支任务 + 世界状态联动）

副本 / NPC / 世界事件 / AI GM / 战斗 / 探索 / 物品 / 技能 / 玩家选择，全部可驱动任务进度。
任务系统只监听 **Game Event Bus** —— 战斗/物品/副本等系统不直接依赖 Quest（解耦）。

## 核心机制

- **状态机**：Quest `AVAILABLE→ACTIVE→COMPLETED/FAILED/ABANDONED`（COMPLETED→ACTIVE 等非法转换被拒；
  ABANDONED→ACTIVE 明确允许）；Objective `LOCKED→ACTIVE→COMPLETED/FAILED/SKIPPED`
- **顺序/并行目标**：同 `order_index` 并行；递增顺序解锁（前组完成才解锁下一组）
- **作用域**：PERSONAL（逐玩家进度，全员完成才算）/ PARTY / ROOM / DUNGEON / WORLD
- **事件驱动**：18 种游戏事件（PLAYER_ENTERED_DUNGEON/SCENE、ITEM_ACQUIRED、ENEMY_DEFEATED、
  DOOR_OPENED、SKILL_USED/ACQUIRED、DUNGEON_COMPLETED/FAILED、PLAYER_ESCAPED、WORLD_STATE_CHANGED…）
- **幂等**：`UNIQUE(quest_instance_id, event_id, objective_id)` —— 同一事件不重复推进
- **并发**：Objective 计数乐观锁（version），10 事件打 5 计数恰好 5 不过冲
- **分支任务 + Choice**：目标带 `branch` → 生成 PENDING 选择 → 玩家提交 → 服务器重验（参与者/状态/
  Condition DSL）→ 激活/跳过分支目标
- **Condition DSL**：stat_check / has_skill / has_item / has_equipment / quest_completed /
  world_state / dice_result / dungeon_state / player_count（声明式，绝不执行 JS）
- **隐藏任务**：事件阈值发现（如熄灯触发「不要回头」），未发现前不可见
- **时间限制**：服务器时间判定（deadline_at），超时自动 FAILED
- **AI 工具**：`get_active_quests / get_quest / get_quest_progress / start_quest / abandon_quest /
  advance_quest / submit_quest_choice`（全部 Tool Registry 验证）；**advance_quest 服务器取证**——
  AI 叙事不是事实，无事件证据即拒绝（EVIDENCE_INSUFFICIENT）
- **任务奖励**：复用阶段6 characterService（XP/货币/物品/技能）+ `quest_reward_grants` 幂等；
  验证拒绝无限 XP / 不存在的技能物品
- **版本化**：运行中实例绑定 quest_version，发布新版本不影响进行中任务
- **副本联动**：副本开始自动加载绑定的已发布任务；任务目标由副本事件驱动；通关结算奖励
- **Context**：ACTIVE_QUESTS / QUEST_OBJECTIVES 分区进入 GM 上下文；压缩不影响当前目标（DB 新鲜构建）
- **UI**：QuestPanel（任务/目标进度条/分支按钮/倒计时）+ 任务通知 Toast；Quest Designer/Publish REST

## 数据库变更（005_stage8_quest_system）

`quests` / `quest_versions`（DRAFT/REVIEW/PUBLISHED/ARCHIVED）/ `quest_instances`（+乐观锁 version）/
`quest_participants` / `quest_objectives` / `quest_objective_instances`（+乐观锁）/ `quest_events`
（审计+事件幂等唯一约束）/ `quest_choices` / `game_events`（Event Bus）/ `quest_reward_grants`（幂等）；
种子新增 DOORS 主线任务「逃离多尔斯旅馆」+ 隐藏任务「不要回头」（PUBLISHED）。

## 测试

```
npm test              # 397 项全套件（16+30+41+42+51+65+82+70）
npm run test:stage8   # 仅阶段8（70 项）
```

阶段8 覆盖：生命周期/状态机守卫、单/多/顺序/并行/计数目标、4 种作用域、分支+条件+选择验证、
隐藏任务、时间限制、失败条件、奖励（含幂等/非法奖励/不存在技能物品）、事件幂等、乐观锁并发、
AI 工具全 7 个、AI 作弊拒绝、跨房间隔离、版本化、Context/压缩、3 人 DOORS 完整集成
（进入→找钥匙→开门→隐藏任务→通关→奖励一次结算→断线恢复）。

---

# 阶段9：NPC Relationship & Living World System

NPC 不只是 AI 输出文字——拥有**身份/人格/目标/知识/记忆/情绪/关系/阵营/当前计划**的持久化实体。
行为规则由服务器决定（Event Bus → NPC Listener），AI 只负责描述。

## 核心机制

- **NPC 数据模型**：`npcs`（uid/人格/目标/知识/阵营/位置）+ `npc_instances`（房间/副本实例内，
  state/alive/mood/current_plan，同房间幂等）
- **记忆系统**：`npc_memories`，6 种类型（PLAYER_ACTION/CONVERSATION/EVENT/BETRAYAL/HELP/QUEST），
  importance 0~100；容量上限 100（删最旧低重要度）；**BETRAYAL 与 importance≥60 为隐藏记忆，
  玩家/API 永不可见**（服务器过滤）
- **关系系统**：`npc_relationships`（NPC↔玩家 / NPC↔NPC，-100~100 钳制，SQL 原子累加）；
  类型阈值：敌视 ≤-50 / 陌生 / 认识 / 友好 / 信任 / 盟友 ≥80；
  **固定增量表（服务器拥有）**：help +10 / conversation +2 / deceive -20 / attack -50 / betray -60 / quest_complete +15
  —— AI 只能选动作类型，不能指定数值
- **阵营**：`factions` + `faction_reputation`（±100 钳制，按玩家隔离）；种子：DOORS 幸存者/实体/旅馆管理员
- **NPC Listener**（Game Event Bus）：QUEST_COMPLETED → 房间内 NPC 感恩 +15；NPC_DEAD → 长期世界事件；
  情绪由服务器规则联动（帮助→友好/感激，攻击→恐惧/敌视）
- **NPC 死亡**：`kill_npc`（服务器验证）→ alive=0 + NPC_DEAD（game_events + world_events），死亡 NPC 不可再交互
- **任务门控**（第九节）：quest 定义 `npc_gate {npc, min_relationship}` —— 关系 <50 不给任务，
  ≥50 自动发现激活（幂等）；种子：「旅馆管理员的秘密」
- **NPC_CONTEXT**：GM 上下文新增分区（附近NPC/关系/最近记忆/当前目标/计划）
- **UI**：NPC 面板（头像/关系值与类型/情绪/目标/计划/公开记忆/阵营声望）+ 关系变化 Toast
- **REST**：`GET /api/npcs`（公开视图，断线恢复安全）· `GET /api/npcs/:id`（跨房间 403）· `GET /api/factions`

## 新增 AI Tools（6 个）

`get_npc_status`（READ_ONLY，公开视图）· `talk_to_npc`（+2 固定）· `inspect_npc_memory`（仅公开记忆）·
`npc_relationship_event`（help/deceive/attack/betray/quest_complete，固定增量）·
`update_npc_plan`（仅计划+情绪枚举，**绝不能改关系/记忆/声望**）· `kill_npc`

**安全**：不存在任何直接改关系/声望/记忆的工具；AI 附加的数值参数被忽略；跨房间访问拒绝。

## 测试

```
npm test              # 459 项全套件（16+30+41+42+51+65+82+70+62）
npm run test:stage9   # 仅阶段9（62 项）
```

覆盖：NPC 模型/记忆（类型/隐藏过滤/长度/容量）/关系（固定增量/钳制/类型阈值/并发原子累加）/
阵营声望/Listener 联动/6 工具（含作弊拒绝）/任务门控（<50 隐藏、≥50 激活、幂等）/
NPC_CONTEXT/REST 权限/隐藏记忆防泄漏/无直接修改工具存在性验证。

---

# 阶段10：Legendary Roblox NPC & Creator Mythology System

传奇人物不是管理员/权限账号，而是世界中的特殊存在：独特能力、专属装备、专属任务、专属商店、
副本关联、世界事件影响。

## 核心机制

- **传奇人物**（`legendary_npcs`）：Shedletsky（The Sword Master / LEGEND）、
  Builderman（The Creator / CREATOR）、LSPLASH（Hotel Architect / EXPERIENCE_AUTHOR）；
  origin_type: CREATOR / LEGEND / ADMIN_LEGEND / EXPERIENCE_AUTHOR
- **生成系统**：服务器掷骰（crypto 随机），概率由 副本匹配（DOORS→LSPLASH↑、Sword Fight→Shedletsky↑）/
  world_state / player_level / quest_progress 决定；同房间不重复生成；**AI 无 spawn 工具**
- **能力倍率（Power Adaptation）**：`real_power = base_power × world_multiplier`，
  规则存 `power_rules_json`（Shedletsky：主场 1.0 / 普通世界 0.4 / FORSAKEN 0.2；LSPLASH：DOORS 1.0）；
  倍率只读自数据库，AI 不可修改
- **装备规则**：Shedletsky 普通世界禁用传奇剑 / Sword Fight 解除限制 / FORSAKEN 战利品池
  （Linked Sword 95% / Light Sword 5%，服务器掷骰）
- **传奇商店**（`legendary_shop_items`）：价格 + 条件（关系等级/阵营声望/任务前置）服务器验证；
  购买 = 条件验证 → 扣金币 → 发放 → LEGENDARY_REWARD 事件；UNIQUE 物品不可重复购买（失败回滚扣款）
- **传奇任务**：《失落的第一把剑》(Sword Technique)、《重建世界》(Construction Skill)、
  《酒店最后的秘密》(危险感知)，复用任务系统 + npc_gate 关系门控
- **传奇战斗**：`legendary_battle_action`（attack/defend/flee/skill），服务器掷骰判定，
  LEGENDARY_BATTLE 事件；AI 只描述，不能控制结果
- **怪物本性**（`npcs.nature`）：hostile NPC（实体/怪物）好感度只记录、**不改变敌对情绪、不解锁任务**
- **事件**：LEGENDARY_NPC_FOUND / LEGENDARY_DIALOG / LEGENDARY_REWARD / LEGENDARY_BATTLE / LEGENDARY_LEAVE
- **Context**：LEGENDARY_NPC_CONTEXT 分区（身份/称号/来源/稀有度/能力/当前战力与倍率/关系/目标）
- **UI**：顶栏紧凑化（两行工具栏）+「⭐ 传奇」面板（传奇卡片 + 商店 + 购买）；
  NPC 面板显示怪物标记「（怪物·好感无效）」

## 新增 AI Tools（5 个）

`get_legendary_status`（READ_ONLY：身份/能力/倍率/关系）· `legendary_dialog`（+2 固定）·
`buy_legendary_item`（服务器验证购买）· `legendary_battle_action`（服务器掷骰）·
`get_legendary_shop`（READ_ONLY：可购买状态）。**无 spawn / 无倍率修改 / 无直接发放工具**。

## 测试

```
npm test               # 541 项全套件（16+30+41+42+51+65+82+70+62+82）
npm run test:stage10   # 仅阶段10（82 项）
```

覆盖：生成概率/副本匹配/能力削弱/装备限制/商店权限与购买流程/关系复用/传奇任务/战斗动作/
怪物好感无效/LEGENDARY 五事件/多人同步/断线恢复/UNIQUE 购买幂等/跨房间隔离/
AI 作弊拒绝（无 spawn/无倍率修改/无直接发放/不存在传奇拒绝）。
