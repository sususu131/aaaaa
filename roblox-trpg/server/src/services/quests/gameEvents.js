/**
 * Game Event Bus（阶段8 第十二节）：战斗/物品/副本等系统只发事件，不直接依赖 Quest。
 * Quest System 作为监听者消费事件并推进目标。
 * 每个事件有唯一 uid（event_id）→ Quest 幂等处理的依据。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');

const EVENT_TYPES = [
  'PLAYER_ENTERED_DUNGEON', 'PLAYER_ENTERED_SCENE', 'ITEM_ACQUIRED', 'ITEM_USED',
  'ENEMY_DEFEATED', 'DAMAGE_DEALT', 'SKILL_USED', 'NPC_TALKED', 'LOCATION_REACHED',
  'DOOR_OPENED', 'DICE_ROLLED', 'DUNGEON_COMPLETED', 'DUNGEON_FAILED',
  'PLAYER_ESCAPED', 'PLAYER_DIED', 'WORLD_STATE_CHANGED', 'SKILL_ACQUIRED', 'ITEM_EQUIPPED',
];

let listeners = [];

/** 注册 Quest 监听器（启动时由 questEngine 注册一次）。 */
function onEvent(fn) {
  if (!listeners.includes(fn)) listeners.push(fn);
}

/**
 * 发布事件：落库（唯一 uid）→ 广播 → 通知监听器。
 * @returns 事件记录 {id, uid, type, ...}
 */
function emit(io, room, { type, actor = null, actorPlayerId = null, data = {}, instanceId = null }) {
  const db = getDb();
  const uid = `evt_${crypto.randomBytes(5).toString('hex')}`;
  const info = db
    .prepare('INSERT INTO game_events (uid, room_id, instance_id, type, actor, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, room ? room.id || room : null, instanceId, type, actor, JSON.stringify(data));
  const evt = { id: info.lastInsertRowid, uid, roomId: room ? room.id || room : null, instanceId, type, actor, actorPlayerId, data };
  if (io && room) {
    io.to(room.id || room).emit('game:event', { uid, type, actor, data, at: new Date().toISOString() });
  }
  for (const fn of listeners) {
    try {
      fn(io, evt);
    } catch (err) {
      console.error('[gameEvents] listener error:', err.message);
    }
  }
  return evt;
}

/** 查询事件（advance_quest 服务器取证用）。 */
function findEvents({ roomId, instanceId, type, matchKey, matchValue, limit = 100 }) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM game_events WHERE (room_id = ? OR ? IS NULL) AND (instance_id = ? OR ? IS NULL) AND (type = ? OR ? IS NULL)
       ORDER BY id DESC LIMIT ?`
    )
    .all(roomId || null, roomId || null, instanceId || null, instanceId || null, type || null, type || null, limit);
  if (!matchKey) return rows;
  return rows.filter((r) => {
    try {
      const d = JSON.parse(r.data || '{}');
      return String(d[matchKey]) === String(matchValue);
    } catch {
      return false;
    }
  });
}

module.exports = { emit, onEvent, findEvents, EVENT_TYPES };
