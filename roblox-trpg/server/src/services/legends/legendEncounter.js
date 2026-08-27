/**
 * Legendary Encounter Engine（阶段11）：
 * 遭遇判定 / 战斗奖励池 / 永久物品 / 跨副本削弱 / 剑斗完成度奖励。
 * 红线：所有奖励经服务器验证（RewardValidator）；AI 不能发放永久装备/修改价格/创造物品。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const legendEngine = require('./legendEngine');
const npcEngine = require('../npcs/npcEngine');

class EncounterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

function getLegendRules(legendId) {
  const row = getDb().prepare('SELECT encounter_rules_json FROM legendary_npcs WHERE id = ?').get(legendId);
  return row ? parseJson(row.encounter_rules_json, {}) : {};
}

// ── 遭遇判定（服务器掷骰；概率 = 基础 × 副本 × 幸运 × 任务进度 × 剧情）──
/**
 * 尝试遭遇传奇人物。返回 { legend, chance } 或 { legend: null }。
 * @param opts rng 可注入（测试）；luckBonus 来自玩家幸运属性；questProgress 已完成任务数
 */
function encounterCheck(io, roomId, { dungeonInstance = null, luckBonus = 0, questProgress = 0, storyBonus = 0, rng = null } = {}) {
  const legends = legendEngine.allLegends();
  const existingNpcIds = new Set(npcEngine.npcInstancesInRoom(roomId).map((ni) => ni.npc_id));
  const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;

  let cumulative = 0;
  for (const legend of legends) {
    if (existingNpcIds.has(legend.npc_id)) continue;
    const rules = getLegendRules(legend.id);
    let chance = Number(rules.encounter_chance) || 0;
    // 副本匹配提升（spawn_rules experience_boost）
    const spawnRules = parseJson(legend.spawn_rules_json, {});
    if (dungeonInstance && spawnRules.experience_boost && dungeonInstance.experienceName && spawnRules.experience_boost[dungeonInstance.experienceName] !== undefined) {
      chance = Math.max(chance, Number(spawnRules.experience_boost[dungeonInstance.experienceName]));
    }
    chance += Math.min(0.1, luckBonus * 0.01);      // 幸运属性
    chance += Math.min(0.05, questProgress * 0.005); // 任务进度
    chance += Math.min(0.1, storyBonus);             // 剧情状态
    chance = Math.max(0, Math.min(0.9, chance));

    if (roll < cumulative + chance) {
      const inst = npcEngine.spawnNpcInstance(io, { npcId: legend.npc_id, roomId, dungeonInstanceId: dungeonInstance ? dungeonInstance.id : null });
      const gameEvents = require('../quests/gameEvents');
      gameEvents.emit(io, roomId, {
        type: 'NPC_ENCOUNTER_CHECK',
        actor: null,
        data: { result: 'FOUND', legend: legend.display_name, chance, dungeonInstanceId: dungeonInstance ? dungeonInstance.id : null },
        instanceId: dungeonInstance ? dungeonInstance.id : null,
      });
      gameEvents.emit(io, roomId, { type: 'LEGENDARY_NPC_FOUND', actor: null, data: { legendId: legend.id, name: legend.display_name, rarity: legend.rarity }, instanceId: inst.dungeon_instance_id });
      return { legend, chance };
    }
    cumulative += chance;
  }
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'NPC_ENCOUNTER_CHECK', actor: null, data: { result: 'NONE', roll }, instanceId: dungeonInstance ? dungeonInstance.id : null });
  return { legend: null, chance: cumulative };
}

// ── 战斗奖励池（随机；奖励池条目必须通过数据库验证）──
function validatePoolEntry(entry) {
  const db = getDb();
  if (!entry || !entry.type) return { ok: false, reason: '非法奖励条目' };
  if (entry.type === 'guidance' || entry.type === 'skill') {
    if (!entry.skill) return { ok: false, reason: '缺少技能' };
    const skill = db.prepare("SELECT 1 FROM skills WHERE name = ? AND status = 'approved'").get(entry.skill);
    if (!skill) return { ok: false, reason: `技能「${entry.skill}」不存在或未审核（禁止编造）` };
  }
  if (entry.type === 'item') {
    // 随机体验物品必须来自 experience_items 数据库（该体验真实存在的物品）
    if (!entry.experience) return { ok: false, reason: '缺少来源体验' };
    const items = db.prepare("SELECT * FROM experience_items WHERE source_experience = ? AND status = 'approved'").all(entry.experience);
    if (!items.length) return { ok: false, reason: `体验「${entry.experience}」无已审核物品（禁止编造）` };
  }
  if (entry.type === 'currency' && (!Number.isFinite(entry.amount) || entry.amount <= 0 || entry.amount > 1000)) {
    return { ok: false, reason: '货币数量非法（1~1000）' };
  }
  return { ok: true };
}

/**
 * 发放战斗胜利奖励（服务器随机选择奖励池条目 + 验证 + 发放）。
 * 幂等：同一玩家同一传奇同一副本实例只发放一次（reward_grants UNIQUE）。
 */
function grantCombatReward(io, legendId, playerId, roomId, { instanceId = null, rng = null } = {}) {
  const db = getDb();
  const legend = legendEngine.getLegendById(legendId);
  if (!legend) throw new EncounterError('LEGEND_NOT_FOUND', '传奇人物不存在', 404);
  const rules = getLegendRules(legendId);
  const pool = (rules.combat_reward_pool || []).filter((e) => validatePoolEntry(e).ok);
  if (!pool.length) throw new EncounterError('EMPTY_POOL', '该传奇人物无可发放奖励（奖励池为空或未通过验证）', 409);

  // 幂等
  const grantKey = `legend_combat:${legend.display_name}:${instanceId || 'world'}`;
  const dup = db.prepare('SELECT 1 FROM reward_grants WHERE instance_id IS NULL AND player_id = ? AND reward_key = ?').get(playerId, grantKey);
  if (dup) return { ok: false, reason: 'ALREADY_GRANTED', granted: null };

  // 加权随机选择
  const totalWeight = pool.reduce((a, e) => a + (Number(e.weight) || 1), 0);
  let roll = rng !== null ? rng * totalWeight : crypto.randomInt(0, 100000) / 100000 * totalWeight;
  let chosen = pool[0];
  for (const e of pool) {
    const w = Number(e.weight) || 1;
    if (roll < w) {
      chosen = e;
      break;
    }
    roll -= w;
  }

  const result = { type: chosen.type, description: chosen.description || '' };
  const characterService = require('../character/characterService');

  if (chosen.type === 'guidance' || chosen.type === 'skill') {
    const skill = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(chosen.skill);
    const grant = characterService.grantSkill(playerId, skill.id, { sourceType: 'LEGEND_COMBAT', sourceId: `legend:${legend.display_name}` });
    result.granted = grant.granted;
    result.skill = skill.name;
  } else if (chosen.type === 'item') {
    // 从该体验真实物品中随机（服务器掷骰）
    const items = db.prepare("SELECT * FROM experience_items WHERE source_experience = ? AND status = 'approved'").all(chosen.experience);
    const pick = items[crypto.randomInt(0, items.length)];
    // 同步到 items 表（确保可发放）
    let item = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(pick.name);
    if (!item) {
      db.prepare("INSERT OR IGNORE INTO items (name, description, source_type, rarity, status, kind, slot, stacking) VALUES (?, ?, 'original', ?, 'approved', 'weapon', 'weapon', 'UNIQUE')").run(pick.name, pick.description || '', pick.rarity);
      item = db.prepare('SELECT * FROM items WHERE name = ?').get(pick.name);
    }
    const grant = characterService.grantItem(playerId, item.id, { sourceType: 'LEGEND_COMBAT', sourceId: `legend:${legend.display_name}` });
    result.granted = grant.granted;
    result.item = pick.name;
    grantPermanentItem(playerId, item.id, chosen.experience);
  } else if (chosen.type === 'currency') {
    const cur = db.prepare("SELECT * FROM currencies WHERE name = '金币'").get();
    if (cur) characterService.grantCurrency(playerId, cur.id, Math.round(chosen.amount), { sourceType: 'LEGEND_COMBAT', sourceId: `legend:${legend.display_name}` });
    result.granted = 'GRANTED';
    result.amount = Math.round(chosen.amount);
  } else if (chosen.type === 'knowledge' || chosen.type === 'story') {
    // 解锁世界信息 / 剧情分支 → 世界状态标志
    const worldState = require('../world/worldState');
    try {
      worldState.setWorldField(roomId, chosen.flag, true, { actor: `legend:${legend.display_name}`, action: 'legend_reward' });
    } catch { /* 白名单外标志忽略 */ }
    result.granted = 'GRANTED';
    result.flag = chosen.flag;
  }

  db.prepare(
    `INSERT OR IGNORE INTO reward_grants (grant_uid, instance_id, player_id, reward_key, reward_type, status)
     VALUES (?, NULL, ?, ?, 'LEGEND_COMBAT', 'GRANTED')`
  ).run(`qrg_${crypto.randomBytes(4).toString('hex')}`, playerId, grantKey);

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'LEGENDARY_REWARD', actor: legend.display_name, actorPlayerId: playerId, data: result, instanceId });
  return { ok: true, granted: result };
}

// ── 永久物品 ──
function grantPermanentItem(playerId, itemId, acquiredFrom = null) {
  const db = getDb();
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'approved'").get(itemId);
  if (!item) throw new EncounterError('ITEM_NOT_APPROVED', '物品不存在或未审核', 409);
  db.prepare('INSERT OR IGNORE INTO permanent_items (player_id, item_id, acquired_from) VALUES (?, ?, ?)').run(playerId, itemId, acquiredFrom);
  return db.prepare('SELECT * FROM permanent_items WHERE player_id = ? AND item_id = ?').get(playerId, itemId);
}

function getPermanentItems(playerId, targetExperience = null) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pi.*, i.name, i.description, i.rarity, i.stat_bonus FROM permanent_items pi JOIN items i ON i.id = pi.item_id WHERE pi.player_id = ?`
    )
    .all(playerId);
  return rows.map((r) => ({
    ...r,
    effectiveMultiplier: targetExperience ? getItemMultiplier(r.name, r.acquired_from, targetExperience) : 1.0,
  }));
}

// ── 跨副本装备削弱 ──
function getItemMultiplier(itemName, sourceExperience, targetExperience) {
  if (!targetExperience) return 1.0;
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (sourceExperience && norm(sourceExperience) === norm(targetExperience)) return 1.0; // 主场不削弱
  const db = getDb();
  // 大小写不敏感匹配规则
  const rules = db.prepare('SELECT target_experience, multiplier FROM item_balance_rules WHERE item_name = ?').all(itemName);
  const rule = rules.find((r) => norm(r.target_experience) === norm(targetExperience));
  return rule ? Number(rule.multiplier) : 1.0; // 无规则默认不削弱
}

/** 有效强度 = 基础强度 × 平衡倍率（例：SFOTH 剑原伤 100 → DOORS 20）。 */
function effectiveItemPower(itemName, basePower, sourceExperience, targetExperience) {
  const mult = getItemMultiplier(itemName, sourceExperience, targetExperience);
  return { effectivePower: Math.round(basePower * mult), basePower, multiplier: mult };
}

// ── 剑斗完成度奖励 ──
/** 计算副本完成度评分 0~100（任务/战斗/探索/生存/时间）。 */
function completionScore(instanceId) {
  const db = getDb();
  const perf = db.prepare('SELECT * FROM instance_performance WHERE instance_id = ?').get(instanceId);
  const inst = db.prepare('SELECT * FROM dungeon_instances WHERE id = ?').get(instanceId);
  if (!inst) return 0;
  let score = 0;
  if (inst.status === 'COMPLETED') score += 30; // 完成任务
  if (perf) {
    const totalCombat = perf.combat_wins + perf.combat_losses;
    score += totalCombat > 0 ? Math.round((perf.combat_wins / totalCombat) * 30) : 0; // 战斗表现
    let scenes = [];
    try {
      scenes = JSON.parse(perf.explored_scenes || '[]');
    } catch { /* ignore */ }
    score += Math.min(20, scenes.length * 5); // 探索
    score += Math.max(0, 20 - perf.deaths * 5); // 生存（死亡扣分）
    score += Math.min(10, perf.quests_done * 5); // 任务
  }
  return Math.max(0, Math.min(100, score));
}

/** 评分 → 奖励档位（20% 基础 / 50% 普通特殊 / 80% 高级 / 100% 传奇）。 */
function rewardTier(score) {
  if (score >= 100) return { tier: 'legendary', minRarity: 'legendary' };
  if (score >= 80) return { tier: 'epic', minRarity: 'epic' };
  if (score >= 50) return { tier: 'rare', minRarity: 'rare' };
  if (score >= 20) return { tier: 'common', minRarity: 'common' };
  return null; // 低于 20% 无奖励
}

const RARITY_RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };

/**
 * 剑斗副本完成奖励：根据评分发放该副本真实存在的剑（experience_items）。
 * 奖励必须来自数据库，AI 不能创造。幂等：同实例同玩家只发一次。
 */
function grantSwordCompletionReward(io, instanceId, playerId, { experienceName, rng = null } = {}) {
  const db = getDb();
  const score = completionScore(instanceId);
  const tier = rewardTier(score);
  if (!tier) return { ok: false, reason: 'SCORE_TOO_LOW', score, granted: null };

  const swords = db.prepare("SELECT * FROM experience_items WHERE source_experience = ? AND status = 'approved'").all(experienceName);
  if (!swords.length) throw new EncounterError('NO_SWORDS', `体验「${experienceName}」无已审核剑（禁止编造）`, 409);

  // 幂等
  const grantKey = `sword_completion:${instanceId}`;
  const dup = db.prepare('SELECT 1 FROM reward_grants WHERE instance_id IS NULL AND player_id = ? AND reward_key = ?').get(playerId, grantKey);
  if (dup) return { ok: false, reason: 'ALREADY_GRANTED', score, granted: null };

  // 选择不高于档位的最高稀有度剑（服务器选择，非 AI）
  const eligible = swords.filter((s) => RARITY_RANK[s.rarity] <= RARITY_RANK[tier.minRarity]);
  const sorted = eligible.sort((a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity]);
  const pick = rng !== null ? sorted[Math.floor(rng * Math.min(3, sorted.length))] : sorted[crypto.randomInt(0, Math.min(3, sorted.length))];
  if (!pick) return { ok: false, reason: 'NO_ELIGIBLE_SWORD', score, granted: null };

  // 同步到 items 表并发放为永久物品
  let item = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(pick.name);
  if (!item) {
    db.prepare("INSERT OR IGNORE INTO items (name, description, source_type, rarity, status, kind, slot, stacking) VALUES (?, ?, 'original', ?, 'approved', 'weapon', 'weapon', 'UNIQUE')").run(pick.name, pick.description || '', pick.rarity);
    item = db.prepare('SELECT * FROM items WHERE name = ?').get(pick.name);
  }
  const characterService = require('../character/characterService');
  characterService.grantItem(playerId, item.id, { sourceType: 'SWORD_COMPLETION', sourceId: experienceName });
  grantPermanentItem(playerId, item.id, experienceName);

  db.prepare(
    `INSERT OR IGNORE INTO reward_grants (grant_uid, instance_id, player_id, reward_key, reward_type, status)
     VALUES (?, NULL, ?, ?, 'SWORD_COMPLETION', 'GRANTED')`
  ).run(`qrg_${crypto.randomBytes(4).toString('hex')}`, playerId, grantKey);

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomOf(instanceId), { type: 'LEGENDARY_REWARD', actor: null, actorPlayerId: playerId, data: { type: 'sword_completion', sword: pick.name, score, tier: tier.tier }, instanceId });
  return { ok: true, score, tier: tier.tier, sword: pick.name, granted: 'GRANTED' };
}

function roomOf(instanceId) {
  const row = getDb().prepare('SELECT room_id FROM dungeon_instances WHERE id = ?').get(instanceId);
  return row ? row.room_id : null;
}

// ── 表现追踪（事件驱动）──
function ensurePerformance(instanceId) {
  getDb().prepare('INSERT OR IGNORE INTO instance_performance (instance_id) VALUES (?)').run(instanceId);
}
function trackDeath(instanceId) {
  ensurePerformance(instanceId);
  getDb().prepare('UPDATE instance_performance SET deaths = deaths + 1 WHERE instance_id = ?').run(instanceId);
}
function trackCombat(instanceId, won) {
  ensurePerformance(instanceId);
  getDb().prepare(won ? 'UPDATE instance_performance SET combat_wins = combat_wins + 1 WHERE instance_id = ?' : 'UPDATE instance_performance SET combat_losses = combat_losses + 1 WHERE instance_id = ?').run(instanceId);
}
function trackScene(instanceId, sceneId) {
  ensurePerformance(instanceId);
  const row = getDb().prepare('SELECT explored_scenes FROM instance_performance WHERE instance_id = ?').get(instanceId);
  let scenes = [];
  try {
    scenes = JSON.parse(row.explored_scenes || '[]');
  } catch { /* ignore */ }
  if (!scenes.includes(sceneId)) {
    scenes.push(sceneId);
    getDb().prepare('UPDATE instance_performance SET explored_scenes = ? WHERE instance_id = ?').run(JSON.stringify(scenes), instanceId);
  }
}
function trackQuestDone(instanceId) {
  ensurePerformance(instanceId);
  getDb().prepare('UPDATE instance_performance SET quests_done = quests_done + 1 WHERE instance_id = ?').run(instanceId);
}

module.exports = {
  EncounterError,
  encounterCheck,
  validatePoolEntry,
  grantCombatReward,
  grantPermanentItem,
  getPermanentItems,
  getItemMultiplier,
  effectiveItemPower,
  completionScore,
  rewardTier,
  grantSwordCompletionReward,
  ensurePerformance,
  trackDeath,
  trackCombat,
  trackScene,
  trackQuestDone,
  getLegendRules,
};
