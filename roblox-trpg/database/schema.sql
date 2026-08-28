-- ============================================================
-- Roblox灾变：现实崩坏 — 数据库结构
-- 阶段1 使用：rooms / players / messages
-- 未来预留：dungeons / skills / dungeon_rewards / player_skills
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 房间表（阶段1使用）──────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id                 TEXT PRIMARY KEY,               -- 6位房间码
  status             TEXT NOT NULL DEFAULT 'waiting',-- waiting / in_game / finished
  max_players        INTEGER NOT NULL DEFAULT 3,
  creator_socket_id  TEXT,                           -- 创建者（按会话）
  current_experience TEXT,                           -- JSON：当前绑定的 Roblox 体验公开资料（阶段2）
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT                            -- 未来：副本结算后关闭
);

-- ── 玩家表（阶段1使用）──────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT UNIQUE,                      -- 对外稳定身份 player_xxxx（阶段2）
  socket_id        TEXT NOT NULL UNIQUE,             -- 当前会话身份
  name             TEXT NOT NULL,                    -- 玩家名字
  room_id          TEXT REFERENCES rooms(id),        -- 当前所在房间
  roblox_profile_id INTEGER REFERENCES roblox_profiles(id), -- 可选绑定的公开 Roblox 资料
  joined_at        TEXT NOT NULL DEFAULT (datetime('now')),
  left_at          TEXT,
  -- ── 未来成长系统预留字段 ──
  avatar_type TEXT NOT NULL DEFAULT 'bacon',         -- roblox / bacon（培根头）
  level       INTEGER NOT NULL DEFAULT 1,
  exp         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);

-- ── 会话表（阶段2）：临时身份，无账号登录 ──────────────
-- token 仅存 SHA-256 哈希；客户端不得指定 playerId。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  expires_at  TEXT
);

-- ── Roblox 公开资料表（阶段2）：只存公开信息，主键用 Roblox User ID ──
CREATE TABLE IF NOT EXISTS roblox_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_user_id  TEXT NOT NULL UNIQUE,      -- 稳定唯一标识（username 可变，不做主键）
  username        TEXT,
  display_name    TEXT,
  description     TEXT,
  headshot_url    TEXT,
  fullbody_url    TEXT,
  data_source     TEXT NOT NULL DEFAULT 'roblox_api',
  fullbody_r6_url TEXT,  -- 阶段30：R6 渲染（绑定固定使用）
  fullbody_r15_url TEXT, -- 阶段30：R15 渲染（对照）
  avatar_type     TEXT,  -- 阶段30：用户实际体型（R6/R15，avatar.roblox.com 探测）
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 消息表（阶段1使用：聊天 + 系统消息，未来做跑团日志）──
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  player_id  INTEGER REFERENCES players(id),        -- 系统消息为 NULL
  type       TEXT NOT NULL DEFAULT 'chat',          -- chat / system / (未来: dice / story)
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);

-- ── AI 重要记忆（阶段2）：Context 的 IMPORTANT_MEMORIES 持久层 ──
CREATE TABLE IF NOT EXISTS room_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  kind       TEXT NOT NULL DEFAULT 'important_event', -- important_event / npc / quest / location
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_room ON room_memories(room_id);

-- ── Context 压缩摘要（阶段2）──────────────────────────
CREATE TABLE IF NOT EXISTS context_summaries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  summary          TEXT NOT NULL,
  token_estimate   INTEGER,
  message_id_from  INTEGER,
  message_id_to    INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── AI 规则请求（阶段2）：AI 只能提请求，由规则引擎审批 ──
-- 治理：AI 不得直接修改 HP/金币/技能/装备/副本进度等任何状态表。
CREATE TABLE IF NOT EXISTS ai_rule_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  request_type TEXT NOT NULL,               -- reward_request / state_change / ...
  payload      TEXT,                        -- JSON
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 以下为未来阶段预留：副本 → 技能成长线（本阶段仅建表，不实现逻辑）
-- 成长逻辑：玩家进入Roblox副本 → 完成副本 → 获得该体验相关技能
-- ============================================================

-- ── 副本表：Roblox体验 → 危险副本的映射 ──
CREATE TABLE IF NOT EXISTS dungeons (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_experience_id   TEXT UNIQUE,               -- Roblox 体验ID
  roblox_experience_name TEXT NOT NULL UNIQUE,      -- Doors / Jailbreak / Blox Fruits ...
  roblox_universe_id     TEXT UNIQUE,               -- Roblox Universe ID（阶段3）
  roblox_place_id        TEXT,                      -- Roblox Place ID（阶段3）
  dungeon_name           TEXT NOT NULL,             -- 副本名
  difficulty             INTEGER NOT NULL DEFAULT 1,-- 1~10
  description            TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 技能表 ──
-- 技能不是数据库初始化时臆造的，而是"副本设计阶段"或"Avatar初始化规则"的产物。
-- source_type 双轴：来源渠道（INITIAL_AVATAR / DUNGEON）与资料出处（official/inspired/original）。
CREATE TABLE IF NOT EXISTS skills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,                  -- 技能名（设计产出，非预写结论）
  description       TEXT,                           -- 技能效果描述
  source_dungeon_id INTEGER REFERENCES dungeons(id),-- 技能来源副本（INITIAL_AVATAR 技能为 NULL）
  source_type       TEXT NOT NULL DEFAULT 'original'
                    CHECK (source_type IN ('official', 'inspired', 'original', 'INITIAL_AVATAR', 'DUNGEON')),
                    -- INITIAL_AVATAR: Avatar Vision 初始化技能（与副本技能严格区分）
                    -- DUNGEON: 副本通关奖励技能
                    -- official/inspired/original: 资料出处标注
  skill_type        TEXT NOT NULL DEFAULT 'passive'
                    CHECK (skill_type IN ('passive', 'active', 'reaction')),
  rarity            TEXT NOT NULL DEFAULT 'common'
                    CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  effect_data       TEXT,                           -- JSON：机制参数（骰子判定、数值等），由规则系统消费
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'approved')),
                    -- draft: AI 候选，未经审核；approved: 规则系统/人工确认后才可发放
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, source_dungeon_id)
);

-- ── 物品/装备表（副本设计阶段同样由资料分析产出）──
CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  description       TEXT,
  source_dungeon_id INTEGER REFERENCES dungeons(id),
  source_type       TEXT NOT NULL DEFAULT 'original'
                    CHECK (source_type IN ('official', 'inspired', 'original', 'INITIAL_AVATAR', 'DUNGEON')),
  rarity            TEXT NOT NULL DEFAULT 'common'
                    CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  effect_data       TEXT,                           -- JSON
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name, source_dungeon_id)
);

-- ── 货币表（如：金币）──
CREATE TABLE IF NOT EXISTS currencies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 副本奖励表：一个副本可挂多个奖励（技能/物品/货币/特殊）──
CREATE TABLE IF NOT EXISTS dungeon_rewards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dungeon_id     INTEGER NOT NULL REFERENCES dungeons(id),
  reward_type    TEXT NOT NULL
                 CHECK (reward_type IN ('skill', 'item', 'currency', 'special')),
  reward_id      INTEGER,               -- skill→skills.id / item→items.id / currency→currencies.id
                                        -- special 类型可留空，具体内容由 condition_data 描述
  drop_rate      REAL NOT NULL DEFAULT 1.0 CHECK (drop_rate >= 0 AND drop_rate <= 1), -- 获得概率
  is_guaranteed  INTEGER NOT NULL DEFAULT 0, -- 1 = 通关必得（优先级高于 drop_rate）
  is_optional    INTEGER NOT NULL DEFAULT 0, -- 1 = 可选奖励（玩家可选择是否接受）
  condition_data TEXT,                   -- JSON：获取条件（如无伤通关、特定选择、N选1分组等）
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  UNIQUE (dungeon_id, reward_type, reward_id)
);

-- ── 玩家技能关联表：玩家×技能多对多，记录获得来源 ──
-- 治理规则：本表只允许"游戏规则系统"在结算已审核（approved）奖励时写入；
-- AI（GM/副本设计）不得直接修改本表。
CREATE TABLE IF NOT EXISTS player_skills (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id                INTEGER NOT NULL REFERENCES players(id),
  skill_id                 INTEGER NOT NULL REFERENCES skills(id),
  obtained_from_dungeon_id INTEGER REFERENCES dungeons(id), -- 获得技能来源
  obtained_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_player_skills_player ON player_skills(player_id);

-- ============================================================
-- 阶段3：AI Agent + 世界状态 + 工具调用系统
-- ============================================================

-- ── 世界状态（每房间一份，服务器权威，乐观锁版本号）──
CREATE TABLE IF NOT EXISTS world_states (
  room_id    TEXT PRIMARY KEY REFERENCES rooms(id),
  version    INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL DEFAULT '{}',   -- JSON：白名单字段（TRPG_ORIGINAL 状态）
  updated_by TEXT,                         -- 最后修改者（player_xxx / ai_tool）
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 世界事件审计：每次重要变化可追溯 who/when/action/before/after/source ──
CREATE TABLE IF NOT EXISTS world_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  actor        TEXT,                       -- player_xxxx / ai_tool / server
  action       TEXT NOT NULL,              -- open_door / grant_skill / ...
  before_state TEXT,                       -- JSON
  after_state  TEXT,                       -- JSON
  source       TEXT NOT NULL DEFAULT 'ai_tool', -- ai_tool / rule_engine / server
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_world_events_room ON world_events(room_id);

-- ── 玩家状态（HP/状态效果/位置/属性；技能物品在各自关联表）──
CREATE TABLE IF NOT EXISTS player_states (
  player_id      INTEGER PRIMARY KEY REFERENCES players(id),
  hp             INTEGER NOT NULL DEFAULT 10,
  max_hp         INTEGER NOT NULL DEFAULT 10,
  status_effects TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  location       TEXT NOT NULL DEFAULT 'start',
  attributes     TEXT,                        -- JSON：Avatar 初始属性（阶段3b，Rules Engine 计算）
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 玩家物品 ──
CREATE TABLE IF NOT EXISTS player_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  item_id     INTEGER NOT NULL REFERENCES items(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  source      TEXT,                        -- 来源（dungeon:xxx / ai_tool）
  reason      TEXT,
  obtained_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, item_id)
);

-- ── 骰子记录（全部由服务器生成，可审计）──
CREATE TABLE IF NOT EXISTS dice_rolls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  player_id  INTEGER REFERENCES players(id),
  kind       TEXT NOT NULL DEFAULT 'roll', -- roll / skill_check
  data       TEXT NOT NULL,                -- JSON：{sides,count,rolls,total,difficulty?...}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Tool Call 审计（不记录 API Key / token 等敏感信息）──
CREATE TABLE IF NOT EXISTS tool_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL,
  player_uid TEXT,
  tool_name  TEXT NOT NULL,
  arguments  TEXT,                          -- JSON（入库前脱敏）
  result     TEXT,                          -- 摘要（截断）
  success    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_room ON tool_calls(room_id);

-- ── 玩家副本进度（通关状态 + 防重复领取）──
CREATE TABLE IF NOT EXISTS player_dungeon_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    INTEGER NOT NULL REFERENCES players(id),
  dungeon_id   INTEGER NOT NULL REFERENCES dungeons(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  completed_at TEXT,
  UNIQUE (player_id, dungeon_id)
);

-- ============================================================
-- 阶段3b：Avatar Vision + 初始属性 + 初始技能
-- Vision 只观察（UNTRUSTED_MODEL_OUTPUT），服务器 Rules Engine 决定最终结果。
-- ============================================================

-- ── Avatar 初始化快照（防重复初始化 + 审计）──
CREATE TABLE IF NOT EXISTS avatar_initialization (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id             INTEGER NOT NULL UNIQUE REFERENCES players(id),
  roblox_user_id        TEXT NOT NULL,
  avatar_image_url      TEXT,
  avatar_snapshot_hash  TEXT NOT NULL,        -- hash(userId|imageUrl)：重复初始化防线
  vision_provider       TEXT,
  vision_model          TEXT,
  vision_result         TEXT,                 -- Vision 原始输出 JSON（仅存库，不进 Context）
  accepted_tags         TEXT,                 -- JSON
  rejected_tags         TEXT,                 -- JSON：[{tag, reason}]
  accepted_skills       TEXT,                 -- JSON
  rejected_skills       TEXT,                 -- JSON：[{skill, reason}]
  final_attributes      TEXT,                 -- JSON：STR/DEX/CON/PER/INT/LUK（INITIALIZED 才有）
  final_skill_ids       TEXT,                 -- JSON：skills 表 ID 列表
  status                TEXT NOT NULL DEFAULT 'NOT_INITIALIZED'
                        CHECK (status IN ('NOT_INITIALIZED', 'ANALYZING', 'INITIALIZED', 'FAILED')),
  error                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Vision 分析日志（禁止记录 API Key / Cookie / Token）──
CREATE TABLE IF NOT EXISTS vision_analysis_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id          INTEGER,
  roblox_user_id     TEXT,
  vision_provider    TEXT,
  vision_model       TEXT,
  candidate_tags     TEXT,
  accepted_tags      TEXT,
  rejected_tags      TEXT,
  candidate_skills   TEXT,
  accepted_skills    TEXT,
  rejected_skills    TEXT,
  final_attributes   TEXT,
  final_skills       TEXT,
  status             TEXT,
  error              TEXT,
  raw_response       TEXT,       -- 阶段30：网关原文 + 模型文本 + 解析 JSON
  request_meta       TEXT,       -- 阶段30：请求元数据（端点/模型；不含密钥）
  image_url          TEXT,       -- 阶段30：分析的图片 URL
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
