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

---

# 阶段11：Legendary NPC Encounter & Cross Experience Reward System

朋友间的 TRPG（非 MMO）：玩家冒险中随机遇到特殊传奇 NPC（创作者/游戏作者/传奇人物），
战斗奖励随机池、永久物品跨副本保留、跨体验装备削弱、剑斗完成度奖励。

## 核心机制

- **遭遇判定**（`encounterCheck`，服务器掷骰）：概率 = 基础遭遇率 × 副本匹配（DOORS→LSPLASH↑、
  Sword Fight→Shedletsky↑）× 幸运属性 × 任务进度 × 剧情状态；副本开始自动判定
  （`NPC_ENCOUNTER_CHECK` + `LEGENDARY_NPC_FOUND` 事件）；同房间不重复生成
- **战斗奖励池**（随机，非固定）：指导（技能+1）/ 技能 / 物品（该体验真实物品随机）/
  知识（世界信息标志）/ 货币 / 剧情分支——加权随机选择 + 条目数据库验证（禁止编造）+
  幂等（同玩家同传奇同实例一次）；Builderman 为商店型（奖励池为空）
- **永久物品**（`permanent_items`）：获得后永久保存（UNIQUE player+item），跨副本保留
- **跨副本削弱**（`item_balance_rules`）：SFOTH 传奇剑在 DOORS ×0.2（100→20）、
  FORSAKEN ×0.3；主场 ×1.0；无规则默认不削弱；服务器计算（AI 不可修改）
- **体验物品数据库**（`experience_items`）：SFOTH 真实剑库（Linked Sword/Fire Sword/
  Ice Dagger/Darkheart/Venoms Edge/Illumina/Ghostwalker），资料不足标记 `UNKNOWN`；
  AI 禁止创造剑（无创建工具，只读工具）
- **剑斗完成度奖励**：`completion_score` = 任务完成(30) + 战斗表现(30) + 探索(20) +
  生存(20-死亡×5) + 任务(10)；档位 20% 基础 / 50% 稀有 / 80% 史诗 / 100% 传奇；
  奖励剑必须来自该副本真实剑列表；低评分无奖励；幂等
- **表现追踪**（`instance_performance`）：Game Event Bus 监听 PLAYER_DIED /
  ENEMY_DEFEATED / PLAYER_ENTERED_SCENE / QUEST_COMPLETED 自动记录
- **Context**：`PLAYER_LEGENDARY_ITEMS` 分区（永久物品 + 跨副本有效强度倍率）
- **安全**：无发放永久装备工具 / 无修改价格工具 / 无修改平衡规则工具 / 无创造剑工具；
  奖励池条目全部数据库验证

## 数据库变化（008_stage11）

`legendary_npcs` + encounter_rules_json/creator_type/avatar_asset；
新表：`permanent_items` / `item_balance_rules` / `experience_items` / `instance_performance`；
`reward_grants.instance_id` 放宽可空（传奇奖励不绑定副本实例，表重建迁移）

## 新增 Tool（4 个）

`get_permanent_items`（READ_ONLY：永久物品+削弱倍率）· `get_item_power`（READ_ONLY：有效强度）·
`get_experience_swords`（READ_ONLY：体验真实剑列表）· `request_combat_reward`（GAME_ACTION：
战斗胜利奖励，服务器随机+验证+幂等）

## 测试

```
npm test               # 597 项全套件（16+30+41+42+51+65+82+70+62+82+56）
npm run test:stage11   # 仅阶段11（56 项）
```

覆盖：遭遇判定/幂等/奖励池随机与验证/Builderman商店/永久物品/跨副本削弱/
剑数据库验证/剑斗完成度奖励档位与幂等/Context显示/AI作弊拒绝（无发放/改价/改规则/造剑工具）。

---

# 阶段19：Civilian Ability Lore Integration（Die of Death）

让 AI GM 理解 DOD 世界中 Civilian【为什么】拥有这些 Ability。这是 Lore 解释层，
**不是游戏技能系统**：不实现 Cooldown/Damage/HP/SP/战斗数值/技能UI。

## 核心规则

- **Ability 不是魔法**：Ability 代表 Civilian 过去的人生经历 —— 解释"为什么拥有"，绝不解释为
  "获得技能/魔法/超能力/凭空召唤"。例：Punch=优秀身体素质（格斗训练/体育经历/长期锻炼）；
  Caretaker=医疗知识+照顾他人的经验；Revolver=枪械训练/射击经验/安全职业背景；
  BonusPad=工程能力/建筑经验/创造辅助工具
- **Background → Ability 权重**：Engineer→BonusPad/Block、Medic→Caretaker、Athlete→Punch/Dash、
  Security→Revolver/Block、Cook→Hotdog/Pie。只是概率提高（关联 3 / 其余 1），**不是固定绑定**：
  任何 Civilian 都可能获得任何 Ability（无职业锁定）
- **Trait 解释**：每个 Ability 由 Trait 解释出现原因 —— Caretaker ← Medical Knowledge/Empathy/
  First Aid Experience；Revolver ← Weapon Familiarity/Marksmanship
- **Synergy 预留**：只保存候选（BonusPad: Caretaker→CarePad；Revolver: Caretaker→Loveshot），
  不实现任何 Synergy 逻辑（Loveshot 不入技能库、不触发检测）

## 数据库变化（016_stage19）

新表 `dod_abilities_lore`：`id/name/source(DIE_OF_DEATH)/category/core_trait/explaining_traits/
possible_background/lore_description/personality_connection/synergy_candidates/synergy_result_of`
（全设定解释字段，无任何战斗数值列；幂等播种，10 条 = 8 基础 Ability + 2 Synergy 结果登记）

## AI Context

`DOD_CIVILIAN_CONTEXT` 分区升级：每个玩家输出
`Background: / Traits: / Abilities: / Lore Explanation: / Life Experience:`，
其中 Lore Explanation 为因果解释（如"该居民过去拥有建筑经验，因此能够制作临时辅助设施。"），
非关联 Ability 附"无固定绑定：任何背景的居民都可能拥有这种经历"说明；
SYSTEM_RULES 新增纪律（Ability=人生经历、禁魔法描述、无职业绑定）。

## REST（只读）

`GET /api/dod/abilities/lore`（会话校验）—— Ability Lore 数据库（解释规则 + 全部条目）

## 测试

```
npm test               # 1211 项全套件（…+62）
npm run test:stage19   # 仅阶段19（62 项）
```

覆盖：Lore 读取（幂等/字段/未知返回空）/ 解释规则（四例官方解释 + 全库无魔法描述）/
Background 关联（权重 3/1、同种子对比、统计 120 种子、Cook 也能获得 BonusPad）/
Trait 解释（与阶段18 亲和一致）/ AI Context（格式四段 + 因果解释 + 无魔法 + 无锁定）/
Synergy 预留（候选保存、逻辑未新增、Loveshot 不触发）/ 边界（无数值字段、无技能UI、REST 401）。

## 阶段19 增补：Flashlight 官方 Library 集成

- **新增 Ability**：`Flashlight`（category `exploration`）—— Lore 数据库第 11 条。
  官方 Library：Flashlight 居民来自 wide variety of backgrounds，多数热爱徒步与探索（hiking/exploration），
  不少是向导（tour guides）或户外工作者，偶有技工/水管工；方向感极佳、擅长指引他人，
  是队伍中的**导航者与组织者**（not exactly fighters，不是战斗人员/领袖）。
- **Trait 增补**（官方 Library）：`Outdoor Experience`（徒步/户外经历）、`Navigation`（方向感/引路）
  —— Trait 池 7→9；Flashlight 的 core_trait = Outdoor Experience。
- **背景关联**：`possible_background = []`（官方"wide variety of backgrounds"→ 所有背景权重 1，
  彻底无职业锁定的典型样本）。
- **library_excerpt 列**（迁移 017）：保存官方 Library 原文（CANON）——仅背景/性格设定；
  **使用机制（光锥/减速/闪光/治疗/Points 等数值）不实现、不入库**（无 Cooldown/Damage/HP/SP 红线）。
- **Lore 项边界**：Flashlight 不入 Ability 发放目录（`ABILITY_CATALOG`）、不播种为技能 ——
  仅用于 AI GM 理解"居民为什么带手电"（徒步/探索/向导的生活习惯）。
- 测试：62→72 项（新增 Flashlight 专节 63-72：读取/背景无关/Trait 解释/无数值/Context 渲染）；
  全套 1221 项通过。

## 阶段19 增补二：官方 Library 合集全量集成（2026-08-28）

**dod_abilities_lore 11 → 18 条**（14 基础 + 4 官方 Synergy 结果登记）：

- **新增 5 项基础 Ability**（官方 Library Traits 段全量入库）：
  `Adrenaline`（mobility——受惊即逃的反应与体能；官方：普通背景普通工作，无背景锁定）、
  `Banana Peel`（trap——捣蛋鬼与"喜剧效果香蕉皮"小装置；与 Bugle 同有表演/戏剧背景）、
  `Cloak`（stealth——实验性政府科技斗篷；与 BonusPad 居民共同研究、近距离观察野生动物）、
  `Taunt`（disruption——挑衅者与"恶作剧"媒体频道；无背景锁定）、
  `Bugle`（morale——士气领袖；所有人保持理智的基石，与 Banana Peel 最投缘）
- **新增 2 项官方 Synergy 结果登记**：`SweetTooth`（Hotdog + Pie）、`Noisemaker`（Taunt + Bugle）
  ——官方 Synergy 表四条（CarePad/Loveshot/SweetTooth/Noisemaker）全部只登记、不实现逻辑；
  Banana Peel 备注的 `Showtime`（与 Artful）仅存候选（Artful 无 Library 数据，不入目录）
- **既有 8 项全部升级官方 Library**：Punch（街头/不良少年成长）、Caretaker（分流抉择/最怕粗心）、
  Revolver（退伍军人/警官/射击场）、Hotdog（被误解的贪吃者/惊人职业道德）、Pie（糕点师/美食家）、
  BonusPad（协调者/把弱点转为优势）、Dash（最接地气/与 Adrenaline 赛跑）、Block（盔甲下的和蔼老兵）
- **Artist 获得关联 Ability**：Banana Peel / Bugle（官方 Library："他们都有表演或戏剧的背景"）——
  权重 3，其余背景仍 1（无职业锁定）；Adrenaline/Cloak/Taunt/Flashlight 保持全背景等权
- **居民间官方关系**入 `personality_connection`（Adrenaline↔Dash/Block、讨厌 BananaPeel/Taunt；
  Block↔Punch/Caretaker；Revolver↔Block/BonusPad/Caretaker；Pie↔Hotdog；Bugle↔BananaPeel 等）
  供 GM 叙事邻里关系
- **library_excerpt 收录纪律**：只存官方 Library 的 **Traits（性格/背景）段**——
  Functionality 段的全部使用机制（速度/秒数/伤害/治疗/得分/任务）与战斗数值一律不入库
  （测试守护：全库 excerpt/lore/personality 无任何数字与机制词）
- 跨世界解释（`interpretAbility`）覆盖全部 18 项；Trait 池保持 9 项（未新增）；
  新增五项均为 **Lore 项**：不入 ABILITY_CATALOG 发放目录、不播种技能
- 测试：72→**88 项**（新增官方 Library 全量专节 73-88）；全套 **1237 项**通过

---

# 阶段20：Civilian Background & Personality Simulation + 阵营关系去写死

## 阵营关系修复（不再写死于 seed）

- 移除 `seed.sql` 中硬编码的 DOORS 初始关系（幸存者↔实体=HOSTILE、幸存者↔管理员=NEUTRAL）
- 初始关系改由**各预设 JSON 声明**：`faction_relations`（按阵营名或 uid 后缀定位，限本预设副本范围），
  由 presetSeeder 导入时幂等落库（`factionRelations.ensureInitialRelation`：仅该对无关系行时插入，
  静默无事件；运行期改动如 FACTION_WAR 永不被重复导入覆盖）
- DOD 预设声明：`Civilian↔Killer=HOSTILE`（Killers 猎杀居民，天生敌对）、`Civilian↔Government=NEUTRAL`（观望）；
  `dodCivilian.ensureSeeded` 同步播种 `Robloxia Citizens` 的对应关系
- stage12 断言不变（来源改为预设导入）；官方定义物化版本号与测试夹具冲突已调（900→901）

## Civilian Background & Personality Simulation

- **`civilian_background_profiles` 表**（迁移 018）：`id / background_type / description /
  possible_traits / possible_abilities / personality_patterns`（+source）；幂等播种 6 档案
  （Engineer/Medic/Athlete/Security/Cook/Artist——Artist 为官方背景池补全，关联表演系 Ability）
- **Background = 人生经历，不是职业**（无职业等级/职业技能树/职业装备）：
  Engineer=机械/建筑/创造经验、Medic=医疗/护理/助人经验（**护士/医生/志愿者/照顾家人**——
  1 Ability ≠ 1 职业）、Athlete=体育训练、Security=安全/防卫/危险环境、Cook=料理经验
- **Trait 生成**（Trait 不是技能：人格/经历/知识，不入 skills 表）：主特点来自背景档案，
  次特点从全档案并集随机（`civilian_instance.profile_traits`）
- **Personality 生成**：官方六词池 `Brave/Careful/Selfless/Practical/Creative/Nervous`
  （`civilian_instance.personality`）；主人格来自背景倾向——只影响 GM 叙事、NPC 互动、
  剧情选择，绝不改变属性数值
- **Ability 解释**：`gmAbilityPhrasing` 第二人称句式（"你过去接受过医疗训练，因此你知道如何处理伤员"）；
  SYSTEM_RULES 明令禁止"你获得了X技能"句式
- **Ability → Background 推断**（`inferBackgroundFromAbilities`）：Lore 关联 +2/项、
  档案命中 +1/项，返回全部候选排序——仅为推断，注明不构成职业绑定
- **随机生成流**：进入 DOD → Background → Traits（官方 + 档案）→ Personality → Ability 解释
  （`generateCivilianLore` 一并写入新列）
- **`CIVILIAN_PROFILE_CONTEXT`** 新分区：`Background: / Traits: / Personality: /
  Life Experience: / Ability Explanation: / Survival Lore: / Inferred Background:` + 用语纪律
- **REST（只读）**：`GET /api/dod/civilian/profile`、`GET /api/dod/backgrounds`
- 测试：新增阶段20（66 项：档案库/定义内容/Trait与Personality生成随机性/推断/生成流/
  Context 格式/无职业系统边界/阵营关系预设化与幂等）；全套 **1303 项**通过

---

# 阶段21：Civilian Identity Presentation System + NPC 修复

## Civilian Identity Presentation（外观表现档案）

- **`civilian_identity_profile` 表**（迁移 019）：`appearance_traits / clothing_style /
  visual_markers / personality_expression / ability_signatures`（每玩家单行；无属性/装备槽字段）
- **外观不是装备**：Ability 反映人生经历——Caretaker→医疗相关物品/干净服饰/急救用品=医疗背景；
  BonusPad→工程工具/建筑用品/工作服=建造工程经验；Revolver→射击相关装备/安全人员风格=枪械训练
  （全部 14 项 Ability 均有 visual/lore/观察语/人格倾向；无数值/无穿戴加成，非皮肤系统）
- **穿着风格**来自 Background（Engineer 工作服、Medic 干净便装、Cook 围裙…）；
  **人格外向表现**覆盖六词池（Brave→遇险向前半步…）；**Ability 影响人格倾向**
  （Caretaker→Selfless/Calm/Protective；Punch→Confident/Aggressive/Competitive；
  Cloak→Careful/Secretive/Avoidant——只影响举止神态，不改变能力）
- **NPC 识别纪律**：NPC（与玩家）不能直呼 Ability 名称（"你是Caretaker玩家"错误）；
  只能观察推测（"你的医疗经验看起来很明显。"）——每项 Ability 附 NPC观察提示
- **生成流**：Background → Traits → Ability → Appearance → Personality
  （`generateCivilianLore` 自动落库；旧身份 `ensureIdentityProfile` 幂等补建）
- **`CIVILIAN_IDENTITY_CONTEXT`** 新分区：Background:/Traits:/Ability:（仅GM可见）/
  Appearance:/Personality:/NPC观察提示 + 三条规则（外观≠装备/NPC识别/无英雄化）
- **REST**：`GET /api/dod/civilian/identity`

## NPC 修复

1. **进入副本不再显示其他副本的 NPC**：`startInstance` 调用 `cleanupRoomNpcs(roomId, instanceId)`
   ——删除绑定其他副本实例的 `npc_instances` 与旧 NPC 名册记忆；世界级 NPC（未绑定实例，如世界模拟传奇）保留
2. **AI GM 不能创建 NPC**：`memory_update.kind='npc'` 在 structuredOutput 降级为 `important_event`
   （相遇记录保留为记忆）；`persistGmOutcome` 白名单写入（无 npc kind）；输出格式文档移除 npc 枚举；
   **NPC_STATE 名册唯一来源 = 服务器 `npc_instances`**（不再读 AI 可写的 room_memories）；
   SYSTEM_RULES 明令"你不能凭叙事创建 NPC"

## 测试

- 新增阶段21（76 项：外观映射/背景一致性/人格倾向与表现/NPC观察/生成流/Context/限制/
  NPC 两项修复/REST/确定性映射）
- 阶段18 红线正则收窄为"竞技玩法"实现语义（人格形容词 Competitive 不再误伤）
- 全套 **1379 项**通过

---

# 阶段22：Die of Death World Lore Foundation + 四项修复

## 世界背景数据库（只做 Lore，不做玩法）

- **`experience_world_profiles` 表**（迁移 020）：name/description/setting/era/factions/
  known_threats/civilian_life/world_rules/government（全部为 Lore 数据，无玩法字段）
- **Die of Death World**：Robloxia——一个由普通居民组成的世界（普通市民/工作人员/研究人员/
  建设者/商人），大多数人没有战斗能力
- **Civilian Society**：城市/住宅区/商业区域/公共设施/工作场所；Civilian 不是战士，
  只是拥有不同人生经验的人
- **Threat Concept**：Killer 只作世界威胁概念（某些异常存在会攻击居民；居民需逃离/隐藏/
  合作/利用自身能力生存）；登记官方已知威胁存在（Pursuer/Badware/Artful/Killdroid/Harken）
  仅概念与动机——**不实现 Killer AI/战斗/副本流程/地图/任务**，无任何数值
- **Government 预留 Lore 接口**：name/description/public_information（建造安全地堡等公开事实）/
  secret_information（`reserved`，本阶段不创建具体剧情）
- **DOD World Rules 五条**：能力来自自身经历；普通居民不是英雄；生存优先于战斗；
  能力不能违反世界逻辑；AI 剧情必须符合普通人视角（入 SYSTEM_RULES，禁止原创世界设定）
- **`WORLD_LORE_CONTEXT`** 新分区：World:/Setting:/Era:/Civilian Society:/Threat:/Government:/
  World Rules + Active Civilians（背景→生活场所关联）；非 DOD 世界不输出
- 预设 `dod.json` 新增 `world_lore` 块；导入自动播种（幂等，lore_source=CANON）

## 修复

1. **阵营关系跨世界泄露**：`worldSnapshot` 按"房间当前副本"过滤关系
   （`roomFactionScope`：当前副本阵营 + 世界级阵营；未进副本→仅世界级）——
   DOORS 的 幸存者↔实体/旅馆管理员 不再出现在 DOD 房间（反之亦然）
2. **关系不再写死**：新 AI 工具 `request_faction_relation_change`（HOSTILE/NEUTRAL/ALLIED）——
   服务器三重验证（阵营存在/属当前世界/必填剧情理由）→ 走唯一写入口
   `setFactionRelation`（Event Bus + 审计）；AI 不能直接写库、不能凭空创建阵营、不能跨世界操作
3. **副本可停止**：`POST /api/dungeon-instances/:id/stop`（队伍成员；ABORTED + 实例事件 +
   DUNGEON_ABORTED 广播；幂等）；前端 Dungeon Runtime 新增"停止副本"按钮
4. **所有 LLM 调用点具备 websearch**：GM 聊天/副本运行时/Agent 循环（原有）+
   `summarizeHistory` 与 Dungeon Designer 经 `searchEnabledChat`（仅放行 web_search/roblox_search，
   预算内搜索轮；无工具调用时行为与从前一致）；视觉图像路径显式 `LLM_NO_TOOLS` 标注

## 测试

- 新增阶段22（68 项：World 加载/官方 Lore 内容/Government 预留/World Rules/Context/
  Civilian 关联/不原创设定/不提前生成 Killer/关系作用域与 AI 工具/停止副本/websearch 全覆盖）
- 全套 **1447 项**通过

---

# 阶段23：Civilian Ability Relationship System（Synergy Lore System）

## Synergy Lore（不是技能组合/装备/升级系统）

- **定义**：Civilian 拥有多个高度相关能力时，这些能力会产生特殊使用方式——
  Synergy 是"对自身经验的极致结合"，不是新职业/超能力/等级提升，更不是技能树
- **`ability_synergies` 表**（迁移 021）：id / name / source_abilities / changed_ability /
  lore_explanation / trait_requirements（无任何数值/等级/解锁字段）；
  `civilian_instance.synergies` 保存每玩家已形成的 Synergy（Lore 状态）
- **官方 Canon 目录**（只此 2 条，不创造新 Synergy）：
  - **CarePad** = BonusPad + Caretaker → 改变 **BonusPad**：同时拥有工程经验与医疗经验的
    Civilian，不只建造辅助设施，而是将设施改造成帮助幸存者恢复的工具
  - **Loveshot** = Revolver + Caretaker → 改变 **Revolver**：同时拥有枪械经验与医疗经验的
    Civilian，攻击方式不再只是伤害，而是结合保护和救援理念
- **生成流**：Background → Traits → Abilities → **检查 Synergy**
  （`generateCivilianLore` 内置第 4 步；`checkAndSaveSynergies` 幂等；组合 ≥2 项来源能力才可命中）
- **AI 描述规则**：禁止"你升级成CarePad/你获得了X"——按经验结合描述：
  "你的医疗知识和工程经验结合，让你的设备拥有了新的用途。"（每条 Synergy 附 GM 描述示例）
- **`SYNERGY_LORE_CONTEXT`** 新分区：定义 + 规则 + 房间内每位已形成 Synergy 居民
  （组合来源 → 改变的能力 + Lore 解释 + 描述示例）；未形成者不出现
- **不发技能**：检测不写 player_skills、不发新能力——只"改变"既有 Ability 的使用方式
- **REST**：`GET /api/dod/synergies`（官方目录 + mine）；`/api/dod/civilian` 视图携带 synergies
- 预设 `dod.json` 新增 `synergy_lore` 块；导入自动播种（幂等，lore_source=CANON）

## 测试

- 新增阶段23（62 项：表结构与官方目录/组合检测/不会生成不存在组合（含脏数据加固）/
  生成流第4步/Lore 解释/描述规则/SYNERGY_LORE_CONTEXT/REST/限制边界）
- 全套 **1509 项**通过

---

# 阶段25：后端 Admin Web UI + Lore 补全（政府/杀手）+ 威胁互动 + 全技能化 + 传奇商店修复

## 后端管理 Web UI（/admin）

- **`GET /admin`**：纯 HTML 管理页（无构建步骤）：AI API 一键配置（Base URL/Key/模型/格式/超时/流式，
  含 OpenAI/DeepSeek/Anthropic/OpenRouter/Gemini 一键填入预设与"测试连接"）+ **Context 上限**（tokens）
- **`system_settings` 表**（迁移 025）：白名单键值持久化；优先级 DB 设置 > 环境变量 > 默认值；
  `ai.context_budget` 即时改变 `contextCompressor.budget()`；`ai.base_url/ai.model/ai.api_key/ai.api_format/
  ai.timeout_ms/ai.stream` 即时改变 `getAiRuntimeConfig()` 与流式开关
- **REST**：`GET/POST /api/admin/settings`（密钥打码）、`POST /api/admin/ai/test`（GET {base}/models 连通性）；
  可选 `ADMIN_TOKEN` 环境变量鉴权

## Lore 补全（官方 Wiki 输入；无数值入库）

- **政府**：现任总统 Cobalt / 前任 Sulfur（Killdroid 设计者）；地堡（管理员 Blackiron、剧院/花园/餐厅/
  街机厅/中央传送门、备用发电机、员工名录）；外部世界为废土（Wrenchboy）；Toolbox（能创造生命的机器）
  与 T.A.S.F 设施；对 Harken 监视+音频诱饵、对 Pursuer 追踪芯片失败+拟态研究意向
- **五杀手详细 Lore**（known_entities：origin/appearance/behavior/government_response/counter_hint）：
  Pursuer（Lily Meadow 迷宫森林/锯齿剑/骨骼重组拟态/厌恶水）、Badware（蜂巢意识/夺控机械）、
  Artful（Jean "Degaré" Fromage/墙/音乐盒/傀儡不耐用）、Killdroid（Sulfur 设计/量产搁置）、
  Harken（噪音=死亡的异次元构造体/父母与挚友/回声定位）+ 杀手动向与官方代词备注

## 威胁互动（Ability × Threat 官方对策；`ability_threat_interactions` 表）

- **Flashlight × Pursuer**：强光直照隐行中的 Pursuer → **立即现形并僵直**（拟态被锁定；flags:
  reveal_stealth/stun/requires_stealth）
- 水 × Pursuer：驱退（为避水放弃追猎）；噪音（Bugle/Taunt 别名）× Harken：吸引+加速激怒；
  持续压力 × Artful：召唤物碎裂；远离机械 × Badware：避免设备倒戈
- **`THREAT_INTERACTION_CONTEXT`** 新分区：按房间居民持有能力列出对策；SYSTEM_RULES 要求 GM
  按登记效果叙述、不得发明库外互动；`GET /api/dod/interactions?ability=&threat=`

## 所有 Ability 都算技能（阶段25 指令）

- Fate 池恢复为**全部 14 项基础 Ability**（Flashlight/Adrenaline/Banana Peel/Cloak/Taunt/Bugle 全部
  可发放、播种 `dod_fate_ability` 标记）；Artist 高概率恢复 Banana Peel/Bugle；effect_data 仍无任何数值

## 传奇商店修复

- 前端 LegendPanel 此前读取 `s.item/s.rarity`（后端返回 `item_name/item_rarity`）→ 商品名为空、
  只剩价格与购买按钮；已改为渲染 `item_name/item_rarity`，购买携带正确 `itemName`

## 测试

- 新增阶段25（56 项：Admin UI/设置优先级与白名单/连接测试、政府与五杀手 Lore、威胁互动与
  Flashlight×Pursuer 特殊效果、全技能化、商店修复）
- 全套 **1625 项**通过

---

# 阶段26：Admin Web UI 扩展（Vision 配置 UI + 服务器管理）

## Vision API 配置 UI（此前只能改环境变量）

- **Vision 卡片**：Base URL / API Key / 模型 / 超时（DeepSeek、OpenAI 兼容一键填入）+ 测试连接
  （GET `{base}/models`）；`getVisionRuntimeConfig` 读取顺序 DB 设置 > env
- 设置键：`vision.base_url / vision.api_key / vision.model / vision.timeout_ms`

## Web 搜索配置 UI

- **搜索卡片**：Provider（null/serper）+ Serper API Key + 测试搜索（真实查询 "roblox"）；
  `getSearchProvider` 调用时读取 DB 设置（配置即时生效，无需重启）；设置键 `search.provider /
  search.serper_api_key`；null provider 明确 SEARCH_UNAVAILABLE，不编造结果

## 服务器管理卡片

- **GET /api/admin/status**：uptime / Node 版本 / 内存 / DB 大小 / 玩家·房间·副本·事件·技能计数 /
  世界调度器状态 / 配置概览（AI·Vision·搜索 Key 是否已配置）
- **世界模拟开关**：`POST /api/admin/world/pause|resume`（对应 worldSim 调度器）
- **预设重导入**：`POST /api/admin/presets/reimport`（幂等；5 个官方预设）
- **最近游戏事件**：`GET /api/admin/events?limit=`（Live 日志面板，自动展示最近 20 条）

## 修复

- `visionProvider`/`SearchProvider` 的设置层 require 路径深度错误（`../../` → `../`，此前静默回落 env）

## 测试

- 新增阶段26（34 项：Vision/搜索 DB>env 与回落、REST 保存与测试、status/events、世界开关、
  预设重导入幂等、UI 卡片、白名单与打码）
- 全套 **1659 项**通过

---

# 阶段27：Web 搜索多 Provider（bing/brave/tavily/duckduckgo 等）

- **6 种 Provider**：`null`（默认，明确 SEARCH_UNAVAILABLE 不编造）/ `serper`（Google 搜索 API）/
  **`bing`**（Microsoft Bing Web Search v7，Ocp-Apim-Subscription-Key）/
  **`brave`**（Brave Search API，X-Subscription-Token）/
  **`tavily`**（Tavily Search API，LLM 友好搜索）/
  **`duckduckgo`**（**免 Key**，HTML 端点解析：uddg 重定向解码 + 实体/标签清理）
- 结果统一归一化为 `{title, link, snippet, source:'web_search'}`——`web_search` 工具与既有
  UNTRUSTED_EXTERNAL_DATA 围栏零改动兼容；来源 URL 全部来自 Provider（编号引用，AI 不得伪造）
- **配置即时生效**（调用时读取：DB 设置 > env `BING_API_KEY/BRAVE_API_KEY/TAVILY_API_KEY`）；
  缺 Key 的 Provider 回落 NullSearchProvider（不产生半可用状态）
- **Admin UI**：下拉列出全部 Provider；按选择动态切换 Key 输入标签（含各 Provider 鉴权头说明），
  免 Key Provider 自动隐藏 Key 框；状态卡片显示各 Provider Key 配置概览（打码）
- 各 Provider 支持构造器注入 BaseUrl（本地 mock 测试请求构造与响应解析）

## 测试

- 新增阶段27（36 项：Provider 解析与 Key 优先级、adminView 概览、六个 Provider 的请求头/body
  构造与结果归一化（mock 服务）、DDG 解析单元、web_search 工具链路、REST/UI）
- 全套 **1695 项**通过

---

# 阶段28：Die of Death Lore 全量核对补全（杀手称号/台词/细节 + Synergy 大师设定）

对照 2026-08-28 官方 Wiki 输入逐条核对阶段25 已入库内容，补齐缺口：

- **杀手称号（title）与游戏内台词（quote）**：Pursuer 执着的（The Persistent）/ Badware 零号病人
  （Patient Zero）/ Artful 法国魔术师 / Killdroid 失控的保镖原型 / Harken 噪音猎人；五段游戏内
  描述台词原文入库（"…already too late."、"Your computer seems to have been infected! ;)"、
  "VANISH!"、"BLAST TARGET TO SMITHEREENS."、"A beautiful view."）
- **Pursuer**：隐形时身体僵硬、威胁性降低（可完全不被察觉地跟随，对策提示同步）；多种起源传说
  （稀有物种/突变科学家/外星人）；植入芯片失败后多数科学家认为难以驯服；嚎叫近处者头晕
- **Badware**：并不特别针对平民、但绝不让人阻止感染（驱逐阻碍者）
- **Artful**：事故起因两类说法（观众起哄过多/私下经历）；音乐盒可反转为给自己加速
- **Harken**：父母为其设计一切工具（其构造体类型无法长期存活）；纠缠手法=追忆父亲（对抗水栖
  构造体彩蛋）；挚友制陶花瓶细节与"形影不离"；驱赶平民并非敌意
- **Synergy 官方大师设定**：拥有 Synergy 的居民是其领域的大师、被赋予更强的工具——任何特质
  相符的居民都可成为协同者（入世界档案 civilian_life.synergy 与 SYNERGY_LORE_CONTEXT：
  按"经验造诣"叙述，非系统升级）
- **WORLD_LORE_CONTEXT** 新增 Known Threats 行：杀手称号+官方代词（GM 叙事称呼用）
- 预设 dod.json 镜像同步（killer_titles / civilian_synergy）；红线不变：无属性/技能数值表

## 测试

- 新增阶段28（30 项）；全套 **1725 项**通过

---

# 阶段29：AI/Vision 网关响应加固（HTML 诊断）+ 测试端点真实链路探测

## 问题：run action 报 `SyntaxError: Unexpected token '<', "<!DOCTYPE "...`

OpenAI 兼容网关（如 api.inferaiapi.com）对错误路径/缺 `/v1` 的 Base URL 返回 **HTML 页面**，
而 `postJson`/`visionPostJson` 直接 `res.json()` → 裸 SyntaxError。

修复：

- **postJson / visionPostJson / OpenAIProvider 流式分支**：先读文本再解析——HTML（`<!DOCTYPE`/
  `<html`）→ `bad_base_url` 错误并提示"检查 Base URL 是否缺少 /v1（端点应为 {Base URL}/chat/
  completions）"；坏 JSON → `bad_format` 带响应片段；空响应 → 明确报错；非 2xx 附带服务端
  错误细节（如 model overloaded）
- **/api/admin/ai/test 与 /api/admin/vision/test 升级**：从 `GET /models`（很多网关不支持）
  改为**真实链路探测**——`POST {base}/chat/completions`（`max_tokens:1`，与游戏内 run action
  完全同一路径），HTML/非 JSON 同样给出 Base URL 诊断
- **Admin UI**：Vision 卡片新增"一键填入：InferAI（api.inferaiapi.com/v1 + gemini-3.7-flash）"
  预设（AI 卡片预设由后端下发，已含 inferai）
- Vision 请求格式与用户验证的 PowerShell 示例一致（OpenAI 兼容 image_url + data:image/png;base64）

## 测试

- 新增阶段29（26 项：parseJsonBody 单元/postJson 与流式 HTML 诊断/Vision 同链路/测试端点
  真实探测与错误透传/InferAI 预设/回归）
- 全套 **1751 项**通过

---

# 阶段29（续）：融合用户 InferAI 修复 + ai-test 实测页端点

用户提交（3689b46/00a82a2/0a80d3c）与阶段29 加固合并：

- **`buildVisionChatUrl`**：Base URL 自动补 `/v1`（`https://api.inferaiapi.com` → `.../v1/chat/
  completions`；已含 /v1 或自定义路径保持不变）——deepseekVision 真实分析端点采用
- **express JSON 体上限 25MB**（`JSON_BODY_LIMIT` 可覆盖）+ **JSON 错误中间件**：请求体过大/
  JSON 损坏返回 JSON 错误（REQUEST_ENTITY_TOO_LARGE/INVALID_JSON），不再返回 HTML 页
- **`/admin/ai-test.html` 实测页端点补齐**（此前 404→HTML 即 `Unexpected token '<'` 来源）：
  - `GET /api/admin/ai-test/config` —— 配置概览
  - `POST /api/admin/ai-test/text` —— 真实 AI 对话链路（与 run action 同路），返回完整网关响应
  - `POST /api/admin/ai-test/vision` —— 真实 Vision 链路（支持 data:image/png;base64 本地图；
    经 buildVisionChatUrl 自动补 /v1）
- Vision 请求体与用户 PowerShell 验证格式一致（OpenAI 兼容 image_url + base64 data URL）

全套 **1762 项**通过（阶段29 扩至 37 项）

---

# 阶段30：绑定固定 R6 + Vision 全链路日志

## 绑定固定 R6、区分 R6/R15

- 官方缩略图端点带 `thumbnailFormat=r6 / r15` 参数：**绑定统一取 R6 渲染**（经典六部件体型），
  R15 渲染同时保存作对照；R6 不可用（Blocked）时回落 R15
- `roblox_profiles` 新列：`fullbody_r6_url / fullbody_r15_url / avatar_type`；
  `avatar_type` 经 `avatar.roblox.com/v1/users/{id}/avatar` 探测用户**实际体型**（R6/R15）
- `getUserThumbnails` 返回 `{ headshot, fullbodyR6, fullbodyR15, fullbody }`（fullbody=R6 优先）

## Vision 全链路日志（AI 真实输出 + 服务器输出）

- **控制台**（每次分析四段）：`[vision] 请求（端点/模型/图片）` → `[vision] 模型回复原文` →
  `[vision] 解析后 JSON` → `[vision] 服务器验证（接受/拒绝 tags·技能）` → `[vision] 最终数值（attributes+技能）`
- **vision_analysis_log 新列**：`raw_response`（网关完整响应+模型文本+解析 JSON）、
  `request_meta`（端点/模型，不含密钥）、`image_url`
- **GET /api/admin/vision-logs?limit=**：日志查询 API
- **管理页新面板「Vision 分析日志」**：AI 原始输出 / 服务器验证 / 最终数值逐条展示——
  "绑定什么都默认数值"一类问题可直接看到：AI 认出了什么 tags、服务器接受了哪些、最终属性如何计算
- `/api/admin/ai-test/vision` 现返回 `rawText`（模型原文）/ `gatewayResponse`（网关完整响应）/
  `request`（请求元数据）
- 日志写入失败不再静默（控制台报错）

## 测试

- 新增阶段30（32 项）；全套 **1797 项**通过
