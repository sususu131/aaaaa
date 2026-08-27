/**
 * 共享世界状态（阶段3 第十七、十八节）：服务器权威 + 乐观锁版本号。
 * 世界状态只存服务器/数据库，绝不存在浏览器 React state 里。
 */
const { getDb } = require('@roblox-trpg/database');

class WorldConflictError extends Error {
  constructor() {
    super('世界状态版本冲突：请重新读取世界状态后重试');
    this.name = 'WorldConflictError';
    this.kind = 'version_conflict';
  }
}

/** 确保房间有世界状态行。 */
function ensureWorld(roomId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO world_states (room_id, version, state) VALUES (?, 0, \'{}\')').run(roomId);
  return db.prepare('SELECT * FROM world_states WHERE room_id = ?').get(roomId);
}

/** 读取世界状态。返回 { version, state }。 */
function getWorld(roomId) {
  const row = ensureWorld(roomId);
  return { version: row.version, state: JSON.parse(row.state || '{}'), updatedBy: row.updated_by, updatedAt: row.updated_at };
}

/**
 * 修改单个白名单字段（乐观锁）：version 必须匹配，成功后 +1。
 * 冲突抛 WorldConflictError —— AI 需重新读取状态再判断。
 * expectedVersion 可选：调用方持有旧版本时显式传入，用于冲突检测测试。
 */
function setWorldField(
  roomId,
  field,
  value,
  { actor = 'ai_tool', action = 'modify_world_state', source = 'ai_tool', expectedVersion } = {}
) {
  const db = getDb();
  const row = ensureWorld(roomId);
  if (expectedVersion !== undefined && expectedVersion !== row.version) throw new WorldConflictError();
  const state = JSON.parse(row.state || '{}');
  const before = { [field]: state[field] ?? null };

  state[field] = value;
  const next = JSON.stringify(state);
  const upd = db
    .prepare(
      `UPDATE world_states SET state = ?, version = version + 1, updated_by = ?, updated_at = datetime('now')
       WHERE room_id = ? AND version = ?`
    )
    .run(next, actor, roomId, row.version);

  if (upd.changes === 0) throw new WorldConflictError();

  const after = { [field]: value };
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId,
    actor,
    action,
    JSON.stringify(before),
    JSON.stringify(after),
    source
  );
  return { version: row.version + 1, field, value, before, after };
}

/** 追加一条世界事件审计（不发广播，由调用方决定）。 */
function appendEvent(roomId, actor, action, before, after, source = 'rule_engine') {
  getDb()
    .prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomId, actor, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), source);
}

/** 世界事件历史（最近 N 条，用于 Context / 审计）。 */
function recentEvents(roomId, limit = 10) {
  return getDb()
    .prepare('SELECT * FROM world_events WHERE room_id = ? ORDER BY id DESC LIMIT ?')
    .all(roomId, limit)
    .reverse();
}

module.exports = { ensureWorld, getWorld, setWorldField, appendEvent, recentEvents, WorldConflictError };
