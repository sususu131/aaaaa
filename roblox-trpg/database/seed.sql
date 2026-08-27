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

-- 注意：此处【没有】任何 skills / items / dungeon_rewards 数据。
-- 这些内容必须由副本设计流水线产出并经规则系统审核，不允许在初始化阶段臆造。
