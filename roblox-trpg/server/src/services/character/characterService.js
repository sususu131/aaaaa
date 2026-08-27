/**
 * Character Service（阶段6 核心）：Persistent Character = 扩展后的 players 行。
 * 所有修改仅由服务器执行；客户端不能改 XP/等级/属性/HP/技能/物品/货币。
 * 乐观锁（players.version）+ 交易日志（character_transactions）+ 事务一致性。
 */
const { getDb } = require('@roblox-trpg/database');
const leveling = require('./leveling');
const { ATTRIBUTES } = require('../vision/avatarRules');

class CharacterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function audit(playerId, kind, action, sourceType, sourceId, oldValue, newValue) {
  getDb()
    .prepare('INSERT INTO character_transactions (player_id, kind, action, source_type, source_id, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(playerId, kind, action, sourceType || null, sourceId != null ? String(sourceId) : null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null);
}

/** 确保角色存在（新玩家自动创建；已有行直接复用）。 */
function ensureCharacter(playerRowId) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerRowId);
  if (!p) throw new CharacterError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  if (p.level == null) db.prepare('UPDATE players SET level = 1, exp = 0 WHERE id = ?').run(playerRowId);
  // HP 派生：base 10 + (CON-5)，首次初始化
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  if (!st) {
    db.prepare('INSERT INTO player_states (player_id, hp, max_hp) VALUES (?, 10, 10)').run(playerRowId);
  }
  return getCharacter(playerRowId);
}

/** 有效属性 = base（avatar 初始化）+ 永久修正 + 装备加成 + 临时修正（限当前实例）。 */
function effectiveStats(playerRowId, { instanceId = null } = {}) {
  const db = getDb();
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  const base = (st && st.attributes ? JSON.parse(st.attributes) : null) || {};
  const totals = {};
  for (const a of ATTRIBUTES) totals[a] = Number(base[a] || 5);

  // 属性修正（永久 + 当前实例的临时）
  const mods = db
    .prepare(
      `SELECT * FROM character_modifiers WHERE player_id = ? AND (scope = 'PERMANENT' OR (scope = 'TEMPORARY' AND instance_id = ?))`
    )
    .all(playerRowId, instanceId || -1);
  for (const m of mods) {
    if (totals[m.stat] !== undefined) totals[m.stat] += m.delta;
  }

  // 装备加成（不写回 base）
  const equips = db
    .prepare(
      `SELECT i.stat_bonus FROM character_equipment ce JOIN items i ON i.id = ce.item_id WHERE ce.player_id = ?`
    )
    .all(playerRowId);
  for (const e of equips) {
    if (!e.stat_bonus) continue;
    try {
      for (const [k, v] of Object.entries(JSON.parse(e.stat_bonus))) {
        if (totals[k] !== undefined) totals[k] += Number(v) || 0;
      }
    } catch { /* 非法 JSON 忽略 */ }
  }

  // Clamp 1~10（属性系统规则）
  for (const a of ATTRIBUTES) totals[a] = Math.max(1, Math.min(10, totals[a]));
  return { base, totals };
}

/** 完整角色视图（API / Context 用）。 */
function getCharacter(playerRowId) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerRowId);
  if (!p) throw new CharacterError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  const init = db.prepare('SELECT * FROM avatar_initialization WHERE player_id = ?').get(playerRowId);
  const { totals } = effectiveStats(playerRowId);

  const skills = db
    .prepare(
      `SELECT ps.id AS hold_id, ps.level, ps.source_type, ps.uses_remaining, ps.cooldown_until_turn,
              s.id AS skill_id, s.name, s.description, s.rarity, s.skill_type, s.cooldown_turns, s.max_uses, s.effect_data,
              d.roblox_experience_name AS source_dungeon
       FROM player_skills ps JOIN skills s ON s.id = ps.skill_id
       LEFT JOIN dungeons d ON d.id = ps.obtained_from_dungeon_id
       WHERE ps.player_id = ? ORDER BY ps.id`
    )
    .all(playerRowId)
    .map((r) => ({
      ...r,
      sourceLabel: r.source_type === 'INITIAL_AVATAR' ? 'Avatar' : r.source_dungeon ? `副本：${r.source_dungeon}` : r.source_type || '特殊',
    }));

  const inventory = db
    .prepare(
      `SELECT pi.id AS hold_id, pi.quantity, pi.source, pi.source_type, pi.metadata, pi.obtained_at,
              i.id AS item_id, i.name, i.description, i.rarity, i.kind, i.slot, i.stacking, i.stat_bonus
       FROM player_items pi JOIN items i ON i.id = pi.item_id WHERE pi.player_id = ? ORDER BY pi.id`
    )
    .all(playerRowId);

  const equipment = db
    .prepare(
      `SELECT ce.slot, ce.item_id, i.name, i.kind, i.rarity, i.stat_bonus
       FROM character_equipment ce JOIN items i ON i.id = ce.item_id WHERE ce.player_id = ?`
    )
    .all(playerRowId);

  const currencies = db
    .prepare(
      'SELECT pc.currency_id, c.name, pc.balance FROM player_currency pc JOIN currencies c ON c.id = pc.currency_id WHERE pc.player_id = ?'
    )
    .all(playerRowId);

  return {
    characterId: `char_${p.uid || p.id}`,
    playerId: p.id,
    playerUid: p.uid,
    displayName: p.name,
    avatarSource: p.avatar_type === 'roblox' ? 'ROBLOX_AVATAR' : 'BACON_HEAD',
    avatarSnapshotHash: init ? init.avatar_snapshot_hash : null,
    level: p.level || 1,
    experience: p.exp || 0,
    levelProgress: leveling.progress(p.exp || 0, p.level || 1),
    maxHp: st ? st.max_hp : 10,
    currentHp: st ? st.hp : 10,
    statusEffects: st ? JSON.parse(st.status_effects || '[]') : [],
    stats: totals,
    skills,
    inventory,
    equipment,
    currencies,
    version: p.version || 1,
    createdAt: p.joined_at,
    updatedAt: st ? st.updated_at : null,
  };
}

/** 乐观锁更新辅助：read-modify-write + 冲突重试。 */
function updatePlayerRow(playerRowId, mutate) {
  const db = getDb();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerRowId);
    if (!p) throw new CharacterError('PLAYER_NOT_FOUND', '玩家不存在', 404);
    const changes = mutate(p);
    const upd = db
      .prepare('UPDATE players SET level = ?, exp = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run(changes.level, changes.exp, playerRowId, p.version);
    if (upd.changes === 1) return { row: { ...p, ...changes, version: p.version + 1 }, attempts: attempt + 1 };
  }
  throw new CharacterError('VERSION_CONFLICT', '角色版本冲突过于频繁', 409);
}

/** 授予 XP（服务器验证入口）：返回 { xpGained, levelsGained, newLevel, events }。 */
function grantXp(playerRowId, amount, { sourceType = 'SYSTEM', sourceId = null } = {}) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { xpGained: 0, levelsGained: 0, events: [] };
  const events = [];
  const { row } = updatePlayerRow(playerRowId, (p) => {
    const oldLevel = p.level || 1;
    const newExp = (p.exp || 0) + amt;
    const newLevel = leveling.levelForXp(newExp);
    if (newLevel > oldLevel) {
      events.push({ type: 'LEVEL_UP', old_level: oldLevel, new_level: newLevel });
    }
    return { level: newLevel, exp: newExp };
  });
  audit(playerRowId, 'XP', 'grant', sourceType, sourceId, row.exp - amt, row.exp);
  for (const ev of events) audit(playerRowId, 'LEVEL', 'level_up', sourceType, sourceId, ev.old_level, ev.new_level);
  return { xpGained: amt, levelsGained: events.length, newLevel: row.level, events };
}

/** HP 修改（damage/heal/revive；服务器专用，数值范围验证）。 */
function changeHp(playerRowId, delta, { sourceType = 'SYSTEM', sourceId = null, action = 'change' } = {}) {
  const db = getDb();
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  if (!st) throw new CharacterError('NO_STATE', '角色状态不存在', 404);
  const d = Math.round(Number(delta) || 0);
  const maxHp = Math.min(999, st.max_hp);
  const newHp = Math.max(0, Math.min(maxHp, st.hp + d));
  db.prepare("UPDATE player_states SET hp = ?, updated_at = datetime('now') WHERE player_id = ?").run(newHp, playerRowId);
  audit(playerRowId, 'HP', action, sourceType, sourceId, st.hp, newHp);
  if (newHp <= 0 && !JSON.parse(st.status_effects || '[]').includes('DOWNED')) {
    db.prepare('UPDATE player_states SET status_effects = ? WHERE player_id = ?').run(
      JSON.stringify([...JSON.parse(st.status_effects || '[]'), 'DOWNED']),
      playerRowId
    );
  }
  return { hp: newHp, maxHp, downed: newHp <= 0 };
}

/** 复活（服务器专用）。 */
function revive(playerRowId, { hp = null, sourceType = 'SYSTEM', sourceId = null } = {}) {
  const db = getDb();
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  if (!st) throw new CharacterError('NO_STATE', '角色状态不存在', 404);
  const newHp = Math.max(1, Math.min(st.max_hp, hp == null ? Math.ceil(st.max_hp / 2) : Math.round(hp)));
  db.prepare(
    "UPDATE player_states SET hp = ?, status_effects = ?, updated_at = datetime('now') WHERE player_id = ?"
  ).run(newHp, JSON.stringify(JSON.parse(st.status_effects || '[]').filter((e) => e !== 'DOWNED')), playerRowId);
  audit(playerRowId, 'HP', 'revive', sourceType, sourceId, st.hp, newHp);
  return { hp: newHp };
}

/**
 * 技能授予（唯一性规则）：
 * - 未拥有 → 新增（level 1，按定义初始化次数）
 * - 已拥有 → 技能升级（level+1），不产生重复条目
 * 返回 { granted: 'NEW'|'LEVEL_UP'|'REJECTED', ... }。
 */
function grantSkill(playerRowId, skillId, { sourceType = 'DUNGEON_REWARD', sourceId = null, obtainedFromDungeonId = null } = {}) {
  const db = getDb();
  const skill = db.prepare("SELECT * FROM skills WHERE id = ? AND status = 'approved'").get(skillId);
  if (!skill) return { granted: 'REJECTED', reason: 'SKILL_NOT_APPROVED' };
  const existing = db.prepare('SELECT * FROM player_skills WHERE player_id = ? AND skill_id = ?').get(playerRowId, skillId);
  if (existing) {
    db.prepare('UPDATE player_skills SET level = level + 1 WHERE id = ?').run(existing.id);
    audit(playerRowId, 'SKILL', 'level_up', sourceType, sourceId, existing.level, existing.level + 1);
    return { granted: 'LEVEL_UP', skillName: skill.name, level: existing.level + 1 };
  }
  db.prepare(
    `INSERT INTO player_skills (player_id, skill_id, obtained_from_dungeon_id, level, source_type, source_id, uses_remaining)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(playerRowId, skillId, obtainedFromDungeonId, sourceType, sourceId != null ? String(sourceId) : null, skill.max_uses ?? null);
  audit(playerRowId, 'SKILL', 'grant', sourceType, sourceId, null, skill.name);
  return { granted: 'NEW', skillName: skill.name, level: 1 };
}

/** 物品授予（堆叠规则：STACKABLE 叠加 / NON_STACKABLE 新行 / UNIQUE 拒绝重复）。 */
function grantItem(playerRowId, itemId, { quantity = 1, sourceType = 'DUNGEON_REWARD', sourceId = null, metadata = null } = {}) {
  const db = getDb();
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND status = 'approved'").get(itemId);
  if (!item) return { granted: 'REJECTED', reason: 'ITEM_NOT_APPROVED' };
  const qty = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)));
  const stacking = item.stacking || 'STACKABLE';
  const existing = db.prepare('SELECT * FROM player_items WHERE player_id = ? AND item_id = ?').get(playerRowId, itemId);

  if (stacking === 'UNIQUE' && existing) {
    return { granted: 'REJECTED', reason: 'UNIQUE_ITEM_ALREADY_OWNED', itemName: item.name };
  }
  if (stacking === 'NON_STACKABLE' && existing) {
    return { granted: 'REJECTED', reason: 'NON_STACKABLE_LIMIT', itemName: item.name };
  }
  if (existing && stacking === 'STACKABLE') {
    const newQty = Math.min(99, existing.quantity + qty);
    db.prepare('UPDATE player_items SET quantity = ? WHERE id = ?').run(newQty, existing.id);
    audit(playerRowId, 'ITEM', 'stack', sourceType, sourceId, `${item.name}×${existing.quantity}`, `${item.name}×${newQty}`);
    // 阶段14 桥接：堆叠同步进入持久背包
    try {
      const inventoryService = require('../inventory/inventoryService');
      const def = inventoryService.syncDefinitionFromLegacyItem(item);
      inventoryService.addItem(null, playerRowId, def.item_key, { amount: qty, sourceType, sourceId: sourceId != null ? String(sourceId) : null });
    } catch { /* ignore */ }
    return { granted: 'STACKED', itemName: item.name, quantity: newQty };
  }
  db.prepare(
    'INSERT INTO player_items (player_id, item_id, quantity, source, source_type, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(playerRowId, itemId, qty, sourceId != null ? String(sourceId) : sourceType, sourceType, metadata ? JSON.stringify(metadata) : null);
  audit(playerRowId, 'ITEM', 'grant', sourceType, sourceId, null, `${item.name}×${qty}`);
  // 阶段14 桥接：旧物品发放同步进入持久背包（失败不阻塞旧流程）
  try {
    const inventoryService = require('../inventory/inventoryService');
    const def = inventoryService.syncDefinitionFromLegacyItem(item);
    inventoryService.addItem(null, playerRowId, def.item_key, { amount: qty, sourceType, sourceId: sourceId != null ? String(sourceId) : null });
  } catch { /* 背包满等：旧系统发放仍有效 */ }
  return { granted: 'NEW', itemName: item.name, quantity: qty };
}

/** 货币授予（复用 currencies；balance + 交易日志）。 */
function grantCurrency(playerRowId, currencyId, amount, { sourceType = 'DUNGEON_REWARD', sourceId = null } = {}) {
  const db = getDb();
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { granted: 'REJECTED', reason: 'INVALID_AMOUNT' };
  const cur = db.prepare('SELECT * FROM currencies WHERE id = ?').get(currencyId);
  if (!cur) return { granted: 'REJECTED', reason: 'CURRENCY_NOT_FOUND' };
  db.prepare(
    `INSERT INTO player_currency (player_id, currency_id, balance) VALUES (?, ?, ?)
     ON CONFLICT(player_id, currency_id) DO UPDATE SET balance = balance + excluded.balance`
  ).run(playerRowId, currencyId, amt);
  const bal = db.prepare('SELECT balance FROM player_currency WHERE player_id = ? AND currency_id = ?').get(playerRowId, currencyId).balance;
  audit(playerRowId, 'CURRENCY', 'grant', sourceType, sourceId, bal - amt, bal);
  return { granted: 'GRANTED', currencyName: cur.name, amount: amt, balance: bal };
}

/** 装备：服务器验证所有权与槽位；替换时旧装备回背包（背包行始终存在，仅装备槽记录切换）。 */
function equip(playerRowId, itemId, slot = null) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new CharacterError('ITEM_NOT_FOUND', '物品不存在', 404);
  const owned = db.prepare('SELECT * FROM player_items WHERE player_id = ? AND item_id = ?').get(playerRowId, itemId);
  if (!owned) throw new CharacterError('NOT_OWNED', '你未拥有该物品，不能装备', 403);
  if (!['weapon', 'armor', 'accessory'].includes(item.kind)) {
    throw new CharacterError('NOT_EQUIPPABLE', `「${item.name}」不是可装备物品`, 400);
  }
  // 槽位解析：weapon→weapon，armor→armor，accessory→accessory_1/2（服务器决定，客户端不能任意指定）
  let target = slot;
  if (item.kind === 'weapon') target = 'weapon';
  else if (item.kind === 'armor') target = 'armor';
  else if (item.kind === 'accessory') {
    const has1 = db.prepare("SELECT 1 FROM character_equipment WHERE player_id = ? AND slot = 'accessory_1' AND item_id != ?").get(playerRowId, itemId);
    target = has1 ? 'accessory_2' : 'accessory_1';
  }
  if (!['weapon', 'armor', 'accessory_1', 'accessory_2'].includes(target)) {
    throw new CharacterError('INVALID_SLOT', '非法装备槽', 400);
  }
  // UNIQUE 物品若已在其他槽 → 先移除
  db.prepare('DELETE FROM character_equipment WHERE player_id = ? AND item_id = ?').run(playerRowId, itemId);
  const replaced = db.prepare('SELECT item_id FROM character_equipment WHERE player_id = ? AND slot = ?').get(playerRowId, target);
  db.prepare(
    `INSERT INTO character_equipment (player_id, slot, item_id) VALUES (?, ?, ?)
     ON CONFLICT(player_id, slot) DO UPDATE SET item_id = excluded.item_id, equipped_at = datetime('now')`
  ).run(playerRowId, target, itemId);
  audit(playerRowId, 'EQUIPMENT', 'equip', 'PLAYER', itemId, replaced ? replaced.item_id : null, itemId);
  return { equipped: item.name, slot: target, replacedItemId: replaced ? replaced.item_id : null };
}

function unequip(playerRowId, slot) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM character_equipment WHERE player_id = ? AND slot = ?').get(playerRowId, slot);
  if (!row) throw new CharacterError('SLOT_EMPTY', '该槽位没有装备', 400);
  db.prepare('DELETE FROM character_equipment WHERE id = ?').run(row.id);
  audit(playerRowId, 'EQUIPMENT', 'unequip', 'PLAYER', row.item_id, row.item_id, null);
  return { unequipped: row.item_id, slot };
}

/** 属性修正（PERMANENT / TEMPORARY）。临时修正绑定实例，副本结束清理。 */
function addStatModifier(playerRowId, stat, delta, { scope = 'TEMPORARY', instanceId = null, sourceType = 'RUNTIME', sourceId = null } = {}) {
  if (!ATTRIBUTES.includes(stat)) throw new CharacterError('INVALID_STAT', `非法属性 ${stat}`, 400);
  const d = Math.round(Number(delta) || 0);
  if (d === 0) return { ok: true, noop: true };
  getDb()
    .prepare('INSERT INTO character_modifiers (player_id, stat, delta, scope, instance_id, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(playerRowId, stat, d, scope, instanceId, sourceType, sourceId != null ? String(sourceId) : null);
  audit(playerRowId, 'STAT', scope === 'PERMANENT' ? 'permanent_mod' : 'temporary_mod', sourceType, sourceId, stat, `${stat}${d >= 0 ? '+' : ''}${d}`);
  return { ok: true, stat, delta: d, scope };
}

/** 副本结束：清除该实例的全部临时修正（临时效果不污染长期角色）。 */
function clearTemporaryModifiers(playerRowId, instanceId) {
  getDb()
    .prepare("DELETE FROM character_modifiers WHERE player_id = ? AND scope = 'TEMPORARY' AND instance_id = ?")
    .run(playerRowId, instanceId);
}

/** 角色快照（副本开始时）。 */
function snapshotCharacter(playerRowId, instanceId) {
  const db = getDb();
  const c = getCharacter(playerRowId);
  const snap = {
    level: c.level,
    experience: c.experience,
    hp: c.currentHp,
    maxHp: c.maxHp,
    stats: c.stats,
    skills: c.skills.map((s) => s.name),
    equipment: c.equipment.map((e) => ({ slot: e.slot, itemId: e.item_id })),
    avatarSource: c.avatarSource,
  };
  db.prepare(
    'INSERT OR IGNORE INTO instance_character_snapshots (instance_id, player_id, snapshot) VALUES (?, ?, ?)'
  ).run(instanceId, playerRowId, JSON.stringify(snap));
  return snap;
}

function getSnapshot(playerRowId, instanceId) {
  const row = getDb()
    .prepare('SELECT snapshot FROM instance_character_snapshots WHERE instance_id = ? AND player_id = ?')
    .get(instanceId, playerRowId);
  return row ? JSON.parse(row.snapshot) : null;
}

/**
 * 技能使用（阶段6 第十三~十七节）：声明式效果，服务器全验证。
 * 验证链：拥有 → 状态允许 → 冷却 → 次数 → 执行效果。
 * 返回 { ok, effects: [...], reason? }；DAMAGE/ROLL_MODIFIER 等由 Runtime 应用。
 */
function useSkill(playerRowId, skillRef, { instanceId = null, turn = 0 } = {}) {
  const db = getDb();
  const held = /^\d+$/.test(String(skillRef))
    ? db.prepare('SELECT ps.*, s.id AS def_id FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.id = ? AND ps.player_id = ?').get(Number(skillRef), playerRowId)
    : db.prepare('SELECT ps.*, s.id AS def_id FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id = ? AND s.name = ?').get(playerRowId, String(skillRef));
  if (!held) return { ok: false, reason: 'SKILL_NOT_OWNED' };

  const def = db.prepare('SELECT * FROM skills WHERE id = ?').get(held.def_id);
  const st = db.prepare('SELECT * FROM player_states WHERE player_id = ?').get(playerRowId);
  if (st && JSON.parse(st.status_effects || '[]').includes('DOWNED')) {
    return { ok: false, reason: 'DOWNED_CANNOT_ACT' };
  }
  // 冷却（回合制，与 Dungeon Runtime 时间模型兼容）
  const cooldownTurns = def.cooldown_turns || 0;
  if (cooldownTurns > 0 && held.cooldown_until_turn != null && turn < held.cooldown_until_turn) {
    return { ok: false, reason: 'ON_COOLDOWN', readyAtTurn: held.cooldown_until_turn };
  }
  // 次数限制
  if (def.max_uses != null) {
    if (held.uses_remaining != null && held.uses_remaining <= 0) return { ok: false, reason: 'NO_USES_LEFT' };
  }

  // 消耗：冷却 + 次数
  db.prepare('UPDATE player_skills SET last_used_turn = ?, cooldown_until_turn = ?, uses_remaining = ? WHERE id = ?').run(
    turn,
    cooldownTurns > 0 ? turn + cooldownTurns : null,
    def.max_uses != null ? Math.max(0, (held.uses_remaining ?? def.max_uses) - 1) : held.uses_remaining,
    held.id
  );
  audit(playerRowId, 'SKILL', 'use', 'RUNTIME', instanceId, def.name, `turn=${turn}`);

  // 声明式效果执行（绝不执行代码）
  let effectData = {};
  try {
    effectData = def.effect_data ? JSON.parse(def.effect_data) : {};
  } catch {
    effectData = {};
  }
  const effects = [];
  for (const eff of effectData.effects || []) {
    switch (eff.type) {
      case 'HEAL': {
        const amount = Math.max(1, Math.min(50, Number(eff.value) || 0));
        const r = changeHp(playerRowId, amount, { sourceType: 'SKILL', sourceId: def.name, action: 'skill_heal' });
        effects.push({ type: 'HEAL', value: amount, hp: r.hp });
        break;
      }
      case 'STAT_MODIFIER': {
        if (eff.stat && ATTRIBUTES.includes(eff.stat)) {
          addStatModifier(playerRowId, eff.stat, Number(eff.delta) || 0, {
            scope: eff.permanent ? 'PERMANENT' : 'TEMPORARY',
            instanceId,
            sourceType: 'SKILL',
            sourceId: def.name,
          });
          effects.push({ type: 'STAT_MODIFIER', stat: eff.stat, delta: Number(eff.delta) || 0 });
        }
        break;
      }
      case 'DAMAGE':
      case 'ROLL_MODIFIER':
      case 'ADVANTAGE':
      case 'DISADVANTAGE':
      case 'REVEAL':
      case 'UNLOCK_ACTION':
      case 'TRIGGER_EVENT':
        // 由 Runtime 根据当前战斗/场景应用；这里只记录声明
        effects.push({ type: eff.type, value: eff.value ?? null, when: eff.when ?? null, action: eff.action ?? null });
        break;
      default:
        break; // 未知效果类型忽略（安全）
    }
  }
  return { ok: true, skillName: def.name, effects, level: held.level };
}

module.exports = {
  CharacterError,
  ensureCharacter,
  getCharacter,
  effectiveStats,
  grantXp,
  changeHp,
  revive,
  grantSkill,
  grantItem,
  grantCurrency,
  equip,
  unequip,
  addStatModifier,
  clearTemporaryModifiers,
  snapshotCharacter,
  getSnapshot,
  useSkill,
  audit,
};
