/**
 * Legendary Engine（阶段10）：传奇人物系统 —— 生成概率/能力倍率/商店/战斗。
 * 红线：传奇 NPC 只能由服务器生成（无 spawn 工具）；能力倍率只读自数据库规则；
 * 装备/奖励只能经商店购买或任务结算；AI 只能描述与调用合法工具。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const npcEngine = require('../npcs/npcEngine');

class LegendError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getLegendByNpcUid(npcUid) {
  return getDb()
    .prepare('SELECT ln.*, n.uid AS npc_uid, n.name, n.avatar, n.nature FROM legendary_npcs ln JOIN npcs n ON n.id = ln.npc_id WHERE n.uid = ?')
    .get(npcUid);
}

function getLegendById(legendId) {
  return getDb()
    .prepare('SELECT ln.*, n.uid AS npc_uid, n.name, n.avatar, n.nature FROM legendary_npcs ln JOIN npcs n ON n.id = ln.npc_id WHERE ln.id = ?')
    .get(legendId);
}

function allLegends() {
  return getDb()
    .prepare('SELECT ln.*, n.uid AS npc_uid, n.name, n.avatar, n.nature FROM legendary_npcs ln JOIN npcs n ON n.id = ln.npc_id')
    .all();
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

// ── 能力倍率（Power Adaptation）：real_power = base_power × world_multiplier ──
function powerMultiplier(legend, experienceName = null) {
  const rules = parseJson(legend.power_rules_json, {});
  if (experienceName && rules[experienceName] !== undefined) return Number(rules[experienceName]);
  return Number(rules.default ?? 1.0);
}

function realPower(legend, experienceName = null) {
  const mult = powerMultiplier(legend, experienceName);
  const base = Math.max(0, Number(legend.base_power) || 0);
  return { realPower: Math.round(base * mult), basePower: base, multiplier: mult };
}

// ── 生成系统（服务器决定；概率由 location/dungeon/world_state/level/quest 决定）──
/**
 * 尝试在当前房间生成一位传奇人物（服务器掷骰）。
 * @returns 生成的传奇人物行 或 null（未遇见）
 */
function trySpawnLegendary(io, roomId, { experienceName = null, playerLevel = 1, questProgress = 0, worldState = {}, rng = null } = {}) {
  const db = getDb();
  const legends = allLegends();
  // 同房间已存在的传奇不重复生成
  const existingNpcIds = new Set(npcEngine.npcInstancesInRoom(roomId).map((ni) => ni.npc_id));
  const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000; // 服务器随机

  let cumulative = 0;
  for (const legend of legends) {
    if (existingNpcIds.has(legend.npc_id)) continue;
    const rules = parseJson(legend.spawn_rules_json, {});
    if ((rules.min_level || 0) > playerLevel) continue;
    let chance = Number(rules.base_chance) || 0;
    if (experienceName && rules.experience_boost && rules.experience_boost[experienceName] !== undefined) {
      chance = Number(rules.experience_boost[experienceName]); // 副本匹配：概率提升
    }
    // 世界状态修正（如灾变等级提高遇见率）
    if (worldState && typeof worldState.legend_spawn_bonus === 'number') chance += worldState.legend_spawn_bonus;
    // 任务进度轻微提高遇见率
    chance += Math.min(0.05, (questProgress || 0) * 0.005);
    chance = Math.max(0, Math.min(0.9, chance));

    if (roll < cumulative + chance) {
      const inst = npcEngine.spawnNpcInstance(io, { npcId: legend.npc_id, roomId });
      const gameEvents = require('../quests/gameEvents');
      gameEvents.emit(io, roomId, { type: 'LEGENDARY_NPC_FOUND', actor: null, data: { legendId: legend.id, name: legend.display_name, title: legend.title, rarity: legend.rarity }, instanceId: inst.dungeon_instance_id });
      db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
        roomId,
        'server',
        'LEGENDARY_NPC_FOUND',
        null,
        JSON.stringify({ name: legend.display_name, rarity: legend.rarity }),
        'legend_engine'
      );
      return legend;
    }
    cumulative += chance;
  }
  return null;
}

// ── 装备规则（按世界/副本）──
function equipmentPolicy(legend, experienceName = null) {
  const rules = parseJson(legend.equipment_rules_json, {});
  if (experienceName && rules[experienceName]) return rules[experienceName];
  return rules.default || {};
}

/** FORSAKEN 类战利品池：默认物品 + 低概率传奇物品（服务器掷骰）。 */
function rollEquipmentPool(legend, experienceName = null, rng = null) {
  const policy = equipmentPolicy(legend, experienceName);
  if (!policy.pool || !policy.pool.length) return null;
  const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;
  let acc = 0;
  for (const entry of policy.pool) {
    const chance = Number(entry.chance) || 0;
    if (roll < acc + chance) return entry.item;
    acc += chance;
  }
  return policy.pool[policy.pool.length - 1].item;
}

// ── 传奇商店（服务器验证全部购买条件）──
function getShop(legendId, playerId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*, i.name AS item_name, i.rarity AS item_rarity, i.kind, i.stacking FROM legendary_shop_items s
       JOIN items i ON i.id = s.item_id WHERE s.legendary_npc_id = ? ORDER BY s.price`
    )
    .all(legendId);
  return rows.map((r) => ({ ...r, requirements: parseJson(r.requirements_json, {}), eligible: checkShopRequirements(legendId, r, playerId).ok }));
}

function checkShopRequirements(legendId, shopRow, playerId) {
  const db = getDb();
  const req = parseJson(shopRow.requirements_json, {});
  const legend = getLegendById(legendId);
  if (legend && playerId) {
    if (req.relationship !== undefined) {
      const rel = npcEngine.getRelationship('npc', legend.npc_id, 'player', playerId);
      if (rel.value < Number(req.relationship)) {
        return { ok: false, reason: `关系不足：需要 ${req.relationship}，当前 ${rel.value}` };
      }
    }
    if (req.faction_reputation && typeof req.faction_reputation === 'object') {
      const fac = db.prepare('SELECT * FROM factions WHERE name = ?').get(String(req.faction_reputation.faction || ''));
      if (!fac) return { ok: false, reason: '阵营不存在' };
      const rep = npcEngine.getFactionReputation(playerId, fac.id);
      if (rep < Number(req.faction_reputation.value || 0)) {
        return { ok: false, reason: `阵营声望不足：需要 ${req.faction_reputation.value}，当前 ${rep}` };
      }
    }
    if (req.quest) {
      const done = db
        .prepare(
          `SELECT 1 FROM quest_instances qi JOIN quest_versions qv ON qv.id = qi.quest_version_id JOIN quests q ON q.id = qv.quest_id
           WHERE q.uid = ? AND qi.room_id = (SELECT room_id FROM npc_instances WHERE npc_id = ? LIMIT 1) AND qi.status = 'COMPLETED'`
        )
        .get(String(req.quest), legend.npc_id);
      if (!done) return { ok: false, reason: `需先完成任务 ${req.quest}` };
    }
  }
  return { ok: true };
}

/** 购买（服务器验证：条件 + 货币 → 扣款 + 发物品 + 事件）。AI 无直接发放途径。 */
function purchaseShopItem(io, legendId, playerId, itemId, roomId) {
  const db = getDb();
  const legend = getLegendById(legendId);
  if (!legend) throw new LegendError('LEGEND_NOT_FOUND', '传奇人物不存在', 404);
  const shopRow = db.prepare('SELECT * FROM legendary_shop_items WHERE legendary_npc_id = ? AND item_id = ?').get(legendId, itemId);
  if (!shopRow) throw new LegendError('NOT_IN_SHOP', '该物品不在此商店', 404);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item || item.status !== 'approved') throw new LegendError('ITEM_NOT_APPROVED', '物品不存在或未审核', 409);

  const reqCheck = checkShopRequirements(legendId, shopRow, playerId);
  if (!reqCheck.ok) throw new LegendError('REQUIREMENT_NOT_MET', reqCheck.reason, 409);

  // 货币验证与扣款
  const cur = db.prepare('SELECT * FROM currencies WHERE name = ?').get(shopRow.currency);
  if (!cur) throw new LegendError('CURRENCY_NOT_FOUND', '货币不存在', 409);
  const bal = npcEngine.getFactionReputation ? db.prepare('SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = ?').get(playerId, cur.id) : null;
  const balance = bal ? bal.balance : 0;
  if (balance < shopRow.price) throw new LegendError('INSUFFICIENT_FUNDS', `金币不足：需要 ${shopRow.price}，当前 ${balance}`, 409);
  db.prepare('UPDATE player_currency SET balance = balance - ? WHERE player_id = ? AND currency_id = ?').run(shopRow.price, playerId, cur.id);

  const characterService = require('../character/characterService');
  const grant = characterService.grantItem(playerId, itemId, { sourceType: 'LEGEND_SHOP', sourceId: `legend:${legend.display_name}` });
  if (grant.granted === 'REJECTED') {
    // 发放失败（如 UNIQUE 已拥有）→ 回滚扣款
    db.prepare('UPDATE player_currency SET balance = balance + ? WHERE player_id = ? AND currency_id = ?').run(shopRow.price, playerId, cur.id);
    throw new LegendError('ALREADY_OWNED', `该物品已拥有（${grant.reason}），不可重复购买`, 409);
  }

  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'LEGENDARY_REWARD', actor: null, actorPlayerId: playerId, data: { legend: legend.display_name, item: item.name, price: shopRow.price }, instanceId: null });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId,
    `player#${playerId}`,
    'LEGENDARY_REWARD',
    JSON.stringify({ balance }),
    JSON.stringify({ item: item.name, price: shopRow.price }),
    'legend_engine'
  );
  return { ok: true, item: item.name, price: shopRow.price, grant };
}

// ── 传奇战斗（经 NPC Action System：服务器掷骰，AI 只描述）──
function legendaryBattleAction(io, legendId, action, { roomId, targetName = null, byPlayerId = null } = {}) {
  const legend = getLegendById(legendId);
  if (!legend) throw new LegendError('LEGEND_NOT_FOUND', '传奇人物不存在', 404);
  const actions = ['attack', 'defend', 'flee', 'skill'];
  if (!actions.includes(action)) throw new LegendError('INVALID_ACTION', `非法战斗动作 ${action}（允许：${actions.join('/')}）`);

  const diceEngine = require('../world/diceEngine');
  const roll = diceEngine.roll(roomId, { sides: 20, count: 2, kind: 'legendary_battle' });
  const outcome = {
    action,
    legend: legend.display_name,
    roll: roll.total,
    success: action === 'flee' ? roll.total >= 10 : roll.total >= 15,
    target: targetName,
  };
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'LEGENDARY_BATTLE', actor: legend.display_name, actorPlayerId: byPlayerId, data: outcome, instanceId: null });
  getDb()
    .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomId, legend.display_name, 'LEGENDARY_BATTLE', null, JSON.stringify(outcome), 'legend_engine');
  return outcome;
}

/** 对话事件（关系 +2 复用 talk 规则）。 */
function legendaryDialog(io, legendId, playerId, roomId, topic) {
  const legend = getLegendById(legendId);
  if (!legend) throw new LegendError('LEGEND_NOT_FOUND', '传奇人物不存在', 404);
  const inst = npcEngine.findNpcInstanceInRoom(roomId, legend.npc_uid);
  if (!inst) throw new LegendError('LEGEND_NOT_PRESENT', '该传奇人物不在当前房间', 404);
  const res = npcEngine.applyRelationshipEvent(io, { npcInstanceId: inst.id, playerId, action: 'conversation', reason: String(topic || '').slice(0, 200) });
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'LEGENDARY_DIALOG', actor: `player#${playerId}`, data: { legend: legend.display_name, topic: String(topic || '').slice(0, 200) }, instanceId: inst.dungeon_instance_id });
  return { ok: true, relationship: res.relationship.value, mood: res.mood };
}

/** 传奇人物离开（服务器决定）。 */
function legendaryLeave(io, legendId, roomId) {
  const legend = getLegendById(legendId);
  if (!legend) throw new LegendError('LEGEND_NOT_FOUND', '传奇人物不存在', 404);
  const db = getDb();
  const inst = npcEngine.findNpcInstanceInRoom(roomId, legend.npc_uid);
  if (!inst) return { alreadyGone: true };
  db.prepare('DELETE FROM npc_instances WHERE id = ?').run(inst.id);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'LEGENDARY_LEAVE', actor: legend.display_name, data: { legend: legend.display_name }, instanceId: inst.dungeon_instance_id });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId,
    legend.display_name,
    'LEGENDARY_LEAVE',
    JSON.stringify({ present: true }),
    JSON.stringify({ present: false }),
    'legend_engine'
  );
  return { ok: true };
}

module.exports = {
  LegendError,
  getLegendByNpcUid,
  getLegendById,
  allLegends,
  powerMultiplier,
  realPower,
  trySpawnLegendary,
  equipmentPolicy,
  rollEquipmentPool,
  getShop,
  purchaseShopItem,
  legendaryBattleAction,
  legendaryDialog,
  legendaryLeave,
};
