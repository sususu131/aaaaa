/**
 * 数据库迁移（阶段4：Dungeon Design Pipeline）。
 * 原则：不修改已有表语义，只增列/增表；全部幂等。
 */

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrations = [
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
