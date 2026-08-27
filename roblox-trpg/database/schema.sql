-- ============================================================
-- Roblox灾变：现实崩坏 — 数据库结构
-- 阶段1 使用：rooms / players / messages
-- 未来预留：dungeons / skills / dungeon_rewards / player_skills
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 房间表（阶段1使用）──────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,               -- 6位房间码
  status            TEXT NOT NULL DEFAULT 'waiting',-- waiting / in_game / finished
  max_players       INTEGER NOT NULL DEFAULT 3,
  creator_socket_id TEXT,                           -- 创建者（按会话）
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at         TEXT                            -- 未来：副本结算后关闭
);

-- ── 玩家表（阶段1使用）──────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  socket_id   TEXT NOT NULL UNIQUE,                 -- 当前会话身份
  name        TEXT NOT NULL,                        -- 玩家名字
  room_id     TEXT REFERENCES rooms(id),            -- 当前所在房间
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  left_at     TEXT,
  -- ── 未来成长系统预留字段 ──
  avatar_type TEXT NOT NULL DEFAULT 'bacon',        -- roblox / bacon（培根头）
  roblox_user TEXT,                                 -- 未来：绑定的Roblox账号
  level       INTEGER NOT NULL DEFAULT 1,
  exp         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);

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

-- ============================================================
-- 以下为未来阶段预留：副本 → 技能成长线（本阶段仅建表，不实现逻辑）
-- 成长逻辑：玩家进入Roblox副本 → 完成副本 → 获得该体验相关技能
-- ============================================================

-- ── 副本表：Roblox体验 → 危险副本的映射 ──
CREATE TABLE IF NOT EXISTS dungeons (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  roblox_experience_id   TEXT UNIQUE,               -- Roblox 体验ID
  roblox_experience_name TEXT NOT NULL UNIQUE,      -- Doors / Jailbreak / Blox Fruits ...
  dungeon_name           TEXT NOT NULL,             -- 副本名
  difficulty             INTEGER NOT NULL DEFAULT 1,-- 1~10
  description            TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 技能表 ──
-- 技能不是数据库初始化时臆造的，而是"副本设计阶段"的产物：
-- AI 搜索真实 Roblox Experience 资料 → 分析玩法 → 设计候选技能 → 规则/人工审核 → approved
CREATE TABLE IF NOT EXISTS skills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,                  -- 技能名（设计产出，非预写结论）
  description       TEXT,                           -- 技能效果描述
  source_dungeon_id INTEGER REFERENCES dungeons(id),-- 技能来源副本
  source_type       TEXT NOT NULL DEFAULT 'original'
                    CHECK (source_type IN ('official', 'inspired', 'original')),
                    -- official: Roblox 原作中真实存在的机制/能力
                    -- inspired: 受原作机制启发的 TRPG 再创作（不得声称为原作内容）
                    -- original: 本 TRPG 完全原创
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
                    CHECK (source_type IN ('official', 'inspired', 'original')),
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
