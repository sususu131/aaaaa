/**
 * 阵营关系（阶段12 第四节）：阵营 × 阵营 的关系（HOSTILE / NEUTRAL / ALLIED）。
 * 阶段9 的 faction_reputation 是 玩家×阵营 声望，二者互补、互不复用覆盖。
 * 红线：关系只能由服务器规则/审核后的世界事件改变；AI 无直接修改工具。
 */
const { getDb } = require('@roblox-trpg/database');

const RELATIONS = ['HOSTILE', 'NEUTRAL', 'ALLIED'];

class FactionRelationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 规范化阵营对：小 id 在前（UNIQUE 约束要求）。 */
function normalizePair(aId, bId) {
  const a = Number(aId);
  const b = Number(bId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
    throw new FactionRelationError('INVALID_PAIR', '非法阵营对（必须为两个不同阵营）');
  }
  return a < b ? [a, b] : [b, a];
}

function getFaction(factionId) {
  return getDb().prepare('SELECT * FROM factions WHERE id = ?').get(Number(factionId));
}

/**
 * 设置阵营关系（唯一合法写入口）。
 * 记录 Event Bus + world_events 审计；返回最新关系行。
 */
function setFactionRelation(io, factionAId, factionBId, relation, { source = 'server', reason = '', roomId = null } = {}) {
  if (!RELATIONS.includes(relation)) {
    throw new FactionRelationError('INVALID_RELATION', `非法关系 ${relation}（允许：${RELATIONS.join('/')}）`);
  }
  const db = getDb();
  const [a, b] = normalizePair(factionAId, factionBId);
  const fa = getFaction(a);
  const fb = getFaction(b);
  if (!fa || !fb) throw new FactionRelationError('FACTION_NOT_FOUND', '阵营不存在', 404);

  const prev = db.prepare('SELECT * FROM faction_relations WHERE faction_a = ? AND faction_b = ?').get(a, b);
  const prevRelation = prev ? prev.relation : 'NEUTRAL';
  if (prevRelation === relation) {
    return { row: prev || { faction_a: a, faction_b: b, relation }, changed: false, previous: prevRelation };
  }

  db.prepare(
    `INSERT INTO faction_relations (faction_a, faction_b, relation, updated_by, reason) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(faction_a, faction_b) DO UPDATE SET relation = ?, updated_by = ?, reason = ?, updated_at = datetime('now')`
  ).run(a, b, relation, source, reason, relation, source, reason);
  const row = db.prepare('SELECT * FROM faction_relations WHERE faction_a = ? AND faction_b = ?').get(a, b);

  // Event Bus 记录 + 世界事件审计
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, {
    type: 'FACTION_RELATION_CHANGED',
    actor: source,
    data: { factionA: fa.name, factionB: fb.name, from: prevRelation, to: relation, reason },
  });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId,
    source,
    'FACTION_RELATION_CHANGED',
    JSON.stringify({ factionA: fa.name, factionB: fb.name, relation: prevRelation }),
    JSON.stringify({ factionA: fa.name, factionB: fb.name, relation, reason }),
    'faction_relations'
  );
  if (io && roomId) {
    io.to(roomId).emit('world:event', { type: 'FACTION_RELATION_CHANGED', factionA: fa.name, factionB: fb.name, from: prevRelation, to: relation });
  }
  return { row, changed: true, previous: prevRelation };
}

/** 读取关系（默认 NEUTRAL）。 */
function getFactionRelation(factionAId, factionBId) {
  const [a, b] = normalizePair(factionAId, factionBId);
  const row = getDb().prepare('SELECT * FROM faction_relations WHERE faction_a = ? AND faction_b = ?').get(a, b);
  return { relation: row ? row.relation : 'NEUTRAL', row };
}

/**
 * 阶段20：幂等播种初始关系（预设声明，取代 seed.sql 写死）。
 * - 仅在该阵营对【尚无任何关系行】时插入；运行期改动永不被覆盖；
 * - 静默写入（updated_by='preset'，不发 Event Bus 事件——导入是初始化，不是世界变化）；
 * - 支持 uid 对（faction_a_suffix 解析后的完整 uid）或 阵营名对（可限定 dungeonIds 范围）。
 * 返回实际播种的阵营对数量。
 */
function ensureInitialRelation({ uidA = null, uidB = null, nameA = null, nameB = null, dungeonIds = null, relation = 'NEUTRAL', reason = '' } = {}) {
  if (!RELATIONS.includes(relation)) {
    throw new FactionRelationError('INVALID_RELATION', `非法关系 ${relation}（允许：${RELATIONS.join('/')}）`);
  }
  const db = getDb();
  let factionsA = [];
  let factionsB = [];
  if (uidA && uidB) {
    factionsA = [db.prepare('SELECT * FROM factions WHERE uid = ?').get(uidA)].filter(Boolean);
    factionsB = [db.prepare('SELECT * FROM factions WHERE uid = ?').get(uidB)].filter(Boolean);
  } else if (nameA && nameB) {
    // 按阵营名解析（可限定副本范围，避免跨世界误连）；同名多行时全部配对
    const byName = (name) => {
      const rows = db.prepare('SELECT * FROM factions WHERE name = ?').all(name);
      return dungeonIds && dungeonIds.length ? rows.filter((r) => dungeonIds.includes(r.dungeon_id)) : rows;
    };
    factionsA = byName(nameA);
    factionsB = byName(nameB);
  } else {
    throw new FactionRelationError('BAD_INITIAL_RELATION', '初始关系必须提供 uid 对或阵营名对');
  }
  if (!factionsA.length || !factionsB.length) return 0; // 阵营尚未导入：静默跳过（导入器幂等重试）
  let seeded = 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO faction_relations (faction_a, faction_b, relation, updated_by, reason)
     SELECT ?, ?, ?, 'preset', ?
     WHERE NOT EXISTS (SELECT 1 FROM faction_relations fr WHERE fr.faction_a = ? AND fr.faction_b = ?)`
  );
  for (const fa of factionsA) {
    for (const fb of factionsB) {
      if (fa.id === fb.id) continue;
      const [a, b] = normalizePair(fa.id, fb.id);
      const res = ins.run(a, b, relation, reason || '预设声明的初始关系', a, b);
      if (res.changes > 0) seeded += 1;
    }
  }
  return seeded;
}

/** 全部关系（带阵营名，UI/Context 用）。 */
function allRelations() {
  return getDb()
    .prepare(
      `SELECT fr.*, fa.name AS faction_a_name, fb.name AS faction_b_name
       FROM faction_relations fr JOIN factions fa ON fa.id = fr.faction_a JOIN factions fb ON fb.id = fr.faction_b
       ORDER BY fr.id`
    )
    .all();
}

/** 某阵营的关系列表。 */
function relationsOfFaction(factionId) {
  const id = Number(factionId);
  return allRelations().filter((r) => r.faction_a === id || r.faction_b === id);
}

module.exports = {
  RELATIONS,
  FactionRelationError,
  setFactionRelation,
  ensureInitialRelation,
  getFactionRelation,
  allRelations,
  relationsOfFaction,
};
