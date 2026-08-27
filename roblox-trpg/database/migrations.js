/**
 * 数据库迁移（阶段4：Dungeon Design Pipeline）。
 * 原则：不修改已有表语义，只增列/增表；全部幂等。
 */

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrations = [
  {
    name: '002_stage5_dungeon_runtime',
    up(db) {
      // 副本实例：一次实际游戏（独立于房主会话；世界状态按房间隔离）
      db.exec(`CREATE TABLE IF NOT EXISTS dungeon_instances (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        uid                 TEXT UNIQUE,
        dungeon_version_id  INTEGER NOT NULL REFERENCES dungeon_versions(id),
        room_id             TEXT NOT NULL REFERENCES rooms(id),
        status              TEXT NOT NULL DEFAULT 'WAITING'
                            CHECK (status IN ('WAITING','RUNNING','PAUSED','COMPLETED','FAILED','ABORTED')),
        party               TEXT NOT NULL DEFAULT '[]',      -- JSON：玩家行ID列表（座位制，断线不移除）
        current_scene_id    TEXT,
        world_state_version INTEGER NOT NULL DEFAULT 0,
        started_at          TEXT,
        ended_at            TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // Action Queue（序列化处理 + action_id 幂等）
      db.exec(`CREATE TABLE IF NOT EXISTS instance_actions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id      INTEGER NOT NULL REFERENCES dungeon_instances(id),
        player_id        INTEGER REFERENCES players(id),
        client_action_id TEXT,                     -- 客户端幂等键
        sequence         INTEGER NOT NULL,
        action           TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','PROCESSING','RESOLVED','REJECTED','FAILED')),
        result           TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (instance_id, client_action_id)
      )`);

      // Instance Event Log（Action/骰子/状态变化/场景/战斗/奖励，可重放）
      db.exec(`CREATE TABLE IF NOT EXISTS instance_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL REFERENCES dungeon_instances(id),
        sequence    INTEGER NOT NULL,
        type        TEXT NOT NULL,   -- ACTION/ROLL/STATE_CHANGE/SCENE_TRANSITION/COMBAT/REWARD/NARRATION/GM/JOIN/LEAVE/START/COMPLETE/FAILED
        actor       TEXT,
        data        TEXT,            -- JSON
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_instance_events_inst ON instance_events(instance_id, sequence)');

      // Combat 状态（乐观锁版本，同一战斗单写者）
      db.exec(`CREATE TABLE IF NOT EXISTS instance_combats (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id    INTEGER NOT NULL REFERENCES dungeon_instances(id),
        encounter_id   TEXT,
        participants   TEXT NOT NULL DEFAULT '[]',  -- JSON 玩家行ID
        turn           INTEGER NOT NULL DEFAULT 0,
        round          INTEGER NOT NULL DEFAULT 1,
        status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED')),
        enemy_states   TEXT NOT NULL DEFAULT '{}',  -- JSON：{enemyId:{hp,maxHp}}
        player_states  TEXT NOT NULL DEFAULT '{}',  -- JSON：{playerRowId:{hp}}
        boss_phase     INTEGER NOT NULL DEFAULT 1,
        version        INTEGER NOT NULL DEFAULT 0,
        started_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // 奖励发放（reward_grant_id 唯一约束 → 幂等）
      db.exec(`CREATE TABLE IF NOT EXISTS reward_grants (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_uid   TEXT UNIQUE,
        instance_id INTEGER NOT NULL REFERENCES dungeon_instances(id),
        player_id   INTEGER NOT NULL REFERENCES players(id),
        reward_key  TEXT NOT NULL,              -- skill:危险感知 / item:骨架钥匙 / candidate:xxx
        reward_type TEXT NOT NULL,              -- SKILL / ITEM / CANDIDATE
        status      TEXT NOT NULL DEFAULT 'GRANTED' CHECK (status IN ('GRANTED','SKIPPED')),
        granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (instance_id, player_id, reward_key)
      )`);
    },
  },
  {
    name: '001_stage4_dungeon_pipeline',
    up(db) {
      // dungeons 增加内部稳定标识（不用 placeId 做主键；同一体验可有多版本副本）
      if (!hasColumn(db, 'dungeons', 'uid')) {
        db.exec('ALTER TABLE dungeons ADD COLUMN uid TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_dungeons_uid ON dungeons(uid)');
      // 种子副本补齐 uid（确定性命名）
      db.exec(`UPDATE dungeons SET uid = 'dungeon_' || REPLACE(LOWER(roblox_experience_name), ' ', '_')
               WHERE uid IS NULL`);

      // 副本版本（PUBLISHED 后 immutable；修改 = 新 version）
      db.exec(`CREATE TABLE IF NOT EXISTS dungeon_versions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_id            INTEGER NOT NULL REFERENCES dungeons(id),
        version               INTEGER NOT NULL,
        definition_json       TEXT NOT NULL,          -- 完整 Dungeon Definition（含 canonical/TRPG 分区）
        canonical_snapshot_hash TEXT,
        status                TEXT NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT','REVIEW','APPROVED','REJECTED','PUBLISHED','ARCHIVED')),
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        published_at          TEXT,
        UNIQUE (dungeon_id, version)
      )`);

      // 设计运行记录（Snapshot / Prompt Version / Model / Token Usage）
      db.exec(`CREATE TABLE IF NOT EXISTS dungeon_design_runs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_id             INTEGER REFERENCES dungeons(id),
        dungeon_version_id     INTEGER REFERENCES dungeon_versions(id),
        source_type            TEXT NOT NULL DEFAULT 'ROBLOX_EXPERIENCE',
        source_ref             TEXT,                   -- universeId / placeId / url
        input_snapshot         TEXT,                   -- Roblox Canonical Data Snapshot（JSON）
        canonical_snapshot_hash TEXT,
        provider               TEXT,
        model                  TEXT,
        prompt_version         TEXT,
        status                 TEXT NOT NULL DEFAULT 'RUNNING'
                               CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','REUSED')),
        output                 TEXT,                   -- AI 原始输出
        error                  TEXT,
        prompt_tokens          INTEGER,
        completion_tokens      INTEGER,
        total_tokens           INTEGER,
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // 审核记录
      db.exec(`CREATE TABLE IF NOT EXISTS dungeon_reviews (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_version_id  INTEGER NOT NULL REFERENCES dungeon_versions(id),
        status              TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED')),
        reason              TEXT,
        reviewer            TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
];

/** 应用全部迁移（幂等）。 */
function runMigrations(db) {
  for (const m of migrations) m.up(db);
}

module.exports = { runMigrations };
