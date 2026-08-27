/**
 * Persistent Inventory & Item System（阶段14）。
 * 物品定义（item_definitions）与玩家持有（inventory_items）分离。
 * 红线（第八节）：
 *  - 物品定义只能由服务器/种子/设计流水线创建 —— AI 无创建定义工具；
 *  - add_item 必须引用已存在且 approved 的定义（give_item("god_sword") 不可能）；
 *  - 奖励路径必须经 validateItemReward（Reward Validator）+ grantKey 幂等。
 */
const { getDb } = require('@roblox-trpg/database');

const ITEM_TYPES = ['CONSUMABLE', 'WEAPON', 'ARMOR', 'TOOL', 'QUEST_ITEM', 'MATERIAL', 'SPECIAL'];
const RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];
const EQUIP_SLOTS = { WEAPON: 'weapon', ARMOR: 'armor' };
const DEFAULT_CAPACITY = 20;
const MAX_SINGLE_AMOUNT = 99;

class InventoryError extends Error {
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

const keyOf = (name) => String(name).trim().replace(/\s+/g, '_');

// ── 物品定义（服务器专属创建入口）──
function createDefinition({ itemKey, name, description = '', type = 'MATERIAL', rarity = 'COMMON', icon = null, stackLimit = 1, bindOnAcquire = 0, permanent = 0, basePower = 0, metadata = {}, source = 'original' }) {
  const db = getDb();
  if (!ITEM_TYPES.includes(type)) throw new InventoryError('INVALID_TYPE', `非法物品类型 ${type}（允许：${ITEM_TYPES.join('/')}）`);
  if (!RARITIES.includes(rarity)) throw new InventoryError('INVALID_RARITY', `非法品质 ${rarity}（允许：${RARITIES.join('/')}）`);
  const key = String(itemKey || '').trim();
  if (!/^[\w\u4e00-\u9fff-]{2,40}$/.test(key)) throw new InventoryError('INVALID_KEY', 'item_key 必须为 2~40 位字母/数字/下划线/中文');
  if (!String(name || '').trim()) throw new InventoryError('INVALID_NAME', '物品名称必填');
  const sl = Math.max(1, Math.min(999, Math.round(Number(stackLimit) || 1)));
  db.prepare(
    `INSERT INTO item_definitions (item_key, name, description, type, rarity, icon, stack_limit, bind_on_acquire, permanent, base_power, metadata_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(key, String(name).slice(0, 60), String(description).slice(0, 500), type, rarity, icon, sl, bindOnAcquire ? 1 : 0, permanent ? 1 : 0, Math.max(0, Math.round(Number(basePower) || 0)), JSON.stringify(metadata || {}), source);
  return getDefinition(key);
}

function getDefinition(keyOrId) {
  const db = getDb();
  const row = /^\d+$/.test(String(keyOrId))
    ? db.prepare('SELECT * FROM item_definitions WHERE id = ?').get(Number(keyOrId))
    : db.prepare('SELECT * FROM item_definitions WHERE item_key = ?').get(String(keyOrId));
  return row || null;
}

function listDefinitions({ type = null } = {}) {
  const db = getDb();
  return type ? db.prepare('SELECT * FROM item_definitions WHERE type = ? ORDER BY id').all(type) : db.prepare('SELECT * FROM item_definitions ORDER BY id').all();
}

/** 旧 items 表 → 新定义同步（桥接：副本/商店/任务发放旧物品时自动可用）。 */
function syncDefinitionFromLegacyItem(legacyItem) {
  const existing = getDefinition(keyOf(legacyItem.name));
  if (existing) return existing;
  const typeMap = { weapon: 'WEAPON', armor: 'ARMOR', consumable: 'CONSUMABLE', accessory: 'SPECIAL', special: 'SPECIAL', material: 'MATERIAL' };
  const rarityMap = { common: 'COMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };
  return createDefinition({
    itemKey: keyOf(legacyItem.name),
    name: legacyItem.name,
    description: legacyItem.description || '',
    type: typeMap[legacyItem.kind] || 'MATERIAL',
    rarity: rarityMap[legacyItem.rarity] || 'COMMON',
    stackLimit: legacyItem.stacking === 'STACKABLE' ? 99 : 1,
    metadata: parseJson(legacyItem.stat_bonus, {}),
    source: legacyItem.source_type || 'original',
  });
}

// ── 背包 ──
function ensureInventory(playerId, capacity = null) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO inventories (player_id, capacity) VALUES (?, ?)').run(playerId, capacity || DEFAULT_CAPACITY);
  if (capacity !== null) db.prepare('UPDATE inventories SET capacity = ? WHERE player_id = ?').run(Math.max(1, Math.round(capacity)), playerId);
  return db.prepare('SELECT * FROM inventories WHERE player_id = ?').get(playerId);
}

function rowsOf(playerId) {
  return getDb()
    .prepare(
      `SELECT ii.*, d.item_key, d.name, d.description, d.type, d.rarity, d.icon, d.stack_limit, d.bind_on_acquire, d.permanent, d.base_power, d.metadata_json AS def_metadata
       FROM inventory_items ii JOIN item_definitions d ON d.id = ii.item_id WHERE ii.player_id = ? ORDER BY ii.id`
    )
    .all(playerId);
}

function rowOf(playerId, itemKeyOrId) {
  const def = getDefinition(itemKeyOrId);
  if (!def) return null;
  return getDb().prepare('SELECT * FROM inventory_items WHERE player_id = ? AND item_id = ?').get(playerId, def.id);
}

function emitItemEvent(io, roomId, type, data) {
  try {
    const gameEvents = require('../quests/gameEvents');
    gameEvents.emit(io, roomId, { type, actor: data.playerName || null, actorPlayerId: data.playerId || null, data });
  } catch { /* 事件失败不阻塞 */ }
}

function playerNameOf(playerId) {
  const row = getDb().prepare('SELECT name, room_id FROM players WHERE id = ?').get(playerId);
  return row || {};
}

/**
 * 添加物品（唯一增入口；服务器验证定义/堆叠/容量/幂等）。
 * grantKey：奖励幂等键（同一键只生效一次）。
 */
function addItem(io, playerId, itemKeyOrId, { amount = 1, metadata = null, sourceType = 'SYSTEM', sourceId = null, grantKey = null } = {}) {
  const db = getDb();
  const def = getDefinition(itemKeyOrId);
  if (!def) throw new InventoryError('ITEM_NOT_FOUND', `物品定义「${itemKeyOrId}」不存在（禁止凭空创造物品）`, 404);
  if (def.status !== 'approved') throw new InventoryError('ITEM_NOT_APPROVED', `物品「${def.name}」未审核（奖励必须经过验证）`, 409);

  const qty = Math.round(Number(amount) || 0);
  if (qty < 1 || qty > MAX_SINGLE_AMOUNT) throw new InventoryError('BAD_AMOUNT', `数量必须为 1~${MAX_SINGLE_AMOUNT}`);

  // 幂等台账（奖励路径）
  if (grantKey) {
    const dup = db.prepare('SELECT 1 FROM inventory_grants WHERE grant_key = ?').get(grantKey);
    if (dup) return { added: false, reason: 'ALREADY_GRANTED', itemKey: def.item_key };
  }

  const inv = ensureInventory(playerId);
  const existing = db.prepare('SELECT * FROM inventory_items WHERE player_id = ? AND item_id = ?').get(playerId, def.id);

  if (def.stack_limit <= 1) {
    if (existing) throw new InventoryError('UNIQUE_ITEM_DUPLICATE', `唯一物品「${def.name}」已拥有`, 409);
    const used = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE player_id = ?').get(playerId).c;
    if (used >= inv.capacity) throw new InventoryError('INVENTORY_FULL', `背包已满（容量 ${inv.capacity}）`, 409);
    db.prepare('INSERT INTO inventory_items (player_id, item_id, amount, bound, metadata_json, acquired_from) VALUES (?, ?, 1, ?, ?, ?)').run(
      playerId, def.id, def.bind_on_acquire ? 1 : 0, JSON.stringify(metadata || {}), sourceId || sourceType
    );
  } else {
    const nextAmount = existing ? existing.amount + qty : qty;
    if (nextAmount > def.stack_limit) throw new InventoryError('STACK_LIMIT', `「${def.name}」堆叠上限 ${def.stack_limit}（当前 ${existing ? existing.amount : 0}）`, 409);
    if (!existing) {
      const used = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE player_id = ?').get(playerId).c;
      if (used >= inv.capacity) throw new InventoryError('INVENTORY_FULL', `背包已满（容量 ${inv.capacity}）`, 409);
      db.prepare('INSERT INTO inventory_items (player_id, item_id, amount, bound, metadata_json, acquired_from) VALUES (?, ?, ?, ?, ?, ?)').run(
        playerId, def.id, nextAmount, def.bind_on_acquire ? 1 : 0, JSON.stringify(metadata || {}), sourceId || sourceType
      );
    } else {
      db.prepare('UPDATE inventory_items SET amount = ? WHERE id = ?').run(nextAmount, existing.id);
    }
  }
  if (grantKey) {
    db.prepare('INSERT OR IGNORE INTO inventory_grants (grant_key, player_id, item_id, amount, source_type) VALUES (?, ?, ?, ?, ?)').run(grantKey, playerId, def.id, qty, sourceType);
  }

  const p = playerNameOf(playerId);
  emitItemEvent(io, p.room_id, 'ITEM_ACQUIRED', { playerId, playerName: p.name, item: def.name, itemKey: def.item_key, amount: qty, sourceType });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    p.room_id || null, p.name || `player#${playerId}`, 'ITEM_ACQUIRED', null, JSON.stringify({ item: def.name, amount: qty, sourceType }), 'inventory'
  );
  return { added: true, itemKey: def.item_key, name: def.name, amount: qty, permanent: Boolean(def.permanent) };
}

/** 移除物品（永久/绑定物品拒绝；数量不足拒绝）。 */
function removeItem(io, playerId, itemKeyOrId, { amount = 1 } = {}) {
  const db = getDb();
  const def = getDefinition(itemKeyOrId);
  if (!def) throw new InventoryError('ITEM_NOT_FOUND', `物品定义「${itemKeyOrId}」不存在`, 404);
  const row = db.prepare('SELECT * FROM inventory_items WHERE player_id = ? AND item_id = ?').get(playerId, def.id);
  if (!row) throw new InventoryError('ITEM_NOT_OWNED', `未持有「${def.name}」`, 404);
  if (def.permanent) throw new InventoryError('PERMANENT_ITEM', `「${def.name}」是永久物品，不可移除（跨副本保留，只可被副本规则削弱）`, 403);
  if (row.bound) throw new InventoryError('BOUND_ITEM', `「${def.name}」已绑定，不可移除`, 403);
  const qty = amount === undefined || amount === null ? 1 : Math.round(Number(amount));
  if (!Number.isFinite(qty) || qty < 1 || qty > row.amount) throw new InventoryError('BAD_AMOUNT', `移除数量非法（持有 ${row.amount}）`);
  if (row.equipped_slot) unequipItem(io, playerId, def.item_key);
  if (qty >= row.amount) db.prepare('DELETE FROM inventory_items WHERE id = ?').run(row.id);
  else db.prepare('UPDATE inventory_items SET amount = amount - ? WHERE id = ?').run(qty, row.id);
  const p = playerNameOf(playerId);
  emitItemEvent(io, p.room_id, 'ITEM_REMOVED', { playerId, playerName: p.name, item: def.name, itemKey: def.item_key, amount: qty });
  return { removed: true, itemKey: def.item_key, amount: qty };
}

/** 使用消耗品（效果来自定义/实例元数据；服务器结算）。 */
function useItem(io, playerId, itemKeyOrId) {
  const db = getDb();
  const def = getDefinition(itemKeyOrId);
  if (!def) throw new InventoryError('ITEM_NOT_FOUND', `物品定义「${itemKeyOrId}」不存在`, 404);
  if (def.type !== 'CONSUMABLE') throw new InventoryError('NOT_CONSUMABLE', `「${def.name}」不是消耗品，无法使用`, 409);
  const row = db.prepare('SELECT * FROM inventory_items WHERE player_id = ? AND item_id = ?').get(playerId, def.id);
  if (!row || row.amount < 1) throw new InventoryError('ITEM_NOT_OWNED', `未持有「${def.name}」`, 404);

  const meta = { ...parseJson(def.metadata_json, {}), ...parseJson(row.metadata_json, {}) };
  const effects = [];
  if (meta.heal) {
    const characterService = require('../character/characterService');
    characterService.ensureCharacter(playerId); // 无角色状态时按默认初始化（服务器规则）
    const r = characterService.changeHp(playerId, Math.max(1, Math.min(50, Math.round(Number(meta.heal)))), {
      sourceType: 'ITEM_USE', sourceId: def.item_key, action: 'item_heal',
    });
    effects.push({ effect: 'heal', value: Math.round(Number(meta.heal)), hp: r.hp });
  }
  db.prepare('UPDATE inventory_items SET amount = amount - 1 WHERE id = ?').run(row.id);
  if (row.amount - 1 <= 0) db.prepare('DELETE FROM inventory_items WHERE id = ?').run(row.id);
  const p = playerNameOf(playerId);
  emitItemEvent(io, p.room_id, 'ITEM_USED', { playerId, playerName: p.name, item: def.name, itemKey: def.item_key, effects });
  return { used: true, itemKey: def.item_key, effects };
}

/** 装备（WEAPON/ARMOR）：同槽位自动换装。 */
function equipItem(io, playerId, itemKeyOrId) {
  const db = getDb();
  const def = getDefinition(itemKeyOrId);
  if (!def) throw new InventoryError('ITEM_NOT_FOUND', `物品定义「${itemKeyOrId}」不存在`, 404);
  const slot = EQUIP_SLOTS[def.type];
  if (!slot) throw new InventoryError('NOT_EQUIPPABLE', `「${def.name}」（${def.type}）不可装备`, 409);
  const row = db.prepare('SELECT * FROM inventory_items WHERE player_id = ? AND item_id = ?').get(playerId, def.id);
  if (!row) throw new InventoryError('ITEM_NOT_OWNED', `未持有「${def.name}」`, 404);
  db.prepare('UPDATE inventory_items SET equipped_slot = NULL WHERE player_id = ? AND equipped_slot = ?').run(playerId, slot);
  db.prepare('UPDATE inventory_items SET equipped_slot = ? WHERE id = ?').run(slot, row.id);
  const p = playerNameOf(playerId);
  emitItemEvent(io, p.room_id, 'ITEM_EQUIPPED', { playerId, playerName: p.name, item: def.name, itemKey: def.item_key, slot });
  return { equipped: true, itemKey: def.item_key, slot };
}

function unequipItem(io, playerId, itemKeyOrSlot) {
  const db = getDb();
  const row = rowOf(playerId, itemKeyOrSlot)
    || db.prepare('SELECT ii.* FROM inventory_items ii WHERE ii.player_id = ? AND ii.equipped_slot = ?').get(playerId, itemKeyOrSlot);
  if (!row || !row.equipped_slot) return { unequipped: false, reason: 'NOT_EQUIPPED' };
  db.prepare('UPDATE inventory_items SET equipped_slot = NULL WHERE id = ?').run(row.id);
  return { unequipped: true };
}

// ── 跨副本削弱（第五节：永久物品保留但按世界规则削弱）──
/** 有效强度 = base_power × 副本规则倍率（复用阶段11 平衡表；主场/无规则 = 不削弱）。 */
function effectivePower(itemKeyOrId, targetExperience = null) {
  const def = getDefinition(itemKeyOrId);
  if (!def) throw new InventoryError('ITEM_NOT_FOUND', `物品定义「${itemKeyOrId}」不存在`, 404);
  if (!targetExperience) return { effectivePower: def.base_power, multiplier: 1.0, basePower: def.base_power };
  const meta = parseJson(def.metadata_json, {});
  const legendEncounter = require('../legends/legendEncounter');
  const mult = legendEncounter.getItemMultiplier(def.name, meta.source || null, targetExperience);
  return { effectivePower: Math.round(def.base_power * mult), multiplier: mult, basePower: def.base_power };
}

/** 玩家装备战斗属性（第九节：战斗读取装备；武器受副本规则削弱）。 */
function equippedCombatStats(playerId, experienceName = null) {
  const equipped = rowsOf(playerId).filter((r) => r.equipped_slot);
  const weapon = equipped.find((r) => r.equipped_slot === 'weapon') || null;
  const armor = equipped.find((r) => r.equipped_slot === 'armor') || null;
  let weaponPower = 0;
  let multiplier = 1.0;
  if (weapon) {
    const eff = effectivePower(weapon.item_key, experienceName);
    weaponPower = eff.effectivePower;
    multiplier = eff.multiplier;
  }
  const armorMeta = armor ? { ...parseJson(armor.def_metadata, {}), ...parseJson(armor.metadata_json, {}) } : {};
  return {
    weapon: weapon ? { name: weapon.name, itemKey: weapon.item_key, power: weaponPower, multiplier } : null,
    armor: armor ? { name: armor.name, itemKey: armor.item_key, armor: Math.round(Number(armorMeta.armor) || 0) } : null,
    weaponBonus: Math.floor(weaponPower / 10),
    armorReduction: armor ? Math.floor((Math.round(Number(armorMeta.armor) || 0)) / 10) : 0,
  };
}

/** 奖励验证器（第八节：Quest/NPC/副本/AI 奖励统一入口）。 */
function validateItemReward(itemKeyOrId, amount = 1) {
  const def = getDefinition(itemKeyOrId);
  if (!def) return { ok: false, reason: `物品「${itemKeyOrId}」不存在（AI 不能创造物品）` };
  if (def.status !== 'approved') return { ok: false, reason: `物品「${def.name}」未审核` };
  const qty = Math.round(Number(amount) || 0);
  if (qty < 1 || qty > MAX_SINGLE_AMOUNT) return { ok: false, reason: `数量必须为 1~${MAX_SINGLE_AMOUNT}` };
  if (qty > def.stack_limit) return { ok: false, reason: `超过堆叠上限 ${def.stack_limit}` };
  return { ok: true, definition: def };
}

/** NPC 赠予（第十一节）：关系门槛 + 幂等（同 NPC 同玩家同物品只给一次）。 */
function giftItemFromNpc(io, { npcUid, playerId, itemKey, roomId, minRelationship = 0, reason = '' }) {
  const npcEngine = require('../npcs/npcEngine');
  const inst = npcEngine.findNpcInstanceInRoom(roomId, npcUid);
  if (!inst) throw new InventoryError('NPC_NOT_PRESENT', 'NPC 不在当前房间', 404);
  if (!inst.alive) throw new InventoryError('NPC_DEAD', '该 NPC 已死亡');
  const rel = npcEngine.getRelationship('npc', inst.npc_id, 'player', playerId);
  if (rel.value < minRelationship) {
    throw new InventoryError('RELATIONSHIP_TOO_LOW', `关系不足：需要 ${minRelationship}，当前 ${rel.value}`, 409);
  }
  const npc = npcEngine.getNpc(inst.npc_id);
  return addItem(io, playerId, itemKey, {
    amount: 1,
    sourceType: 'NPC_GIFT',
    sourceId: npcUid,
    grantKey: `npc_gift:${npcUid}:${playerId}:${keyOf(getDefinition(itemKey) ? getDefinition(itemKey).name : itemKey)}`,
  });
}

/** 背包视图（UI/工具；公开字段）。 */
function getInventory(playerId) {
  const inv = ensureInventory(playerId);
  const items = rowsOf(playerId).map((r) => ({
    rowId: r.id,
    itemKey: r.item_key,
    name: r.name,
    description: r.description,
    type: r.type,
    rarity: r.rarity,
    icon: r.icon,
    amount: r.amount,
    stackLimit: r.stack_limit,
    equippedSlot: r.equipped_slot,
    bound: Boolean(r.bound),
    permanent: Boolean(r.permanent),
    basePower: r.base_power,
    metadata: { ...parseJson(r.def_metadata, {}), ...parseJson(r.metadata_json, {}) },
    acquiredFrom: r.acquired_from,
  }));
  return { playerId, capacity: inv.capacity, used: items.length, items };
}

/** Context 专用视图（第十三节：隐藏内部 ID，只给名称/品质/装备）。 */
function contextSummary(playerId) {
  const inv = getInventory(playerId);
  if (!inv.items.length) return '（空）';
  const parts = inv.items.map((i) => `${i.name}${i.amount > 1 ? `×${i.amount}` : ''}[${i.rarity}]${i.equippedSlot ? '(已装备)' : ''}${i.permanent ? '(永久)' : ''}`);
  return `${parts.join('、')}（${inv.used}/${inv.capacity}）`;
}

module.exports = {
  InventoryError,
  ITEM_TYPES,
  RARITIES,
  createDefinition,
  getDefinition,
  listDefinitions,
  syncDefinitionFromLegacyItem,
  ensureInventory,
  addItem,
  removeItem,
  useItem,
  equipItem,
  unequipItem,
  effectivePower,
  equippedCombatStats,
  validateItemReward,
  giftItemFromNpc,
  getInventory,
  contextSummary,
};
