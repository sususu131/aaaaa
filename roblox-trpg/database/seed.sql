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

-- 阶段34：Vision 词库基础技能（INITIAL_AVATAR；由 visualSkillMappings.json 视觉标签映射发放）
INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, source_type, skill_type, rarity, status) VALUES
  ('feline_instinct',     '猫科本能：敏锐的猫科感知与反应能力。',          NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('swordsmanship',       '剑术：使用剑类武器进行战斗的能力。',            NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('archery',             '弓术：擅长使用弓类远程武器。',                  NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('firearms',            '枪械：具备使用枪械进行战斗的能力。',            NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('quick_draw',          '快速拔枪：能够快速拔出并使用腰间枪械。',        NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('stealth',             '潜行：擅长隐藏自己的行动和位置。',              NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('tracking',            '追踪：能够根据环境与目标留下的痕迹追踪目标。',  NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('investigation',       '调查：擅长寻找线索、分析现场和调查目标。',      NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('intimidation',        '威吓：利用外貌、装备或身份施加心理压力。',      NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('medicine',            '医疗：具备治疗伤势和处理医疗问题的能力。',      NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('spellcasting',        '施法：能够使用魔法类能力。',                    NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('shield_mastery',      '盾牌掌握：擅长使用盾牌进行防御。',              NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('dual_wield',          '双持：能够同时使用两把单手武器。',              NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved'),
  ('knife_mastery',       '短刀掌握：擅长使用匕首和短刀。',                NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('spear_mastery',       '长枪掌握：擅长使用长枪、矛等长柄刺击武器。',    NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('axe_mastery',         '斧术：擅长使用斧类武器。',                      NULL, 'INITIAL_AVATAR', 'passive', 'common', 'approved'),
  ('greatsword_mastery',  '巨剑掌握：擅长使用大型双手剑。',                NULL, 'INITIAL_AVATAR', 'passive', 'rare', 'approved');

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

-- ============================================================
-- 阶段10：传奇人物（不是管理员/权限账号，是世界中的特殊存在）
-- ============================================================
-- 基础 NPC 定义（传奇人物挂靠在 npcs 上；nature=neutral 可建立关系）
INSERT OR IGNORE INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, nature)
VALUES ('npc_legend_shedletsky', 'Shedletsky', '传说中的剑术大师，手持连击之剑。', '⚔️',
  '{"traits":["高傲","重荣誉"],"speech":"简洁、锋利"}', '["寻找配得上剑道的挑战者"]', '["通晓所有剑类知识"]', 'neutral');
INSERT OR IGNORE INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, nature)
VALUES ('npc_legend_builderman', 'Builderman', '世界的创造者之一，乐于助人并出售建造装备。', '🏗️',
  '{"traits":["热心","务实"],"speech":"明快、鼓励"}', '["帮助幸存者重建世界"]', '["掌握建造科技"]', 'neutral');
INSERT OR IGNORE INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, nature)
VALUES ('npc_legend_lsplash', 'LSPLASH', '多尔斯旅馆的建筑师，知道旅馆的每一条走廊与每一个实体。', '🚪',
  '{"traits":["神秘","谨慎"],"speech":"低声、断续"}', '["守护旅馆最后的秘密"]', '["知晓全部实体的弱点"]', 'neutral');
-- 实体阵营的 NPC 设为 hostile 本性：好感度不改变敌对行为
UPDATE npcs SET nature = 'hostile' WHERE uid LIKE 'npc_entity%' OR uid IN (SELECT n.uid FROM npcs n JOIN factions f ON f.id = n.faction_id WHERE f.uid = 'faction_doors_entities');

-- 传奇人物档案
INSERT OR IGNORE INTO legendary_npcs (npc_id, display_name, title, description, origin_type, origin_experience, rarity, base_power, personality_json, ability_json, power_rules_json, spawn_rules_json, equipment_rules_json)
SELECT n.id, 'Shedletsky', 'The Sword Master', '剑术大师。所有剑类熟练度提升。', 'LEGEND', 'Sword Fight on the Heights', 'legendary', 90,
  '{"traits":["高傲","重荣誉"]}',
  '[{"key":"sword_mastery","name":"Sword Mastery","description":"所有剑类熟练度提升"},{"key":"legendary_slash","name":"Legendary Slash","description":"强力剑技"},{"key":"sword_knowledge","name":"Sword Knowledge","description":"识别所有剑"}]',
  '{"default":0.4,"Sword Fight on the Heights":1.0,"FORSAKEN":0.2}',
  '{"base_chance":0.02,"experience_boost":{"Sword Fight on the Heights":0.25},"min_level":1}',
  '{"default":{"allowed":["普通剑"],"legendary_allowed":false},"Sword Fight on the Heights":{"legendary_allowed":true},"FORSAKEN":{"pool":[{"item":"Linked Sword","chance":0.95},{"item":"Light Sword","chance":0.05}]}}'
FROM npcs n WHERE n.uid = 'npc_legend_shedletsky'
  AND NOT EXISTS (SELECT 1 FROM legendary_npcs ln JOIN npcs m ON m.id = ln.npc_id WHERE m.uid = 'npc_legend_shedletsky');

INSERT OR IGNORE INTO legendary_npcs (npc_id, display_name, title, description, origin_type, origin_experience, rarity, base_power, personality_json, ability_json, power_rules_json, spawn_rules_json, equipment_rules_json)
SELECT n.id, 'Builderman', 'The Creator', '创造者。出售建造科技装备。', 'CREATOR', 'Roblox Platform', 'mythic', 100,
  '{"traits":["热心","务实"]}',
  '[{"key":"creation_knowledge","name":"Creation Knowledge","description":"掌握建造科技"}]',
  '{"default":0.6,"Roblox Platform":1.0}',
  '{"base_chance":0.03,"experience_boost":{},"min_level":1}',
  '{}'
FROM npcs n WHERE n.uid = 'npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_npcs ln JOIN npcs m ON m.id = ln.npc_id WHERE m.uid = 'npc_legend_builderman');

INSERT OR IGNORE INTO legendary_npcs (npc_id, display_name, title, description, origin_type, origin_experience, rarity, base_power, personality_json, ability_json, power_rules_json, spawn_rules_json, equipment_rules_json)
SELECT n.id, 'LSPLASH', 'Hotel Architect', '旅馆建筑师。知晓副本与实体的知识。', 'EXPERIENCE_AUTHOR', 'DOORS', 'legendary', 80,
  '{"traits":["神秘","谨慎"]}',
  '[{"key":"dungeon_knowledge","name":"Dungeon Knowledge","description":"副本知识"},{"key":"entity_knowledge","name":"Entity Knowledge","description":"实体资料"},{"key":"experience_control","name":"Experience Control","description":"体验控制"}]',
  '{"default":0.3,"DOORS":1.0}',
  '{"base_chance":0.01,"experience_boost":{"DOORS":0.3},"min_level":1}',
  '{}'
FROM npcs n WHERE n.uid = 'npc_legend_lsplash'
  AND NOT EXISTS (SELECT 1 FROM legendary_npcs ln JOIN npcs m ON m.id = ln.npc_id WHERE m.uid = 'npc_legend_lsplash');

-- 传奇装备物品（科技类/剑类 —— 均为数据库登记的合法物品，不可凭空创造）
INSERT OR IGNORE INTO items (name, description, source_type, rarity, status, kind, slot, stacking, stat_bonus) VALUES
  ('普通剑',         '一把可靠的剑。',           'original', 'common', 'approved', 'weapon', 'weapon', 'NON_STACKABLE', '{"STR":1}'),
  ('Linked Sword',  '连击之剑，剑术大师的佩剑。', 'original', 'legendary', 'approved', 'weapon', 'weapon', 'UNIQUE', '{"STR":3,"DEX":1}'),
  ('Light Sword',   '光之剑，极低概率的传奇武器。', 'original', 'legendary', 'approved', 'weapon', 'weapon', 'UNIQUE', '{"STR":4,"DEX":2}'),
  ('Build Wall',    '建造一堵墙。',               'original', 'common', 'approved', 'material', NULL, 'STACKABLE', NULL),
  ('Auto Turret',   '自动炮塔。',                 'original', 'epic', 'approved', 'special', NULL, 'NON_STACKABLE', NULL),
  ('Healing Station','治疗站。',                  'original', 'rare', 'approved', 'special', NULL, 'NON_STACKABLE', NULL),
  ('Shield Generator','护盾发生器。',              'original', 'epic', 'approved', 'special', NULL, 'NON_STACKABLE', NULL),
  ('Emergency Repair Kit','应急修理包。',          'original', 'common', 'approved', 'consumable', NULL, 'STACKABLE', NULL);

-- Builderman 商店（关系等级门控）
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 100, '{"relationship":10}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Build Wall' WHERE n.uid='npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 200, '{"relationship":30}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Healing Station' WHERE n.uid='npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 300, '{"relationship":50}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Shield Generator' WHERE n.uid='npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 500, '{"relationship":90}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Auto Turret' WHERE n.uid='npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 80, '{"relationship":0}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Emergency Repair Kit' WHERE n.uid='npc_legend_builderman'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);

-- Shedletsky 商店（剑类；关系50解锁普通剑，关系80解锁连击之剑）
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 150, '{"relationship":50}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='普通剑' WHERE n.uid='npc_legend_shedletsky'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);
INSERT OR IGNORE INTO legendary_shop_items (legendary_npc_id, item_id, price, requirements_json)
SELECT ln.id, i.id, 2000, '{"relationship":80,"faction_reputation":{"faction":"幸存者","value":30}}' FROM legendary_npcs ln JOIN npcs n ON n.id=ln.npc_id JOIN items i ON i.name='Linked Sword' WHERE n.uid='npc_legend_shedletsky'
  AND NOT EXISTS (SELECT 1 FROM legendary_shop_items s WHERE s.legendary_npc_id = ln.id AND s.item_id = i.id);

-- 传奇技能（任务奖励专用，approved）
INSERT OR IGNORE INTO skills (name, description, source_type, skill_type, rarity, status, effect_data) VALUES
  ('Sword Technique',  '剑术技法：剑类攻击检定获得优势。', 'original', 'passive', 'epic', 'approved', '{"effects":[{"type":"ROLL_MODIFIER","value":2,"when":"sword"}]}'),
  ('Construction Skill','建造技能：可建造防御工事。',      'original', 'active', 'rare', 'approved', '{"effects":[{"type":"UNLOCK_ACTION","action":"build"}]}');

-- 传奇任务（复用任务系统；npc_gate 绑定传奇人物）
INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, difficulty, max_players)
SELECT 'quest_legend_first_sword', '失落的第一把剑', 'Shedletsky 遗失了他的第一把剑。帮他找回来。', 'SIDE', 'ACTIVE', 'DESIGNER', 4, 3
WHERE NOT EXISTS (SELECT 1 FROM quests WHERE uid = 'quest_legend_first_sword');
INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","npc_gate":{"npc":"npc_legend_shedletsky","min_relationship":50},"rewards":[{"type":"SKILL","skill":"Sword Technique"},{"type":"XP","amount":500}],"objectives":[{"key":"find_first_sword","name":"寻回第一把剑","description":"找到失落的第一把剑","type":"COLLECT_ITEM","required_count":1,"order_index":1}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_legend_first_sword' AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id);
INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'find_first_sword', '寻回第一把剑', '找到失落的第一把剑', 'COLLECT_ITEM', 1, 1, 0, '{"event_type":"ITEM_ACQUIRED","match":{"item":"普通剑"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id WHERE q.uid = 'quest_legend_first_sword'
  AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'find_first_sword');

INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, difficulty, max_players)
SELECT 'quest_legend_rebuild', '重建世界', 'Builderman 想重建世界，需要你的帮助。', 'SIDE', 'ACTIVE', 'DESIGNER', 3, 3
WHERE NOT EXISTS (SELECT 1 FROM quests WHERE uid = 'quest_legend_rebuild');
INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","npc_gate":{"npc":"npc_legend_builderman","min_relationship":50},"rewards":[{"type":"SKILL","skill":"Construction Skill"},{"type":"XP","amount":400}],"objectives":[{"key":"gather_materials","name":"收集建材","description":"收集建造材料","type":"COLLECT_ITEM","required_count":1,"order_index":1}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_legend_rebuild' AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id);
INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'gather_materials', '收集建材', '收集建造材料', 'COLLECT_ITEM', 1, 1, 0, '{"event_type":"ITEM_ACQUIRED","match":{"item":"Build Wall"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id WHERE q.uid = 'quest_legend_rebuild'
  AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'gather_materials');

INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, difficulty, max_players)
SELECT 'quest_legend_hotel_secret', '酒店最后的秘密', 'LSPLASH 知道酒店最后的秘密，但他只告诉信任的人。', 'SIDE', 'ACTIVE', 'DESIGNER', 5, 3
WHERE NOT EXISTS (SELECT 1 FROM quests WHERE uid = 'quest_legend_hotel_secret');
INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","npc_gate":{"npc":"npc_legend_lsplash","min_relationship":50},"rewards":[{"type":"SKILL","skill":"危险感知"},{"type":"XP","amount":600}],"objectives":[{"key":"earn_trust","name":"赢得信任","description":"帮助 LSPLASH 完成一件事","type":"INTERACT","required_count":1,"order_index":1}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_legend_hotel_secret' AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id);
INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'earn_trust', '赢得信任', '帮助 LSPLASH 完成一件事', 'INTERACT', 1, 1, 0, '{"event_type":"NPC_HELPED","match":{"npc":"npc_legend_lsplash"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id WHERE q.uid = 'quest_legend_hotel_secret'
  AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'earn_trust');

-- ============================================================
-- 阶段11：SFOTH 真实剑库（公开资料中的经典剑；资料不足标记 unknown，禁止编造）
-- ============================================================
INSERT OR IGNORE INTO experience_items (name, source_experience, description, rarity, original_ability, status) VALUES
  ('Linked Sword',      'Sword Fight on the Heights', '经典连击之剑，剑斗的象征。', 'common', '基础剑术连击', 'approved'),
  ('Fire Sword',        'Sword Fight on the Heights', '燃烧之剑，攻击附带火焰。', 'rare', '火焰斩击', 'approved'),
  ('Ice Dagger',        'Sword Fight on the Heights', '寒冰匕首，轻巧迅捷。', 'rare', '冰冻突刺', 'approved'),
  ('Darkheart',         'Sword Fight on the Heights', '黑暗之心，吸血魔剑。', 'epic', '生命汲取', 'approved'),
  ('Venoms Edge',       'Sword Fight on the Heights', '毒刃，攻击附带毒素。', 'epic', '淬毒攻击', 'approved'),
  ('Illumina',          'Sword Fight on the Heights', '光之圣剑，传说中的武器。', 'legendary', '光辉斩', 'approved'),
  ('Ghostwalker',       'Sword Fight on the Heights', '幽灵行者，神秘之剑。', 'legendary', '幽影步', 'approved'),
  ('未知古剑',           'Sword Fight on the Heights', '资料不足，能力未知。', 'common', 'UNKNOWN', 'unknown');

-- 跨副本装备削弱规则：不同世界规则不同（SFOTH 传奇剑在 DOORS 大幅削弱）
INSERT OR IGNORE INTO item_balance_rules (item_name, source_experience, target_experience, multiplier) VALUES
  ('Linked Sword', 'Sword Fight on the Heights', 'DOORS', 0.2),
  ('Fire Sword',   'Sword Fight on the Heights', 'DOORS', 0.2),
  ('Darkheart',    'Sword Fight on the Heights', 'DOORS', 0.2),
  ('Illumina',     'Sword Fight on the Heights', 'DOORS', 0.25),
  ('Linked Sword', 'Sword Fight on the Heights', 'FORSAKEN', 0.3);

-- 传奇人物遭遇规则：遭遇概率 + 战斗奖励池（奖励池物品必须来自数据库，服务器验证）
UPDATE legendary_npcs SET encounter_rules_json = '{
  "encounter_chance": 0.05,
  "behaviors": ["dialog", "combat", "guidance", "quest"],
  "combat_reward_pool": [
    {"type": "guidance", "weight": 25, "skill": "Sword Technique", "description": "剑术指导：剑术精通 +1"},
    {"type": "item", "weight": 20, "experience": "Sword Fight on the Heights", "description": "随机体验物品"},
    {"type": "knowledge", "weight": 20, "flag": "sword_knowledge", "description": "解锁世界信息"},
    {"type": "currency", "weight": 20, "amount": 50, "description": "少量金币"},
    {"type": "story", "weight": 15, "flag": "shedletsky_story_branch", "description": "特殊剧情分支"}
  ]
}' WHERE display_name = 'Shedletsky';

UPDATE legendary_npcs SET encounter_rules_json = '{
  "encounter_chance": 0.08,
  "behaviors": ["dialog", "shop", "guidance"],
  "combat_reward_pool": []
}' WHERE display_name = 'Builderman';

UPDATE legendary_npcs SET encounter_rules_json = '{
  "encounter_chance": 0.05,
  "behaviors": ["dialog", "guidance", "quest"],
  "combat_reward_pool": [
    {"type": "knowledge", "weight": 40, "flag": "doors_entity_knowledge", "description": "实体资料"},
    {"type": "guidance", "weight": 30, "skill": "危险感知", "description": "危险感知指导"},
    {"type": "currency", "weight": 30, "amount": 30, "description": "少量金币"}
  ]
}' WHERE display_name = 'LSPLASH';

UPDATE legendary_npcs SET creator_type = 'CREATOR' WHERE display_name = 'Shedletsky';
UPDATE legendary_npcs SET creator_type = 'ADMIN' WHERE display_name = 'Builderman';
UPDATE legendary_npcs SET creator_type = 'CREATOR' WHERE display_name = 'LSPLASH';

-- ============================================================
-- 阶段12：World Simulation & Dynamic Event System
-- ============================================================
-- 世界地点（NPC 移动系统的节点；安全点 = FLEEING 目标）
INSERT OR IGNORE INTO npc_locations (key, name, description, is_safe) VALUES
  ('loc_lobby',    '大厅',   '旅馆大厅，幸存者聚集的相对安全区域。', 1),
  ('loc_corridor', '走廊',   '昏暗的走廊，连接大厅与深处。', 0),
  ('loc_basement', '地下室', '隐藏的地下室，知道的人不多。', 0),
  ('loc_gate',     '出入口', '通往外界的出入口。', 1),
  ('loc_watch',    '瞭望台', '可以观察远处动静的高处。', 0);

-- 阵营关系初始状态：不再写死于 seed（阶段20 修复）。
-- 初始关系由各预设 JSON 的 faction_relations 声明（如 doors.json：幸存者↔实体 天生敌对、
-- 幸存者↔旅馆管理员 保持观望；dod.json：Civilian↔Killer 天生敌对、Civilian↔Government 观望），
-- 由 presetSeeder 导入时幂等落库；运行期改动（FACTION_WAR 等）不会被重复导入覆盖。

-- 传奇人物世界模拟条件（不是简单随机：由剑术/世界状态/剧情决定；保留原有概率键）
UPDATE legendary_npcs SET spawn_rules_json = '{"base_chance":0.02,"experience_boost":{"Sword Fight on the Heights":0.25},"min_level":1,"world_conditions":{"any_skill":["Sword","剑"],"any_world_flag":["sword_knowledge"],"min_quest_progress":1}}' WHERE display_name = 'Shedletsky';
UPDATE legendary_npcs SET spawn_rules_json = '{"base_chance":0.03,"experience_boost":{},"min_level":1,"world_conditions":{"always":true}}' WHERE display_name = 'Builderman';
UPDATE legendary_npcs SET spawn_rules_json = '{"base_chance":0.01,"experience_boost":{"DOORS":0.3},"min_level":1,"world_conditions":{"any_world_flag":["doors_entity_knowledge"],"active_event":"POWER_OUTAGE"}}' WHERE display_name = 'LSPLASH';

-- 世界模拟示例任务门控：停电事件发生后出现的调查任务（EVENT 类型，发现条件 = 世界事件）
INSERT OR IGNORE INTO quests (uid, name, description, type, status, source_type, dungeon_id, difficulty, max_players)
SELECT 'quest_world_blackout', '查明停电原因', '旅馆突然陷入黑暗。有人说是发电机，有人说……是别的东西。', 'EVENT', 'ACTIVE', 'DESIGNER',
       (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 3, 3
WHERE NOT EXISTS (SELECT 1 FROM quests WHERE uid = 'quest_world_blackout');
INSERT OR IGNORE INTO quest_versions (quest_id, version, definition_json, status, published_at)
SELECT q.id, 1, '{"scope":"PARTY","hidden":true,"discovery":{"event_type":"WORLD_EVENT_STARTED","match":{"event":"POWER_OUTAGE"},"count":1},"rewards":[{"type":"XP","amount":250}]}', 'PUBLISHED', datetime('now')
FROM quests q WHERE q.uid = 'quest_world_blackout'
  AND NOT EXISTS (SELECT 1 FROM quest_versions qv WHERE qv.quest_id = q.id AND qv.version = 1);
INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
SELECT qv.id, 'inspect_basement', '检查地下室', '到地下室查看发电机状况', 'REACH_LOCATION', 1, 1, 0, '{"event_type":"LOCATION_REACHED","match":{"location":"loc_basement"}}'
FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
WHERE q.uid = 'quest_world_blackout' AND NOT EXISTS (SELECT 1 FROM quest_objectives WHERE quest_version_id = qv.id AND objective_key = 'inspect_basement');

-- ============================================================
-- 阶段14：Persistent Inventory & Item System
-- ============================================================
-- 物品定义桥接：既有 approved 旧物品（items）→ item_definitions（不改旧表语义）
INSERT OR IGNORE INTO item_definitions (item_key, name, description, type, rarity, stack_limit, metadata_json, source, status)
SELECT
  REPLACE(i.name, ' ', '_'), i.name, COALESCE(i.description, ''),
  CASE i.kind WHEN 'weapon' THEN 'WEAPON' WHEN 'armor' THEN 'ARMOR' WHEN 'consumable' THEN 'CONSUMABLE'
              WHEN 'accessory' THEN 'SPECIAL' WHEN 'special' THEN 'SPECIAL' ELSE 'MATERIAL' END,
  CASE i.rarity WHEN 'common' THEN 'COMMON' WHEN 'rare' THEN 'RARE' WHEN 'epic' THEN 'EPIC' ELSE 'LEGENDARY' END,
  CASE i.stacking WHEN 'STACKABLE' THEN 99 ELSE 1 END,
  COALESCE(NULLIF(i.stat_bonus, ''), '{}'), i.source_type, 'approved'
FROM items i WHERE i.status = 'approved';

-- SFOTH 真实剑库 → 永久物品定义（基础强度为灾变世界规则，TRPG_ORIGINAL；能力描述沿用公开资料标注）
INSERT OR IGNORE INTO item_definitions (item_key, name, description, type, rarity, stack_limit, permanent, base_power, metadata_json, source, status) VALUES
  ('Linked_Sword', 'Linked Sword', '经典连击之剑，剑斗的象征。', 'WEAPON', 'COMMON', 1, 1, 40, '{"damage":40,"element":"none","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Fire_Sword',   'Fire Sword',   '燃烧之剑，攻击附带火焰。',   'WEAPON', 'RARE',   1, 1, 55, '{"damage":55,"element":"fire","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Ice_Dagger',   'Ice Dagger',   '寒冰匕首，轻巧迅捷。',       'WEAPON', 'RARE',   1, 1, 50, '{"damage":50,"element":"ice","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Darkheart',    'Darkheart',    '黑暗之心，吸血魔剑。',       'WEAPON', 'EPIC',   1, 1, 70, '{"damage":70,"element":"dark","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Venoms_Edge',  'Venoms Edge',  '毒刃，攻击附带毒素。',       'WEAPON', 'EPIC',   1, 1, 70, '{"damage":70,"element":"poison","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Illumina',     'Illumina',     '光之圣剑，传说中的武器。',   'WEAPON', 'LEGENDARY', 1, 1, 100, '{"damage":100,"element":"light","source":"Sword Fight on the Heights"}', 'official', 'approved'),
  ('Ghostwalker',  'Ghostwalker',  '幽灵行者，神秘之剑。',       'WEAPON', 'LEGENDARY', 1, 1, 85, '{"damage":85,"element":"ghost","source":"Sword Fight on the Heights"}', 'official', 'approved');

-- 任务物品示例：旅馆钥匙（绑定 + 任务元数据）
INSERT OR IGNORE INTO item_definitions (item_key, name, description, type, rarity, stack_limit, bind_on_acquire, metadata_json, source, status) VALUES
  ('DOORS_KEY', '旅馆钥匙', '多尔斯旅馆某扇门的钥匙，微微发凉。', 'QUEST_ITEM', 'RARE', 1, 1, '{"quest_id":"quest_doors_main"}', 'inspired', 'approved');

-- 治疗药水补充消耗品元数据（使用效果：恢复生命）
UPDATE item_definitions SET metadata_json = '{"heal":10}', type = 'CONSUMABLE' WHERE item_key = '治疗药水';

-- 跨副本削弱：世界规则限制（用户基准示例：Illumina 原始 100 → DOORS 30；不删除物品）
UPDATE item_balance_rules SET multiplier = 0.3 WHERE item_name = 'Illumina' AND target_experience = 'DOORS';

-- ============================================================
-- 阶段15：Playable Experience System —— 内容转正
-- ============================================================
-- 副本描述转正（不再标注"测试用"；机制与奖励由既有奖励表驱动）
UPDATE dungeons SET description = '以旅馆探索为核心的生存体验：100号门的传说在幸存者之间流传。入住者需要找到钥匙、避开实体，活着离开。' WHERE roblox_experience_name = 'Doors' AND description LIKE '%测试用%';
UPDATE dungeons SET description = '以逃脱与对抗为核心的体验：警车、金库与自由的边界。选择越狱或执法，命运由你自己决定。' WHERE roblox_experience_name = 'Jailbreak' AND description LIKE '%测试用%';
UPDATE dungeons SET description = '以海域冒险与成长为核心的体验：恶魔果实的能力者在大海上争夺霸权。' WHERE roblox_experience_name = 'Blox Fruits' AND description LIKE '%测试用%';

-- DOORS 正式版副本定义（新手完整流程：大厅→走廊→客房→逃生之门；5~15 分钟）
INSERT OR IGNORE INTO official_dungeon_definitions (dungeon_name, definition_json, description)
SELECT 'Doors', '{"dungeon":{"display_name":"多尔斯旅馆"},"roblox_universe_id":"2753915549","scenes":[{"id":"scene_lobby","name":"旅馆大厅","description":"昏暗的大厅，油灯在墙上投下摇晃的影子。旅馆管理员提着灯站在那里，似乎在等什么人。","source_type":"TRPG_ORIGINAL","order":1,"possible_actions":["与管理员交谈","环顾四周","前往走廊"],"exits":["scene_hall"],"encounters":[],"events":["evt_entry"]},{"id":"scene_hall","name":"幽暗走廊","description":"长廊幽深，地毯吸走了脚步声。阴影里有东西在蠕动。","source_type":"TRPG_ORIGINAL","order":2,"possible_actions":["小心前进","搜索两侧房间","返回大厅"],"exits":["scene_rooms","scene_lobby"],"encounters":["enc_entity"],"events":[]},{"id":"scene_rooms","name":"客房区","description":"一间间紧闭的房门。其中一扇门缝里透出微光，像是什么东西在发光。","source_type":"TRPG_ORIGINAL","order":3,"possible_actions":["搜查发光的房间","聆听门后动静","返回走廊"],"exits":["scene_gate","scene_hall"],"encounters":[],"events":["evt_key"]},{"id":"scene_gate","name":"逃生之门","description":"走廊尽头是一扇厚重的铁门，锁孔泛着冷光。身后传来沉重的呼吸声。","source_type":"TRPG_ORIGINAL","order":4,"possible_actions":["用钥匙开门","屏息潜行","返回"],"exits":[],"encounters":["enc_figure"],"events":[]}],"encounters":[{"id":"enc_entity","name":"实体遭遇","type":"COMBAT","description":"阴影中窜出实体，走廊的温度骤降。","participants":["shadow_entity"],"trigger":"","resolution":"","difficulty":2,"possible_checks":[],"source_type":"TRPG_ORIGINAL"},{"id":"enc_figure","name":"Figure 拦路","type":"COMBAT","description":"Figure 循声而来，守在门前。","participants":["boss_figure"],"trigger":"","resolution":"","difficulty":4,"possible_checks":[],"source_type":"TRPG_ORIGINAL"}],"enemies":[{"id":"shadow_entity","name":"暗影实体","description":"徘徊在走廊的阴影，畏光。","source_type":"TRPG_ORIGINAL","stats":{"hp":26,"damage":4},"skills":[],"behaviour":"attack|attack|defend|chase","weaknesses":["光"],"resistances":[],"loot":[{"type":"currency","amount":60},{"type":"item","item":"治疗药水","chance":0.5}]}],"boss":{"id":"boss_figure","name":"Figure","description":"盲眼巨兽，靠声音狩猎。","phases":["P1","P2","ENRAGE"],"stats":{"hp":70,"damage":7},"skills":[{"key":"sonic_slam","name":"音波重击","multiplier":1.5}],"behaviour":"boss","conditions":[],"rewards":[],"source_type":"TRPG_ORIGINAL"},"npcs":[{"uid":"npc_doors_keeper","spawn_scene":"scene_lobby"}],"events":[{"id":"evt_entry","name":"入住","description":"你们踏入了旅馆，门在身后合上。"},{"id":"evt_key","name":"钥匙微光","description":"某个房间里似乎有东西在发光。"}],"reward_candidates":[],"created_at":"2026-01-01T00:00:00.000Z"}', '多尔斯旅馆官方新手流程（5~15分钟完整闭环）'
FROM dungeons d WHERE d.roblox_experience_name = 'Doors';
