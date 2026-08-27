/**
 * 玩家关系系统（阶段13 第三节）：玩家×玩家关系（-100~100）。
 * 红线：只能由类型化事件驱动（服务器固定增量表）——AI 无任何直接修改关系的工具。
 * 幂等：同一 dedupeKey 的事件只生效一次（player_relation_events 台账）。
 */
const { getDb } = require('@roblox-trpg/database');

class PlayerRelationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 固定增量表：调用方只能选事件类型，数值由服务器决定（防作弊核心，同阶段9 NPC 关系）
const RELATION_EVENTS = {
  PLAYER_SAVED_PLAYER: +25,   // 救助队友
  PLAYER_HELPED: +10,         // 帮助
  PLAYER_BETRAYED: -40,       // 背叛
  PLAYER_STOLE_REWARD: -30,   // 抢夺奖励
};

/** 数值 → 关系类型。 */
function relationshipType(value) {
  if (value <= -50) return 'HOSTILE';
  if (value < 0) return 'RIVAL';
  if (value >= 50) return 'TRUSTED';
  return 'FRIEND';
}

function normalizePair(aId, bId) {
  const a = Number(aId);
  const b = Number(bId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
    throw new PlayerRelationError('INVALID_PAIR', '非法玩家对（必须是两名不同玩家）');
  }
  return a < b ? [a, b] : [b, a];
}

/** 读取关系（默认 0 / FRIEND）。 */
function getRelationship(playerAId, playerBId) {
  const [a, b] = normalizePair(playerAId, playerBId);
  const row = getDb().prepare('SELECT * FROM player_relationships WHERE player_a = ? AND player_b = ?').get(a, b);
  const value = row ? row.value : 0;
  return { value, relationshipType: row ? row.relationship_type : relationshipType(0), row };
}

/**
 * 应用类型化关系事件（唯一合法写入口）。
 * 幂等：dedupeKey 已记录则跳过；并发安全（UPSERT + CHECK 钳制）。
 */
function applyEvent(io, { type, actorPlayerId, targetPlayerId, roomId = null, reason = '', dedupeKey = null }) {
  const delta = RELATION_EVENTS[type];
  if (delta === undefined) {
    throw new PlayerRelationError('INVALID_EVENT_TYPE', `非法关系事件 ${type}（允许：${Object.keys(RELATION_EVENTS).join('/')}）`);
  }
  const db = getDb();
  const actor = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(actorPlayerId));
  const target = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(targetPlayerId));
  if (!actor || !target) throw new PlayerRelationError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  if (actor.id === target.id) throw new PlayerRelationError('SELF_RELATION', '不能对自己应用关系事件');

  // 幂等台账
  if (dedupeKey) {
    const dup = db.prepare('SELECT 1 FROM player_relation_events WHERE dedupe_key = ?').get(dedupeKey);
    if (dup) return { applied: false, reason: 'DUPLICATE_EVENT', ...getRelationship(actor.id, target.id) };
  }
  const [a, b] = normalizePair(actor.id, target.id);
  const ledgerInfo = db
    .prepare('INSERT OR IGNORE INTO player_relation_events (dedupe_key, player_a, player_b, event_type, delta, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(dedupeKey, a, b, type, delta, reason);
  if (dedupeKey && ledgerInfo.changes === 0) {
    return { applied: false, reason: 'DUPLICATE_EVENT', ...getRelationship(actor.id, target.id) };
  }

  db.prepare(
    `INSERT INTO player_relationships (player_a, player_b, value, relationship_type) VALUES (?, ?, ?, ?)
     ON CONFLICT(player_a, player_b) DO UPDATE SET
       value = MIN(100, MAX(-100, player_relationships.value + ?)),
       relationship_type = ?, updated_at = datetime('now')`
  ).run(a, b, Math.max(-100, Math.min(100, delta)), relationshipType(delta), delta, relationshipType(delta));
  // 重算类型（UPSERT 里无法引用新值，简单回读更新）
  const row = db.prepare('SELECT * FROM player_relationships WHERE player_a = ? AND player_b = ?').get(a, b);
  if (row.relationship_type !== relationshipType(row.value)) {
    db.prepare('UPDATE player_relationships SET relationship_type = ? WHERE id = ?').run(relationshipType(row.value), row.id);
  }

  const result = getRelationship(actor.id, target.id);
  // Event Bus 记录 + 审计
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId || actor.room_id, {
    type: 'PLAYER_RELATION_CHANGED',
    actor: actor.name,
    actorPlayerId: actor.id,
    data: { event: type, actor: actor.name, target: target.name, delta, value: result.value, relationshipType: result.relationshipType, reason },
  });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId || actor.room_id,
    actor.name,
    `PLAYER_RELATION:${type}`,
    null,
    JSON.stringify({ target: target.name, delta, value: result.value, type: result.relationshipType }),
    'player_relations'
  );
  if (io && (roomId || actor.room_id)) {
    io.to(roomId || actor.room_id).emit('party:update', { relationshipChanged: { actor: actor.name, target: target.name, value: result.value, type: result.relationshipType } });
  }
  return { applied: true, ...result };
}

/** 房间玩家关系矩阵（UI/Context 用）。 */
function relationshipsInRoom(roomId) {
  const db = getDb();
  const players = db.prepare('SELECT id, name FROM players WHERE room_id = ? AND left_at IS NULL').all(roomId);
  const out = [];
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const rel = getRelationship(players[i].id, players[j].id);
      out.push({ a: players[i].name, b: players[j].name, value: rel.value, type: rel.relationshipType });
    }
  }
  return out;
}

/**
 * 事件监听：其他系统（副本/任务/决策）发出关系事件 → 自动应用。
 * AI 不在此链路上 —— 事件只能来自服务器系统。
 */
let registered = false;
function registerPlayerRelationsListener() {
  if (registered) return;
  registered = true;
  const gameEvents = require('../quests/gameEvents');
  gameEvents.onEvent((io, evt) => {
    try {
      if (!RELATION_EVENTS.hasOwnProperty(evt.type)) return;
      const targetId = evt.data && evt.data.targetPlayerId;
      if (!evt.actorPlayerId || !targetId) return;
      applyEvent(io, {
        type: evt.type,
        actorPlayerId: evt.actorPlayerId,
        targetPlayerId: targetId,
        roomId: evt.roomId,
        reason: (evt.data && evt.data.reason) || '',
        dedupeKey: evt.uid, // Game Event uid → 天然幂等键
      });
    } catch { /* 监听器永不崩溃主流程 */ }
  });
}

module.exports = {
  PlayerRelationError,
  RELATION_EVENTS,
  relationshipType,
  getRelationship,
  applyEvent,
  relationshipsInRoom,
  registerPlayerRelationsListener,
};
