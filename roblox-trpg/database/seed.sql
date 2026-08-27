-- ============================================================
-- 种子数据：仅预置【测试用副本的基础资料】。
--
-- 设计红线（必须遵守）：
--   1. 不在此处凭空预写技能、物品、奖励——那属于"副本设计阶段"的产物。
--   2. 副本/技能设计必须基于真实 Roblox Experience 的实际玩法，
--      流程：Web Search 收集资料 → AI 分析玩法 → 设计候选 →
--      游戏规则系统/人工审核 → approved 后方可发放给玩家。
--   3. 详见 docs/03-dungeon-design-pipeline.md。
-- ============================================================

-- 测试用副本基础资料（Doors / Jailbreak / Blox Fruits）
INSERT OR IGNORE INTO dungeons (roblox_experience_name, dungeon_name, difficulty, description) VALUES
  ('Doors',       '多尔斯旅馆',   2, '测试用副本。以旅馆探索为核心的生存体验，具体机制与奖励待副本设计阶段完成后补充。'),
  ('Jailbreak',   '越狱行动',     3, '测试用副本。以逃脱与对抗为核心的体验，具体机制与奖励待副本设计阶段完成后补充。'),
  ('Blox Fruits', '恶魔果实海域', 5, '测试用副本。以海域冒险与成长为核心的体验，具体机制与奖励待副本设计阶段完成后补充。');

-- 通用货币基础资料（奖励系统未来会用到）
INSERT OR IGNORE INTO currencies (name, description) VALUES
  ('金币', '灾变世界通用货币，可在副本中获得。');

-- ============================================================
-- 阶段3 测试奖励数据（TEST FIXTURES）
-- 说明：阶段3 要求「通关副本 → 获得该副本技能」的完整链路可演示。
-- 以下条目按 docs/03 流水线格式录入，并标记 status='approved'，
-- 作为已审核的测试数据；正式内容仍必须由 Web Search 设计流水线产出。
-- ============================================================

-- 副本 → Roblox ID 关联（Doors 为公开已知 ID；其余待设计阶段补充）
UPDATE dungeons SET roblox_universe_id = '2753915549', roblox_place_id = '6516141723'
  WHERE roblox_experience_name = 'Doors' AND roblox_universe_id IS NULL;

-- 测试技能（approved，source_type=DUNGEON：副本渠道，与 INITIAL_AVATAR 严格区分）
INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status) VALUES
  ('危险感知', '在威胁临近时获得直觉预警；可做一次骰子判定感知敌人位置。（资料出处：inspired）',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'DUNGEON', 'passive', 'rare', 'approved'),
  ('开锁能力', '可以撬开大多数机械锁。（资料出处：inspired）',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'), 'DUNGEON', 'active', 'common', 'approved'),
  ('果实能力', '获得一颗恶魔果实的力量（具体果实由规则系统决定）。（资料出处：inspired）',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Blox Fruits'), 'DUNGEON', 'active', 'legendary', 'approved');

-- 阶段3b：Avatar 初始技能（INITIAL_AVATAR，approved 测试夹具；由服务器 avatar_skill_rules 映射发放）
INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status) VALUES
  ('fire_affinity',      '火焰亲和：与火焰相关的检定获得情境加成。',        NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('ice_affinity',       '寒冰亲和：与寒冰相关的检定获得情境加成。',        NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('electric_affinity',  '雷电亲和：与电流相关的检定获得情境加成。',        NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('water_affinity',     '流水亲和：与水域相关的检定获得情境加成。',        NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('heavy_combat',       '重装战斗：穿戴重甲作战时更加得心应手。',          NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('ninja_mobility',     '忍者身法：攀爬、潜行与闪避动作更为敏捷。',       NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('aerial_adaptation',  '空中适应：拥有飞行或滑翔相关的行动能力。',        NULL, 'INITIAL_AVATAR', 'passive', 'epic', 'approved'),
  ('mechanical_affinity','机械亲和：操作与修理机械装置更加高效。',          NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('pirate_instinct',    '海盗直觉：航行、掠夺与海上生存嗅觉敏锐。',        NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('magic_affinity',     '魔法亲和：感知与运用魔力的天赋。',                NULL, 'INITIAL_AVATAR', 'passive', 'epic', 'approved'),
  ('marksman',           '神射手：远程射击检定获得情境加成。',              NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('royal_command',      '王室威仪：说服与指挥检定时更具影响力。',          NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('beast_sense',        '野兽感知：动物的直觉，察觉危险更早。',            NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('military_drill',     '军事训练：纪律化的战斗动作，稳定可靠。',          NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved');

-- 阶段6：技能声明式效果（effect_data）+ 冷却/次数（数据驱动，禁止代码执行）
UPDATE skills SET effect_data = '{"effects":[{"type":"ADVANTAGE","when":"danger_sense"}]}', cooldown_turns = 0 WHERE name = '危险感知' AND (effect_data IS NULL OR effect_data = '');
UPDATE skills SET effect_data = '{"effects":[{"type":"UNLOCK_ACTION","action":"pick_lock"}]}', cooldown_turns = 0 WHERE name = '开锁能力' AND (effect_data IS NULL OR effect_data = '');
UPDATE skills SET effect_data = '{"effects":[{"type":"DAMAGE","value":8}]}', cooldown_turns = 2 WHERE name = '果实能力' AND (effect_data IS NULL OR effect_data = '');
UPDATE skills SET effect_data = '{"effects":[{"type":"ROLL_MODIFIER","value":2,"when":"combat"}]}', cooldown_turns = 1 WHERE name = 'heavy_combat' AND (effect_data IS NULL OR effect_data = '');
UPDATE skills SET effect_data = '{"effects":[{"type":"ROLL_MODIFIER","value":2,"when":"stealth"}]}', cooldown_turns = 1 WHERE name = 'ninja_mobility' AND (effect_data IS NULL OR effect_data = '');
UPDATE skills SET effect_data = '{"effects":[{"type":"HEAL","value":5}]}', cooldown_turns = 2, max_uses = 3 WHERE name = 'magic_affinity' AND (effect_data IS NULL OR effect_data = '');

-- 阶段6：测试装备与消耗品（装备化 UPDATE 在文件末尾，确保物品已插入）
INSERT OR IGNORE INTO items (name, description, source_dungeon_id, source_type, rarity, status, kind, slot, stacking, stat_bonus) VALUES
  ('锈剑',     '一把陈旧但可靠的剑。',       (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'DUNGEON', 'common', 'approved', 'weapon', 'weapon', 'NON_STACKABLE', '{"STR":1}'),
  ('皮甲',     '轻便的防护。',               (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'DUNGEON', 'common', 'approved', 'armor', 'armor', 'NON_STACKABLE', '{"CON":1}'),
  ('幸运护符', '微微发光的护符。',           (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'DUNGEON', 'rare', 'approved', 'accessory', 'accessory', 'UNIQUE', '{"LUK":2}'),
  ('治疗药水', '恢复少量生命。',             NULL, 'original', 'common', 'approved', 'consumable', NULL, 'STACKABLE', NULL);

-- 阶段6：Doors 测试奖励链追加装备与货币（dungeon_rewards 多类型，阶段2 结构直接复用）
INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, reward_type, reward_id, drop_rate, is_guaranteed, status, condition_data) VALUES
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'item',
    (SELECT id FROM items WHERE name = '锈剑'), 1.0, 1, 'approved', '{"slot_hint":"weapon"}'),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'currency',
    (SELECT id FROM currencies WHERE name = '金币'), 1.0, 1, 'approved', '{"amount":500}');

-- 测试物品（approved）
INSERT OR IGNORE INTO items (name, description, source_dungeon_id, source_type, rarity, status) VALUES
  ('骨架钥匙', '开启一扇特殊门的钥匙。',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'official', 'rare', 'approved'),
  ('撬棍', '撬门与防身的万能工具。',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'), 'original', 'common', 'approved');

-- 副本奖励池（阶段3 的 grant_skill / grant_item 完全由本表驱动）
INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, reward_type, reward_id, drop_rate, is_guaranteed, status) VALUES
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'skill',
    (SELECT id FROM skills WHERE name = '危险感知'), 1.0, 1, 'approved'),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'item',
    (SELECT id FROM items WHERE name = '骨架钥匙'), 0.15, 0, 'approved'),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'), 'skill',
    (SELECT id FROM skills WHERE name = '开锁能力'), 1.0, 1, 'approved'),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'), 'item',
    (SELECT id FROM items WHERE name = '撬棍'), 0.5, 0, 'approved'),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Blox Fruits'), 'skill',
    (SELECT id FROM skills WHERE name = '果实能力'), 0.3, 0, 'approved');

-- 阶段6：物品装备化定义（必须位于物品 INSERT 之后）
UPDATE items SET kind = 'special', stacking = 'UNIQUE' WHERE name = '骨架钥匙' AND (kind IS NULL OR kind = 'material');
UPDATE items SET kind = 'weapon', slot = 'weapon', stacking = 'NON_STACKABLE', stat_bonus = '{"STR":2}' WHERE name = '撬棍' AND (kind IS NULL OR kind = 'material');

-- 阶段6：种子副本补齐 uid（迁移先于种子执行，故种子也需回填）
UPDATE dungeons SET uid = 'dungeon_' || REPLACE(LOWER(roblox_experience_name), ' ', '_') WHERE uid IS NULL;

-- ============================================================
-- 阶段8：示例任务（DOORS 主线 + 隐藏任务），PUBLISHED，可立即被副本加载
-- ============================================================
INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, dungeon_id, difficulty, max_players)
VALUES ('quest_doors_main', '逃离多尔斯旅馆', '进入多尔斯旅馆，找到钥匙，打开门，活着逃离。', 'MAIN', 'ACTIVE', 'DESIGNER',
        (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 3, 3);

INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","rewards":[{"type":"XP","amount":500},{"type":"CURRENCY","currency":"金币","amount":500},{"type":"SKILL","skill":"危险感知"}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_doors_main'
  AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id AND qv.version = 1);

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'enter_dungeon', '进入旅馆', '进入多尔斯旅馆副本', 'ENTER_DUNGEON', 1, 1, 0, '{}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_main' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'enter_dungeon');

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'find_key', '找到钥匙', '找到骨架钥匙', 'COLLECT_ITEM', 1, 2, 0, '{"event_type":"ITEM_ACQUIRED","match":{"item":"骨架钥匙"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_main' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'find_key');

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'open_door', '打开房门', '打开那扇门', 'OPEN_DOOR', 1, 3, 0, '{"event_type":"DOOR_OPENED","match":{"flag":"door_open"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_main' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'open_door');

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'escape', '逃离副本', '活着逃离多尔斯旅馆', 'ESCAPE', 1, 4, 0, '{}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_main' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'escape');

-- 隐藏任务：熄灯事件后触发发现
INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, dungeon_id, difficulty, max_players)
VALUES ('quest_doors_hidden', '不要回头', '它在看着你。别回头。', 'HIDDEN', 'ACTIVE', 'DESIGNER',
        (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 4, 3);

INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","hidden":true,"discovery":{"event_type":"WORLD_STATE_CHANGED","match":{"flag":"lights_out"},"count":1},"rewards":[{"type":"XP","amount":200}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_doors_hidden'
  AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id AND qv.version = 1);

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'reach_hall', '深入走廊', '不要回头，一直走到走廊深处', 'REACH_LOCATION', 1, 1, 0, '{"event_type":"PLAYER_ENTERED_SCENE","match":{"scene":"scene_hall"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_hidden' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'reach_hall');

-- ============================================================
-- 阶段9：DOORS 示例阵营与 NPC（幸存者/实体/旅馆管理员）+ 关系门控隐藏任务
-- ============================================================
INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id)
SELECT 'faction_doors_survivors', '幸存者', '在旅馆中挣扎求生的普通人。', id FROM dungeons WHERE roblox_experience_name = 'Doors';
INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id)
SELECT 'faction_doors_entities', '实体', '徘徊在旅馆中的危险存在。', id FROM dungeons WHERE roblox_experience_name = 'Doors';
INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id)
SELECT 'faction_doors_keeper', '旅馆管理员', '旅馆的神秘管理者，知道许多秘密。', id FROM dungeons WHERE roblox_experience_name = 'Doors';

INSERT OR IGNORE INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, faction_id, location_id)
SELECT 'npc_doors_keeper', '旅馆管理员', '一位提着油灯的老人，似乎知道旅馆的所有秘密。', '🏮',
  '{"traits":["谨慎","念旧"],"speech":"缓慢、低声"}',
  '["守护旅馆的秘密","寻找可信的幸存者"]',
  '["知道100号门后的真相"]',
  f.id, 'scene_lobby'
FROM factions f WHERE f.uid = 'faction_doors_keeper';

-- 关系门控隐藏任务：与旅馆管理员关系 ≥50 才会出现
INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, dungeon_id, difficulty, max_players)
SELECT 'quest_doors_keeper_secret', '旅馆管理员的秘密', '旅馆管理员似乎想告诉你一些关于100号门的事。', 'HIDDEN', 'ACTIVE', 'DESIGNER', d.id, 4, 3
FROM dungeons d WHERE d.roblox_experience_name = 'Doors';

INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","hidden":true,"npc_gate":{"npc":"npc_doors_keeper","min_relationship":50},"rewards":[{"type":"XP","amount":300}],"objectives":[{"key":"listen_keeper","name":"聆听秘密","description":"听旅馆管理员讲完100号门的真相","type":"TALK_TO_NPC","required_count":1,"order_index":1}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_doors_keeper_secret'
  AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id AND qv.version = 1);

INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'listen_keeper', '聆听秘密', '听旅馆管理员讲完100号门的真相', 'TALK_TO_NPC', 1, 1, 0, '{"event_type":"NPC_TALKED","match":{"npc":"npc_doors_keeper"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_doors_keeper_secret'
  AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'listen_keeper');
