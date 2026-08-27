/**
 * NPC Engine（阶段9）：持久化 NPC 系统 —— 身份/属性/目标/记忆/情绪/关系/阵营/计划。
 * 红线：AI 只能经 Tool 请求；关系/记忆/声望的全部数值变更由服务器固定规则决定，
 * 每次变更记 game_events/world_events 审计。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

// 关系数值 → 类型（-100~100）
function relationshipType(value) {
  if (value <= -50) return '敌视';
  if (value < 5) return '陌生';
  if (value < 30) return '认识';
  if (value < 60) return '友好';
  if (value < 80) return '信任';
  return '盟友';
}

// 固定关系增量表（AI 只能选 action，不能指定数值 —— 防作弊核心）
const RELATION_DELTAS = {
  help: +10,
  conversation: +2,
  deceive: -20,
  attack: -50,
  betray: -60,
  quest_complete: +15,
};

const MEMORY_BY_ACTION = {
  help: { type: 'HELP', importance: 80 },
  conversation: { type: 'CONVERSATION', importance: 20 },
  deceive: { type: 'BETRAYAL', importance: 85 },
  attack: { type: 'BETRAYAL', importance: 90 },
  betray: { type: 'BETRAYAL', importance: 95 },
  quest_complete: { type: 'QUEST', importance: 70 },
};

class NpcError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ── NPC 定义 / 实例 ──
function createNpc({ name, description = '', avatar = '🧍', personality = {}, goals = [], knowledge = [], factionId = null, locationId = null, nature = 'neutral' }) {
  const db = getDb();
  let uid;
  do {
    uid = `npc_${crypto.randomBytes(4).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM npcs WHERE uid = ?').get(uid));
  const info = db
    .prepare(
      'INSERT INTO npcs (uid, name, description, avatar, personality_json, goals_json, knowledge_json, faction_id, location_id, nature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(uid, String(name).slice(0, 60), String(description).slice(0, 500), String(avatar).slice(0, 200), JSON.stringify(personality), JSON.stringify(goals), JSON.stringify(knowledge), factionId, locationId, nature);
  return getNpc(info.lastInsertRowid);
}

function getNpc(npcIdOrUid) {
  const db = getDb();
  const row = /^\d+$/.test(String(npcIdOrUid))
    ? db.prepare('SELECT * FROM npcs WHERE id = ?').get(Number(npcIdOrUid))
    : db.prepare('SELECT * FROM npcs WHERE uid = ?').get(String(npcIdOrUid));
  if (!row) return null;
  return {
    ...row,
    personality: JSON.parse(row.personality_json || '{}'),
    goals: JSON.parse(row.goals_json || '[]'),
    knowledge: JSON.parse(row.knowledge_json || '[]'),
    nature: row.nature || 'neutral',
  };
}

/** 在房间/副本实例中生成 NPC 实例（幂等）。 */
function spawnNpcInstance(io, { npcId, roomId, dungeonInstanceId = null, state = {} }) {
  const db = getDb();
  const npc = getNpc(npcId);
  if (!npc) throw new NpcError('NPC_NOT_FOUND', 'NPC 不存在', 404);
  db.prepare(
    `INSERT OR IGNORE INTO npc_instances (npc_id, room_id, dungeon_instance_id, state_json) VALUES (?, ?, ?, ?)`
  ).run(npc.id, roomId, dungeonInstanceId, JSON.stringify(state));
  const inst = db
    .prepare('SELECT * FROM npc_instances WHERE npc_id = ? AND room_id = ? AND (dungeon_instance_id = ? OR (dungeon_instance_id IS NULL AND ? IS NULL))')
    .get(npc.id, roomId, dungeonInstanceId, dungeonInstanceId);
  if (io) io.to(roomId).emit('npc:event', { type: 'NPC_SPAWNED', npcInstanceId: inst.id, name: npc.name, avatar: npc.avatar });
  return inst;
}

function getNpcInstance(npcInstanceId) {
  return getDb().prepare('SELECT * FROM npc_instances WHERE id = ?').get(Number(npcInstanceId));
}

function npcInstancesInRoom(roomId) {
  return getDb().prepare('SELECT * FROM npc_instances WHERE room_id = ?').all(roomId);
}

function findNpcInstanceInRoom(roomId, ref) {
  const db = getDb();
  if (/^\d+$/.test(String(ref))) return db.prepare('SELECT * FROM npc_instances WHERE id = ? AND room_id = ?').get(Number(ref), roomId);
  return db
    .prepare('SELECT ni.* FROM npc_instances ni JOIN npcs n ON n.id = ni.npc_id WHERE ni.room_id = ? AND (n.name = ? OR n.uid = ?)')
    .get(roomId, String(ref), String(ref));
}

// ── 记忆系统 ──
const MAX_MEMORIES_PER_NPC = 100;

function addMemory(npcId, { playerId = null, type, importance = 50, content }) {
  const db = getDb();
  const types = ['PLAYER_ACTION', 'CONVERSATION', 'EVENT', 'BETRAYAL', 'HELP', 'QUEST'];
  if (!types.includes(type)) throw new NpcError('INVALID_MEMORY_TYPE', `非法记忆类型 ${type}`);
  const imp = Math.max(0, Math.min(100, Math.round(Number(importance) || 0)));
  db.prepare('INSERT INTO npc_memories (npc_id, player_id, memory_type, importance, content) VALUES (?, ?, ?, ?, ?)').run(
    npcId,
    playerId,
    type,
    imp,
    String(content).slice(0, 500)
  );
  // 容量上限：删除最旧低重要度记忆
  const count = db.prepare('SELECT COUNT(*) c FROM npc_memories WHERE npc_id = ?').get(npcId).c;
  if (count > MAX_MEMORIES_PER_NPC) {
    db.prepare(
      `DELETE FROM npc_memories WHERE npc_id = ? AND id IN (
        SELECT id FROM npc_memories WHERE npc_id = ? ORDER BY importance ASC, id ASC LIMIT ?)`
    ).run(npcId, npcId, count - MAX_MEMORIES_PER_NPC);
  }
}

/** 读取记忆。publicOnly：隐藏 BETRAYAL 与高重要度（≥60）记忆（玩家不可见）。 */
function getMemories(npcId, { publicOnly = false, limit = 20 } = {}) {
  const db = getDb();
  if (publicOnly) {
    return db
      .prepare("SELECT * FROM npc_memories WHERE npc_id = ? AND memory_type != 'BETRAYAL' AND importance < 60 ORDER BY importance DESC, id DESC LIMIT ?")
      .all(npcId, limit);
  }
  return db.prepare('SELECT * FROM npc_memories WHERE npc_id = ? ORDER BY importance DESC, id DESC LIMIT ?').all(npcId, limit);
}

// ── 关系系统（原子调整，-100~100 钳制）──
function adjustRelationship({ sourceType, sourceId, targetType, targetId, delta, reason = '' }) {
  const db = getDb();
  const d = Math.max(-100, Math.min(100, Math.round(Number(delta) || 0)));
  db.prepare(
    `INSERT INTO npc_relationships (source_type, source_id, target_type, target_id, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_type, source_id, target_type, target_id)
     DO UPDATE SET value = MIN(100, MAX(-100, npc_relationships.value + ?)), updated_at = datetime('now')`
  ).run(sourceType, sourceId, targetType, targetId, d, d);
  const row = db
    .prepare('SELECT * FROM npc_relationships WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?')
    .get(sourceType, sourceId, targetType, targetId);
  return { ...row, relationshipType: relationshipType(row.value), reason };
}

function getRelationship(sourceType, sourceId, targetType, targetId) {
  const row = getDb()
    .prepare('SELECT * FROM npc_relationships WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?')
    .get(sourceType, sourceId, targetType, targetId);
  if (!row) return { value: 0, relationshipType: relationshipType(0) };
  return { ...row, relationshipType: relationshipType(row.value) };
}

/**
 * 应用类型化关系事件（唯一合法的关系变更入口）。
 * AI 只能选 action（help/deceive/attack/…），数值增量由服务器固定表决定。
 */
function applyRelationshipEvent(io, { npcInstanceId, playerId, action, reason = '' }) {
  const delta = RELATION_DELTAS[action];
  if (delta === undefined) throw new NpcError('INVALID_ACTION', `非法关系动作 ${action}（允许：${Object.keys(RELATION_DELTAS).join('/')}）`);
  const inst = getNpcInstance(npcInstanceId);
  if (!inst) throw new NpcError('NPC_INSTANCE_NOT_FOUND', 'NPC 实例不存在', 404);
  if (!inst.alive) throw new NpcError('NPC_DEAD', '该 NPC 已死亡');

  const rel = adjustRelationship({ sourceType: 'npc', sourceId: inst.npc_id, targetType: 'player', targetId: playerId, delta, reason: `${action}:${reason}` });
  const memSpec = MEMORY_BY_ACTION[action];
  const player = getDb().prepare('SELECT name FROM players WHERE id = ?').get(playerId);
  const playerName = player ? player.name : `玩家${playerId}`;
  addMemory(inst.npc_id, { playerId, type: memSpec.type, importance: memSpec.importance, content: `${action === 'help' ? '帮助' : action === 'deceive' ? '欺骗' : action === 'attack' ? '攻击' : action === 'betray' ? '背叛' : action === 'quest_complete' ? '完成任务' : '交流'}：${playerName}（${reason || action}）` });

  // 情绪联动（服务器决定，不由 AI 指定）
  // 怪物本性（nature=hostile）：好感度只记录，不改变敌对情绪/行为
  const npcDef = getNpc(inst.npc_id);
  const isHostileNature = npcDef && npcDef.nature === 'hostile';
  let mood = 'neutral';
  if (isHostileNature) {
    mood = 'hostile';
  } else if (rel.value <= -50) mood = 'hostile';
  else if (rel.value >= 50) mood = 'grateful';
  else if (action === 'attack' || action === 'betray') mood = 'afraid';
  else if (action === 'help') mood = 'friendly';
  getDb().prepare("UPDATE npc_instances SET mood = ? WHERE id = ?").run(mood, inst.id);

  const eventType = `NPC_${action.toUpperCase()}`;
  if (io) {
    io.to(inst.room_id).emit('npc:event', { type: eventType, npcInstanceId: inst.id, playerId, relationship: rel.value, relationshipType: rel.relationshipType, mood });
  }
  // Event Bus + 长期世界事件（第七节：长期事件）
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, inst.room_id, { type: eventType, actor: playerName, actorPlayerId: playerId, data: { npcInstanceId: inst.id, action, delta, reason }, instanceId: inst.dungeon_instance_id });
  try {
    getDb()
      .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(inst.room_id, playerName, eventType, JSON.stringify({ value: rel.value - delta }), JSON.stringify({ value: rel.value, mood }), 'npc_engine');
  } catch { /* 审计失败不阻塞 */ }

  checkQuestGates(io, inst.room_id);
  return { relationship: rel, mood };
}

// ── NPC 死亡（长期事件：影响世界）──
function killNpc(io, npcInstanceId, { byPlayerId = null, reason = '' } = {}) {
  const db = getDb();
  const inst = getNpcInstance(npcInstanceId);
  if (!inst) throw new NpcError('NPC_INSTANCE_NOT_FOUND', 'NPC 实例不存在', 404);
  if (!inst.alive) return { alreadyDead: true };
  db.prepare("UPDATE npc_instances SET alive = 0, mood = 'dead' WHERE id = ?").run(inst.id);
  const npc = getNpc(inst.npc_id);
  addMemory(inst.npc_id, { playerId: byPlayerId, type: 'EVENT', importance: 100, content: `死亡：${reason || '被击杀'}` });
  const gameEvents = require('../quests/gameEvents');
  const byPlayer = byPlayerId ? db.prepare('SELECT name FROM players WHERE id = ?').get(byPlayerId) : null;
  gameEvents.emit(io, inst.room_id, { type: 'NPC_DEAD', actor: byPlayer ? byPlayer.name : null, actorPlayerId: byPlayerId, data: { npcInstanceId: inst.id, npcName: npc ? npc.name : null, reason }, instanceId: inst.dungeon_instance_id });
  getDb()
    .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(inst.room_id, byPlayer ? byPlayer.name : 'server', 'NPC_DEAD', JSON.stringify({ alive: true }), JSON.stringify({ alive: false, reason }), 'npc_engine');
  if (io) io.to(inst.room_id).emit('npc:event', { type: 'NPC_DEAD', npcInstanceId: inst.id, name: npc ? npc.name : null });
  return { ok: true, npcName: npc ? npc.name : null };
}

// ── 阵营声望 ──
function createFaction({ name, description = '', dungeonId = null }) {
  const db = getDb();
  let uid;
  do {
    uid = `faction_${crypto.randomBytes(3).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM factions WHERE uid = ?').get(uid));
  db.prepare('INSERT OR IGNORE INTO factions (uid, name, description, dungeon_id) VALUES (?, ?, ?, ?)').run(uid, String(name).slice(0, 60), String(description).slice(0, 300), dungeonId);
  return db.prepare('SELECT * FROM factions WHERE uid = ?').get(uid);
}

function adjustFactionReputation(playerId, factionId, delta) {
  const db = getDb();
  const d = Math.max(-100, Math.min(100, Math.round(Number(delta) || 0)));
  db.prepare(
    `INSERT INTO faction_reputation (faction_id, player_id, value) VALUES (?, ?, ?)
     ON CONFLICT(faction_id, player_id) DO UPDATE SET value = MIN(100, MAX(-100, faction_reputation.value + ?)), updated_at = datetime('now')`
  ).run(factionId, playerId, d, d);
  return db.prepare('SELECT * FROM faction_reputation WHERE faction_id = ? AND player_id = ?').get(factionId, playerId);
}

function getFactionReputation(playerId, factionId) {
  const row = getDb().prepare('SELECT * FROM faction_reputation WHERE faction_id = ? AND player_id = ?').get(factionId, playerId);
  return row ? row.value : 0;
}

// ── 任务门控（第九节：关系影响任务出现）──
function checkQuestGates(io, roomId) {
  const db = getDb();
  const questEngine = require('../quests/questEngine');
  // 带 npc_gate 的已发布任务：关系 ≥ min 才激活
  const gated = db.prepare(
    `SELECT qv.id AS version_id, qv.definition_json, q.id AS quest_id, q.uid AS quest_uid, q.name FROM quest_versions qv
     JOIN quests q ON q.id = qv.quest_id WHERE qv.status = 'PUBLISHED'`
  ).all();
  for (const g of gated) {
    let def = {};
    try {
      def = JSON.parse(g.definition_json);
    } catch {
      continue;
    }
    if (!def.npc_gate) continue;
    const exists = db.prepare('SELECT 1 FROM quest_instances qi WHERE qi.quest_version_id = ? AND qi.room_id = ?').get(g.version_id, roomId);
    if (exists) continue;
    // 门控：任一房间内玩家与该 NPC 的关系达标
    const npcInst = findNpcInstanceInRoom(roomId, def.npc_gate.npc);
    if (!npcInst) continue;
    // 怪物本性（hostile）NPC：好感度不解锁任务（关系只记录，不改变敌对行为）
    const gateNpc = getNpc(npcInst.npc_id);
    if (gateNpc && gateNpc.nature === 'hostile') continue;
    const players = db.prepare("SELECT id FROM players WHERE room_id = ? AND left_at IS NULL").all(roomId);
    const passed = players.some((p) => getRelationship('npc', npcInst.npc_id, 'player', p.id).value >= (def.npc_gate.min_relationship ?? 50));
    if (!passed) continue;
    try {
      questEngine.createInstance(io, { questVersionId: g.version_id, roomId, dungeonInstanceId: npcInst.dungeon_instance_id, partyPlayerIds: players.map((p) => p.id), activate: true });
    } catch { /* 创建失败不阻塞 */ }
  }
}

// ── NPC 公开视图（UI/REST：不泄露隐藏记忆）──
function publicNpcView(npcInstance, { playerId = null } = {}) {
  const npc = getNpc(npcInstance.npc_id);
  const rel = playerId ? getRelationship('npc', npcInstance.npc_id, 'player', playerId) : { value: 0, relationshipType: '陌生' };
  // 传奇人物档案（阶段10）
  const db = getDb();
  const legend = db.prepare('SELECT * FROM legendary_npcs WHERE npc_id = ?').get(npcInstance.npc_id);
  return {
    npcInstanceId: npcInstance.id,
    npcUid: npc.uid,
    name: npc.name,
    description: npc.description,
    avatar: npc.avatar,
    nature: npc.nature || 'neutral',
    alive: Boolean(npcInstance.alive),
    mood: npcInstance.mood,
    goals: npc.goals,
    relationship: { value: rel.value, type: rel.relationshipType },
    publicMemories: getMemories(npcInstance.npc_id, { publicOnly: true, limit: 5 }).map((m) => ({ type: m.memory_type, content: m.content, importance: m.importance })),
    currentPlan: JSON.parse(npcInstance.current_plan_json || '{}').plan || null,
    legendary: legend
      ? {
          legendId: legend.id,
          displayName: legend.display_name,
          title: legend.title,
          originType: legend.origin_type,
          originExperience: legend.origin_experience,
          rarity: legend.rarity,
          abilities: JSON.parse(legend.ability_json || '[]'),
        }
      : null,
  };
}

module.exports = {
  NpcError,
  RELATION_DELTAS,
  relationshipType,
  createNpc,
  getNpc,
  spawnNpcInstance,
  getNpcInstance,
  npcInstancesInRoom,
  findNpcInstanceInRoom,
  addMemory,
  getMemories,
  adjustRelationship,
  getRelationship,
  applyRelationshipEvent,
  killNpc,
  createFaction,
  adjustFactionReputation,
  getFactionReputation,
  checkQuestGates,
  publicNpcView,
};
