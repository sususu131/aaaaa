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
CREATE TABLE IF NOT EXISTS skills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,           -- 危险感知 / 开锁能力 / 果实能力 ...
  description       TEXT,
  source_dungeon_id INTEGER REFERENCES dungeons(id),-- 技能来源副本
  rarity            TEXT NOT NULL DEFAULT 'common', -- common / rare / epic / legendary
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 副本奖励表：副本可掉落的技能 ──
CREATE TABLE IF NOT EXISTS dungeon_rewards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dungeon_id    INTEGER NOT NULL REFERENCES dungeons(id),
  skill_id      INTEGER REFERENCES skills(id),
  drop_rate     REAL NOT NULL DEFAULT 1.0,          -- 掉落概率
  is_guaranteed INTEGER NOT NULL DEFAULT 0,         -- 通关必得
  UNIQUE (dungeon_id, skill_id)
);

-- ── 玩家技能关联表：玩家×技能多对多，记录获得来源 ──
CREATE TABLE IF NOT EXISTS player_skills (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id                INTEGER NOT NULL REFERENCES players(id),
  skill_id                 INTEGER NOT NULL REFERENCES skills(id),
  obtained_from_dungeon_id INTEGER REFERENCES dungeons(id), -- 获得技能来源
  obtained_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_player_skills_player ON player_skills(player_id);
