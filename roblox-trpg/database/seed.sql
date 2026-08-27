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
