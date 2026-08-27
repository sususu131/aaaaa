/**
 * 数据库迁移（阶段4：Dungeon Design Pipeline）。
 * 原则：不修改已有表语义，只增列/增表；全部幂等。
 */

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrations = [
  {
    name: '005_stage8_quest_system',
    up(db) {
      // 任务定义（版本化的父记录）
      db.exec(`CREATE TABLE IF NOT EXISTS quests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        uid           TEXT UNIQUE,
        name          TEXT NOT NULL,
        description   TEXT,
        type          TEXT NOT NULL DEFAULT 'SIDE'
                      CHECK (type IN ('MAIN','SIDE','DUNGEON','HIDDEN','EVENT','PERSONAL')),
        status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
        source_type   TEXT,                              -- ROBLOX_EXPERIENCE / AI_GENERATED / DESIGNER
        source_id     TEXT,
        dungeon_id    INTEGER REFERENCES dungeons(id),   -- 关联副本（副本生命周期联动）
        difficulty    INTEGER NOT NULL DEFAULT 1,
        is_repeatable INTEGER NOT NULL DEFAULT 0,
        max_players   INTEGER NOT NULL DEFAULT 3,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // 任务版本（运行中任务绑定版本，设计修改不影响进行中实例）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_versions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_id        INTEGER NOT NULL REFERENCES quests(id),
        version         INTEGER NOT NULL,
        definition_json TEXT NOT NULL,     -- objectives/conditions/rewards/time_limit/branches/hidden/scope
        status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW','PUBLISHED','ARCHIVED')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        published_at    TEXT,
        UNIQUE (quest_id, version)
      )`);
      // 任务实例（玩家实际执行）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_instances (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        uid                 TEXT UNIQUE,
        quest_version_id    INTEGER NOT NULL REFERENCES quest_versions(id),
        room_id             TEXT NOT NULL,
        dungeon_instance_id INTEGER REFERENCES dungeon_instances(id),
        status              TEXT NOT NULL DEFAULT 'AVAILABLE'
                            CHECK (status IN ('AVAILABLE','ACTIVE','PAUSED','COMPLETED','FAILED','ABANDONED')),
        progress_scope      TEXT NOT NULL DEFAULT 'PERSONAL',
        deadline_at         TEXT,                       -- 服务器时间限制（不用客户端时间）
        version             INTEGER NOT NULL DEFAULT 1, -- 乐观锁
        started_at          TEXT,
        completed_at        TEXT,
        failed_at           TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // 参与者（个人 + 多人共享）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_participants (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_instance_id INTEGER NOT NULL REFERENCES quest_instances(id),
        player_id         INTEGER NOT NULL REFERENCES players(id),
        status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','FAILED','LEFT')),
        joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (quest_instance_id, player_id)
      )`);
      // 目标定义（属于版本）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_objectives (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_version_id INTEGER NOT NULL REFERENCES quest_versions(id),
        objective_key    TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        type             TEXT NOT NULL,   -- REACH_LOCATION/ENTER_DUNGEON/OPEN_DOOR/COLLECT_ITEM/...
        required_count   INTEGER NOT NULL DEFAULT 1,
        order_index      INTEGER NOT NULL DEFAULT 1,  -- 同 index = 并行；递增 = 顺序
        is_optional      INTEGER NOT NULL DEFAULT 0,
        definition_json  TEXT,            -- event_type/match/branch/conditions
        UNIQUE (quest_version_id, objective_key)
      )`);
      // 目标运行时实例（不修改定义）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_objective_instances (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_instance_id INTEGER NOT NULL REFERENCES quest_instances(id),
        objective_id      INTEGER NOT NULL REFERENCES quest_objectives(id),
        status            TEXT NOT NULL DEFAULT 'LOCKED'
                          CHECK (status IN ('LOCKED','ACTIVE','COMPLETED','FAILED','SKIPPED')),
        current_count     INTEGER NOT NULL DEFAULT 0,
        required_count    INTEGER NOT NULL DEFAULT 1,
        progress_json     TEXT,           -- PERSONAL 作用域：{playerId: count}
        version           INTEGER NOT NULL DEFAULT 1,  -- 乐观锁（并发推进防护）
        completed_at      TEXT,
        UNIQUE (quest_instance_id, objective_id)
      )`);
      // 任务事件日志（debug/replay/断线恢复/审计）+ 事件幂等唯一约束
      db.exec(`CREATE TABLE IF NOT EXISTS quest_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_instance_id INTEGER NOT NULL REFERENCES quest_instances(id),
        player_id         INTEGER,
        event_id          TEXT,
        event_type        TEXT NOT NULL,
        objective_id      INTEGER,
        before_state      TEXT,
        after_state       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (quest_instance_id, event_id, objective_id)  -- 同一 event 不能重复推进同一目标
      )`);
      // 玩家选择（分支）：服务器验证后解析
      db.exec(`CREATE TABLE IF NOT EXISTS quest_choices (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        quest_instance_id INTEGER NOT NULL REFERENCES quest_instances(id),
        choice_key        TEXT NOT NULL,
        options_json      TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED')),
        chosen_by         INTEGER REFERENCES players(id),
        chosen_option     TEXT,
        resolved_at       TEXT,
        UNIQUE (quest_instance_id, choice_key)
      )`);
      // Game Event Bus 日志（全局事件流；quest 幂等处理的依据）
      db.exec(`CREATE TABLE IF NOT EXISTS game_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        uid         TEXT UNIQUE,
        room_id     TEXT,
        instance_id INTEGER,
        type        TEXT NOT NULL,
        actor       TEXT,
        data        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_game_events_room ON game_events(room_id, id)');
      // 任务奖励幂等（复用阶段5 reward_grants 机制；独立表避免 FK 冲突）
      db.exec(`CREATE TABLE IF NOT EXISTS quest_reward_grants (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_uid         TEXT UNIQUE,
        quest_instance_id INTEGER NOT NULL REFERENCES quest_instances(id),
        player_id         INTEGER NOT NULL REFERENCES players(id),
        reward_key        TEXT NOT NULL,
        reward_type       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'GRANTED' CHECK (status IN ('GRANTED','SKIPPED')),
        granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (quest_instance_id, player_id, reward_key)
      )`);
    },
  },
  {
    name: '004_stage7_agent_runtime',
    up(db) {
      // Agent Run 追踪（阶段7 第四十一节）
      db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        uid          TEXT UNIQUE,
        room_id      TEXT,
        instance_id  INTEGER,
        player_id    INTEGER,
        scope        TEXT,                    -- room / dungeon
        status       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','STOPPED')),
        rounds       INTEGER NOT NULL DEFAULT 0,
        tool_calls   INTEGER NOT NULL DEFAULT 0,
        searches     INTEGER NOT NULL DEFAULT 0,
        budget       TEXT,
        error        TEXT,
        started_at   TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      // Tool Call 追踪（阶段7 第四十二节）
      db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_run_id  INTEGER NOT NULL REFERENCES agent_runs(id),
        round         INTEGER NOT NULL,
        tool_call_id  TEXT,
        tool_name     TEXT NOT NULL,
        arguments     TEXT,
        result        TEXT,
        duration_ms   INTEGER,
        status        TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK','ERROR','INVALID_ARGS','UNKNOWN_TOOL','PERMISSION_DENIED','RATE_LIMITED','DEDUP')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_tc_run ON agent_tool_calls(agent_run_id, round)');
    },
  },
  {
    name: '003_stage6_character_progression',
    up(db) {
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      const addCol = (table, col, def) => {
        if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      };

      // players 扩展为 Persistent Character（复用现有行，不新建第二套）
      addCol('players', 'version', 'INTEGER NOT NULL DEFAULT 1'); // 乐观锁

      // 技能持有扩展：等级 / 来源 / 冷却 / 次数
      addCol('player_skills', 'level', 'INTEGER NOT NULL DEFAULT 1');
      addCol('player_skills', 'source_type', "TEXT");                     // INITIAL_AVATAR/DUNGEON_REWARD/QUEST/SPECIAL_EVENT/ADMIN
      addCol('player_skills', 'source_id', 'TEXT');
      addCol('player_skills', 'last_used_turn', 'INTEGER');
      addCol('player_skills', 'cooldown_until_turn', 'INTEGER');
      addCol('player_skills', 'uses_remaining', 'INTEGER');

      // 技能定义扩展：冷却/次数（声明式，数据驱动）
      addCol('skills', 'cooldown_turns', 'INTEGER NOT NULL DEFAULT 0');
      addCol('skills', 'max_uses', 'INTEGER');

      // 物品扩展：装备槽 / 堆叠规则 / 属性加成
      addCol('items', 'kind', "TEXT NOT NULL DEFAULT 'material'");        // weapon/armor/accessory/special/material/consumable
      addCol('items', 'slot', 'TEXT');                                     // weapon/armor/accessory（装备类）
      addCol('items', 'stacking', "TEXT NOT NULL DEFAULT 'STACKABLE'");   // STACKABLE/NON_STACKABLE/UNIQUE
      addCol('items', 'stat_bonus', 'TEXT');                               // JSON：{"STR":2}

      // 背包扩展（复用 player_items）
      addCol('player_items', 'metadata', 'TEXT');
      addCol('player_items', 'source_type', 'TEXT');                      // DUNGEON_REWARD/DROP/QUEST/EVENT/STARTER/SPECIAL

      // 装备槽（角色 × 槽位唯一）
      db.exec(`CREATE TABLE IF NOT EXISTS character_equipment (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id  INTEGER NOT NULL REFERENCES players(id),
        slot       TEXT NOT NULL CHECK (slot IN ('weapon','armor','accessory_1','accessory_2')),
        item_id    INTEGER NOT NULL REFERENCES items(id),
        equipped_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (player_id, slot),
        UNIQUE (player_id, item_id)
      )`);

      // 属性修正（PERMANENT / TEMPORARY；临时修正绑定实例，副本结束清除）
      db.exec(`CREATE TABLE IF NOT EXISTS character_modifiers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        stat        TEXT NOT NULL,
        delta       INTEGER NOT NULL,
        scope       TEXT NOT NULL CHECK (scope IN ('PERMANENT','TEMPORARY')),
        instance_id INTEGER,
        source_type TEXT,
        source_id   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);

      // 货币余额（复用 currencies 表）
      db.exec(`CREATE TABLE IF NOT EXISTS player_currency (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        currency_id INTEGER NOT NULL REFERENCES currencies(id),
        balance     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (player_id, currency_id)
      )`);

      // 角色交易日志（所有 XP/货币/物品/技能/装备/属性/HP 变化，审计）
      db.exec(`CREATE TABLE IF NOT EXISTS character_transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        kind        TEXT NOT NULL,     -- XP/LEVEL/HP/CURRENCY/ITEM/SKILL/EQUIPMENT/STAT
        action      TEXT NOT NULL,     -- grant/damage/heal/equip/unequip/level_up/use/...
        source_type TEXT,
        source_id   TEXT,
        old_value   TEXT,
        new_value   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_char_tx_player ON character_transactions(player_id)');

      // 副本开始时的角色快照（副本内用实例状态，结束才回写长期角色）
      db.exec(`CREATE TABLE IF NOT EXISTS instance_character_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL REFERENCES dungeon_instances(id),
        player_id   INTEGER NOT NULL REFERENCES players(id),
        snapshot    TEXT NOT NULL,     -- JSON：level/hp/max_hp/stats/skills/equipment
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (instance_id, player_id)
      )`);
    },
  },
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
