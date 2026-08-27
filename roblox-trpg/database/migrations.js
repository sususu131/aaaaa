/**
 * 数据库迁移（阶段4：Dungeon Design Pipeline）。
 * 原则：不修改已有表语义，只增列/增表；全部幂等。
 */

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

const migrations = [
  {
    name: '013_stage16_presets',
    up(db) {
      // ── 官方体验预设（第一节）：预设条目与配置，与玩家设计流水线完全分离 ──
      db.exec(`CREATE TABLE IF NOT EXISTS preset_experiences (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        key                TEXT NOT NULL UNIQUE,          -- doors / forsaken / dod / high_tier_sword / something_evil
        name               TEXT NOT NULL,
        roblox_universe_id TEXT,                          -- CANON 资料（公开 API）
        roblox_place_id    TEXT,
        description        TEXT,
        genre              TEXT,
        difficulty         INTEGER NOT NULL DEFAULT 1,
        icon_url           TEXT,
        source_type        TEXT NOT NULL DEFAULT 'CANON_PRESET',
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS preset_dungeon_configs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        preset_id   INTEGER NOT NULL UNIQUE REFERENCES preset_experiences(id),
        dungeon_id  INTEGER REFERENCES dungeons(id),
        config_json TEXT NOT NULL,                        -- 世界/地点/实体/任务/奖励配置（含 lore_source 标记）
        status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
        published_at TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    name: '012_stage15_playable',
    up(db) {
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      // 正式回合制战斗：阶段/已行动玩家/防御标记（阶段15）
      if (!hasCol('instance_combats', 'phase')) {
        db.exec("ALTER TABLE instance_combats ADD COLUMN phase TEXT NOT NULL DEFAULT 'PLAYER_TURN'");
      }
      if (!hasCol('instance_combats', 'acted_json')) {
        db.exec("ALTER TABLE instance_combats ADD COLUMN acted_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!hasCol('instance_combats', 'defending_json')) {
        db.exec("ALTER TABLE instance_combats ADD COLUMN defending_json TEXT NOT NULL DEFAULT '{}'");
      }
      // 官方可玩内容（与玩家设计流水线分离；开局时按需物化为 dungeon_versions）
      db.exec(`CREATE TABLE IF NOT EXISTS official_dungeon_definitions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        dungeon_name   TEXT NOT NULL UNIQUE,
        definition_json TEXT NOT NULL,
        description    TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    name: '011_stage14_inventory',
    up(db) {
      // ── 物品定义（与玩家持有分离；第一节）──
      db.exec(`CREATE TABLE IF NOT EXISTS item_definitions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key      TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        description   TEXT,
        type          TEXT NOT NULL DEFAULT 'MATERIAL'
                      CHECK (type IN ('CONSUMABLE','WEAPON','ARMOR','TOOL','QUEST_ITEM','MATERIAL','SPECIAL')),
        rarity        TEXT NOT NULL DEFAULT 'COMMON'
                      CHECK (rarity IN ('COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','MYTHIC')),
        icon          TEXT,
        stack_limit   INTEGER NOT NULL DEFAULT 1,          -- 1 = 唯一/不可堆叠；>1 = 堆叠上限
        bind_on_acquire INTEGER NOT NULL DEFAULT 0,        -- 绑定物品（获得后不可移除/交易）
        permanent     INTEGER NOT NULL DEFAULT 0,          -- 永久物品（跨副本保留，受副本规则削弱）
        base_power    INTEGER NOT NULL DEFAULT 0,          -- 基础强度（跨副本削弱计算的基数）
        metadata_json TEXT NOT NULL DEFAULT '{}',          -- damage/element/source/armor/quest_id…
        source        TEXT NOT NULL DEFAULT 'original',    -- official / inspired / original
        status        TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // ── 背包（第二节）──
      db.exec(`CREATE TABLE IF NOT EXISTS inventories (
        player_id INTEGER PRIMARY KEY REFERENCES players(id),
        capacity  INTEGER NOT NULL DEFAULT 20,             -- 物品种类槽位上限
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS inventory_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id     INTEGER NOT NULL REFERENCES players(id),
        item_id       INTEGER NOT NULL REFERENCES item_definitions(id),
        amount        INTEGER NOT NULL DEFAULT 1,
        equipped_slot TEXT,                                -- weapon / armor（NULL = 未装备）
        bound         INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',          -- 实例级特殊属性（第六节）
        acquired_from TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (player_id, item_id)                        -- 同定义单行堆叠
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_inv_items_player ON inventory_items(player_id)');
      // 奖励发放幂等台账（第十节：重复领奖不重复获得）
      db.exec(`CREATE TABLE IF NOT EXISTS inventory_grants (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_key   TEXT NOT NULL UNIQUE,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        item_id     INTEGER NOT NULL REFERENCES item_definitions(id),
        amount      INTEGER NOT NULL DEFAULT 1,
        source_type TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    name: '010_stage13_party_decision',
    up(db) {
      // ── Party 系统（第一节）──
      db.exec(`CREATE TABLE IF NOT EXISTS parties (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        uid              TEXT UNIQUE,
        room_id          TEXT NOT NULL REFERENCES rooms(id),
        leader_player_id INTEGER NOT NULL REFERENCES players(id),
        status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISBANDED')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        disbanded_at     TEXT
      )`);
      // 一个房间只能存在一个主队伍（ACTIVE 唯一）
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_room_active ON parties(room_id) WHERE status = 'ACTIVE'`);
      db.exec(`CREATE TABLE IF NOT EXISTS party_members (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        party_id   INTEGER NOT NULL REFERENCES parties(id),
        player_id  INTEGER NOT NULL REFERENCES players(id),
        role       TEXT NOT NULL DEFAULT 'CUSTOM',   -- 叙事定位（第二节），非职业，不改变属性
        joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (party_id, player_id)
      )`);
      // 叙事角色定位（EXPLORER/COMBATANT/SUPPORT/SCOUT/CUSTOM；只影响 AI 描述）
      db.exec(`CREATE TABLE IF NOT EXISTS party_roles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        party_id   INTEGER NOT NULL REFERENCES parties(id),
        player_id  INTEGER NOT NULL REFERENCES players(id),
        role       TEXT NOT NULL DEFAULT 'CUSTOM'
                   CHECK (role IN ('EXPLORER','COMBATANT','SUPPORT','SCOUT','CUSTOM')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (party_id, player_id)
      )`);
      // ── 玩家关系系统（第三节）：事件驱动，AI 无直接修改途径 ──
      db.exec(`CREATE TABLE IF NOT EXISTS player_relationships (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        player_a          INTEGER NOT NULL REFERENCES players(id),
        player_b          INTEGER NOT NULL REFERENCES players(id),
        value             INTEGER NOT NULL DEFAULT 0 CHECK (value >= -100 AND value <= 100),
        relationship_type TEXT NOT NULL DEFAULT 'FRIEND' CHECK (relationship_type IN ('FRIEND','TRUSTED','RIVAL','HOSTILE')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (player_a, player_b),
        CHECK (player_a < player_b)                  -- 规范化存储
      )`);
      // 关系事件台账（幂等键 + 审计：同一事件不重复改变关系）
      db.exec(`CREATE TABLE IF NOT EXISTS player_relation_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key  TEXT UNIQUE,
        player_a    INTEGER NOT NULL,
        player_b    INTEGER NOT NULL,
        event_type  TEXT NOT NULL,
        delta       INTEGER NOT NULL,
        reason      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // ── Decision 系统（第四~七节）：服务器计时与结算 ──
      db.exec(`CREATE TABLE IF NOT EXISTS decisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        uid              TEXT UNIQUE,
        room_id          TEXT NOT NULL REFERENCES rooms(id),
        instance_id      INTEGER REFERENCES dungeon_instances(id),  -- 可绑定副本（第八节）
        type             TEXT NOT NULL CHECK (type IN ('NORMAL','TIMED','PARTY')),
        status           TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','RESOLVED','TIMEOUT','CANCELLED')),
        creator          TEXT NOT NULL DEFAULT 'ai',                -- ai / server / player#id
        prompt             TEXT NOT NULL,
        tag              TEXT,                                      -- 任务联动匹配标签（第九节）
        target_player_id INTEGER REFERENCES players(id),            -- NORMAL/TIMED 可指定决策者
        default_option   TEXT,                                      -- 超时自动执行（第六节）
        timeout_ms       INTEGER,
        expires_at       TEXT,                                      -- 服务器时间（客户端只显示）
        required_votes   INTEGER,                                   -- PARTY 决策
        result_rule      TEXT NOT NULL DEFAULT 'FIRST_VOTE' CHECK (result_rule IN ('FIRST_VOTE','MAJORITY')),
        resolved_option  TEXT,
        resolved_by      INTEGER REFERENCES players(id),
        resolved_reason  TEXT,                                      -- PLAYER / TIMEOUT / TALLY
        resolved_at      TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_decisions_room ON decisions(room_id, status)');
      db.exec(`CREATE TABLE IF NOT EXISTS decision_options (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        option_key  TEXT NOT NULL,                 -- A/B/C/D
        text        TEXT NOT NULL,
        result_data TEXT NOT NULL DEFAULT '{}',    -- JSON：服务器验证过的效果（结算时执行）
        UNIQUE (decision_id, option_key)
      )`);
      // 投票（PARTY）：一人一票，投出不可改（UNIQUE 拦截）
      db.exec(`CREATE TABLE IF NOT EXISTS decision_votes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id INTEGER NOT NULL REFERENCES decisions(id),
        player_id   INTEGER NOT NULL REFERENCES players(id),
        option_key  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (decision_id, player_id)
      )`);
    },
  },
  {
    name: '009_stage12_world_simulation',
    up(db) {
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      // NPC 地点（世界模拟的移动系统：大厅/地下室/…）
      db.exec(`CREATE TABLE IF NOT EXISTS npc_locations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        description TEXT,
        is_safe     INTEGER NOT NULL DEFAULT 0,      -- 1 = 安全点（FLEEING 目标）
        dungeon_id  INTEGER REFERENCES dungeons(id), -- 可绑定副本（NULL = 世界地点）
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // 阵营关系（阶段9 声望是玩家×阵营；本表是阵营×阵营）
      db.exec(`CREATE TABLE IF NOT EXISTS faction_relations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        faction_a  INTEGER NOT NULL REFERENCES factions(id),
        faction_b  INTEGER NOT NULL REFERENCES factions(id),
        relation   TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK (relation IN ('HOSTILE','NEUTRAL','ALLIED')),
        updated_by TEXT,                              -- server / rule_engine / event:xxx
        reason     TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (faction_a, faction_b),
        CHECK (faction_a < faction_b)                 -- 规范化存储：小 id 在前
      )`);
      // 世界模拟事件（自然/剧情/系统；与 world_events 审计表语义不同，不改动旧表）
      db.exec(`CREATE TABLE IF NOT EXISTS world_sim_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uid        TEXT UNIQUE,
        room_id    TEXT,                              -- NULL = 全局事件
        event_type TEXT NOT NULL,                     -- POWER_OUTAGE / MONSTER_INVASION / …
        category   TEXT NOT NULL CHECK (category IN ('NATURAL','STORY','SYSTEM')),
        status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','CANCELLED')),
        data_json  TEXT NOT NULL DEFAULT '{}',
        source     TEXT NOT NULL DEFAULT 'server',    -- server / rule_engine / ai_request
        dedupe_key TEXT,                              -- 幂等去重键（同房间同键不重复触发）
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,                              -- NULL = 永久（剧情类）
        ended_at   TEXT
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_wse_room ON world_sim_events(room_id, status)');
      // World Tick 审计（幂等依据：UNIQUE(room_id, tick_number)，重放同 tick 直接跳过）
      db.exec(`CREATE TABLE IF NOT EXISTS world_ticks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT NOT NULL,
        tick_number INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','SKIPPED')),
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (room_id, tick_number)
      )`);
      // 调度器单例状态（暂停标志/最后 tick；重启与断线恢复后延续）
      db.exec(`CREATE TABLE IF NOT EXISTS world_scheduler (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        paused      INTEGER NOT NULL DEFAULT 0,
        last_tick   INTEGER NOT NULL DEFAULT 0,
        interval_ms INTEGER NOT NULL DEFAULT 30000,
        last_run_at TEXT
      )`);
      db.exec('INSERT OR IGNORE INTO world_scheduler (id, paused, last_tick, interval_ms) VALUES (1, 0, 0, 30000)');
      // NPC 实例：自主行为状态 + 当前地点
      if (!hasCol('npc_instances', 'behavior_state')) {
        db.exec("ALTER TABLE npc_instances ADD COLUMN behavior_state TEXT NOT NULL DEFAULT 'IDLE'");
      }
      if (!hasCol('npc_instances', 'location_key')) {
        db.exec('ALTER TABLE npc_instances ADD COLUMN location_key TEXT');
      }
      if (!hasCol('npc_instances', 'behavior_data_json')) {
        db.exec("ALTER TABLE npc_instances ADD COLUMN behavior_data_json TEXT NOT NULL DEFAULT '{}'");
      }
      // 动态副本：实例创建时由世界状态解析变体（NORMAL/BLACKOUT/HARD/HIDDEN_ROUTE）
      if (!hasCol('dungeon_instances', 'variant_key')) {
        db.exec("ALTER TABLE dungeon_instances ADD COLUMN variant_key TEXT NOT NULL DEFAULT 'NORMAL'");
      }
    },
  },
  {
    name: '008_stage11_legendary_encounter',
    up(db) {
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      // 传奇人物扩展：遭遇规则 / 创作者类型 / 头像资源
      if (!hasCol('legendary_npcs', 'encounter_rules_json')) {
        db.exec("ALTER TABLE legendary_npcs ADD COLUMN encounter_rules_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!hasCol('legendary_npcs', 'creator_type')) {
        db.exec("ALTER TABLE legendary_npcs ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'LEGEND'");
      }
      if (!hasCol('legendary_npcs', 'avatar_asset')) {
        db.exec("ALTER TABLE legendary_npcs ADD COLUMN avatar_asset TEXT");
      }
      // 永久物品：玩家获得后永久保存（跨副本保留，强度经平衡规则计算）
      db.exec(`CREATE TABLE IF NOT EXISTS permanent_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id      INTEGER NOT NULL REFERENCES players(id),
        item_id        INTEGER NOT NULL REFERENCES items(id),
        acquired_from  TEXT,                     -- 来源体验/副本
        acquired_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (player_id, item_id)
      )`);
      // 跨副本装备削弱规则：不同世界规则不同
      db.exec(`CREATE TABLE IF NOT EXISTS item_balance_rules (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name         TEXT NOT NULL,
        source_experience TEXT NOT NULL,           -- 来源体验（主场 = 1.0）
        target_experience TEXT NOT NULL,           -- 目标体验
        multiplier        REAL NOT NULL DEFAULT 1.0,
        UNIQUE (item_name, target_experience)
      )`);
      // 体验物品数据库：剑斗副本真实存在的剑（AI 禁止编造）
      db.exec(`CREATE TABLE IF NOT EXISTS experience_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        source_experience TEXT NOT NULL,
        description      TEXT,
        rarity           TEXT NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','rare','epic','legendary')),
        original_ability TEXT,                     -- 原始能力（来自公开资料；资料不足 = UNKNOWN）
        status           TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','unknown')),
        UNIQUE (name, source_experience)
      )`);
      // 放宽 reward_grants.instance_id 为可空（阶段11：传奇战斗/剑斗奖励不绑定副本实例）
      // SQLite 无法直接 ALTER 放宽 NOT NULL，需重建表
      const rgCols = db.prepare('PRAGMA table_info(reward_grants)').all();
      const instCol = rgCols.find((c) => c.name === 'instance_id');
      if (instCol && instCol.notnull === 1) {
        db.exec(`CREATE TABLE IF NOT EXISTS reward_grants_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          grant_uid   TEXT UNIQUE,
          instance_id INTEGER REFERENCES dungeon_instances(id),
          player_id   INTEGER NOT NULL REFERENCES players(id),
          reward_key  TEXT NOT NULL,
          reward_type TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'GRANTED' CHECK (status IN ('GRANTED','SKIPPED')),
          granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (instance_id, player_id, reward_key)
        )`);
        db.exec('INSERT OR IGNORE INTO reward_grants_new SELECT * FROM reward_grants');
        db.exec('DROP TABLE reward_grants');
        db.exec('ALTER TABLE reward_grants_new RENAME TO reward_grants');
      }
      // 副本表现追踪（完成度评分依据）
      db.exec(`CREATE TABLE IF NOT EXISTS instance_performance (
        instance_id    INTEGER NOT NULL UNIQUE REFERENCES dungeon_instances(id),
        deaths         INTEGER NOT NULL DEFAULT 0,
        combat_wins    INTEGER NOT NULL DEFAULT 0,
        combat_losses  INTEGER NOT NULL DEFAULT 0,
        explored_scenes TEXT NOT NULL DEFAULT '[]',
        quests_done    INTEGER NOT NULL DEFAULT 0,
        started_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    },
  },
  {
    name: '007_stage10_legendary',
    up(db) {
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
      // NPC 本性：hostile（怪物/实体）好感度不改变敌对行为 —— 关系只记录，不解锁友好内容
      if (!hasCol('npcs', 'nature')) {
        db.exec("ALTER TABLE npcs ADD COLUMN nature TEXT NOT NULL DEFAULT 'neutral'");
      }
      // 传奇人物
      db.exec(`CREATE TABLE IF NOT EXISTS legendary_npcs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        npc_id            INTEGER NOT NULL UNIQUE REFERENCES npcs(id),
        display_name      TEXT NOT NULL,
        title             TEXT,
        description       TEXT,
        origin_type       TEXT NOT NULL CHECK (origin_type IN ('CREATOR','LEGEND','ADMIN_LEGEND','EXPERIENCE_AUTHOR')),
        origin_experience TEXT,
        rarity            TEXT NOT NULL DEFAULT 'legendary' CHECK (rarity IN ('rare','epic','legendary','mythic')),
        base_power        INTEGER NOT NULL DEFAULT 50,
        personality_json  TEXT NOT NULL DEFAULT '{}',
        ability_json      TEXT NOT NULL DEFAULT '[]',
        power_rules_json  TEXT NOT NULL DEFAULT '{}',
        spawn_rules_json  TEXT NOT NULL DEFAULT '{}',
        equipment_rules_json TEXT NOT NULL DEFAULT '{}',
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // 传奇商店
      db.exec(`CREATE TABLE IF NOT EXISTS legendary_shop_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        legendary_npc_id  INTEGER NOT NULL REFERENCES legendary_npcs(id),
        item_id           INTEGER NOT NULL REFERENCES items(id),
        price             INTEGER NOT NULL DEFAULT 0,
        currency          TEXT NOT NULL DEFAULT '金币',
        requirements_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (legendary_npc_id, item_id)
      )`);
    },
  },
  {
    name: '006_stage9_npc_world',
    up(db) {
      // 阵营
      db.exec(`CREATE TABLE IF NOT EXISTS factions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        uid         TEXT UNIQUE,
        name        TEXT NOT NULL,
        description TEXT,
        dungeon_id  INTEGER REFERENCES dungeons(id),   -- 关联副本（DOORS:幸存者/实体…）
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (name, dungeon_id)
      )`);
      // 玩家阵营声望（-100~100，影响 NPC 态度/任务出现）
      db.exec(`CREATE TABLE IF NOT EXISTS faction_reputation (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        faction_id INTEGER NOT NULL REFERENCES factions(id),
        player_id  INTEGER NOT NULL REFERENCES players(id),
        value      INTEGER NOT NULL DEFAULT 0 CHECK (value >= -100 AND value <= 100),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (faction_id, player_id)
      )`);
      // NPC 定义（持久化身份：人格/目标/知识/阵营）
      db.exec(`CREATE TABLE IF NOT EXISTS npcs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        uid             TEXT UNIQUE,
        name            TEXT NOT NULL,
        description     TEXT,
        avatar          TEXT,                          -- 头像 URL 或 emoji
        personality_json TEXT NOT NULL DEFAULT '{}',
        goals_json      TEXT NOT NULL DEFAULT '[]',
        knowledge_json  TEXT NOT NULL DEFAULT '[]',
        faction_id      INTEGER REFERENCES factions(id),
        location_id     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // NPC 实例（副本/房间内；状态/存活/情绪/当前计划）
      db.exec(`CREATE TABLE IF NOT EXISTS npc_instances (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        npc_id              INTEGER NOT NULL REFERENCES npcs(id),
        room_id             TEXT NOT NULL,
        dungeon_instance_id INTEGER REFERENCES dungeon_instances(id),
        state_json          TEXT NOT NULL DEFAULT '{}',
        alive               INTEGER NOT NULL DEFAULT 1,
        mood                TEXT NOT NULL DEFAULT 'neutral',   -- neutral/friendly/afraid/hostile/grateful
        current_plan_json   TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (npc_id, room_id, dungeon_instance_id)
      )`);
      // NPC 长期记忆
      db.exec(`CREATE TABLE IF NOT EXISTS npc_memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        npc_id      INTEGER NOT NULL REFERENCES npcs(id),
        player_id   INTEGER REFERENCES players(id),
        memory_type TEXT NOT NULL CHECK (memory_type IN ('PLAYER_ACTION','CONVERSATION','EVENT','BETRAYAL','HELP','QUEST')),
        importance  INTEGER NOT NULL DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_npc_memories_npc ON npc_memories(npc_id, importance)');
      // NPC 关系（NPC↔玩家 / NPC↔NPC；value -100~100）
      db.exec(`CREATE TABLE IF NOT EXISTS npc_relationships (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type       TEXT NOT NULL CHECK (source_type IN ('npc','player')),
        source_id         INTEGER NOT NULL,
        target_type       TEXT NOT NULL CHECK (target_type IN ('npc','player')),
        target_id         INTEGER NOT NULL,
        value             INTEGER NOT NULL DEFAULT 0 CHECK (value >= -100 AND value <= 100),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_type, source_id, target_type, target_id)
      )`);
    },
  },
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

/** 应用全部迁移（幂等；按名称升序，保证依赖顺序）。 */
function runMigrations(db) {
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (const m of sorted) m.up(db);
}

module.exports = { runMigrations };
