-- 未来副本/技能种子数据（仅数据，阶段1不实现相关逻辑）
-- Doors → 危险感知；Jailbreak → 开锁能力；Blox Fruits → 果实能力

INSERT OR IGNORE INTO dungeons (roblox_experience_name, dungeon_name, difficulty, description) VALUES
  ('Doors',       '多尔斯旅馆',     2, '每一扇门后都可能有东西在等你。学会倾听，才能活到第100扇门。'),
  ('Jailbreak',   '越狱行动',       3, '警察与劫匪的永恒战争。开锁、驾驶、策划——自由属于最大胆的人。'),
  ('Blox Fruits', '恶魔果实海域',   5, '吃下果实，获得力量，也从此被大海诅咒。伟大航路上见。');

INSERT OR IGNORE INTO skills (name, description, source_dungeon_id, rarity) VALUES
  ('危险感知', '在威胁临近时获得直觉预警。',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'), 'rare'),
  ('开锁能力', '可以打开大多数机械锁。',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'), 'common'),
  ('果实能力', '获得一颗恶魔果实的力量（具体果实待定）。',
    (SELECT id FROM dungeons WHERE roblox_experience_name = 'Blox Fruits'), 'legendary');

INSERT OR IGNORE INTO dungeon_rewards (dungeon_id, skill_id, drop_rate, is_guaranteed) VALUES
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Doors'),
   (SELECT id FROM skills WHERE name = '危险感知'), 1.0, 1),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Jailbreak'),
   (SELECT id FROM skills WHERE name = '开锁能力'), 1.0, 1),
  ((SELECT id FROM dungeons WHERE roblox_experience_name = 'Blox Fruits'),
   (SELECT id FROM skills WHERE name = '果实能力'), 0.3, 0);
