/**
 * Dungeon Instance Manager（阶段5）：实例生命周期 + 队伍（座位制）。
 * Instance ≠ Definition；实例独立于房主会话（房主断线副本不消失）。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const worldState = require('../world/worldState');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 3;
const ACTIVE_STATUSES = ['WAITING', 'RUNNING', 'PAUSED'];

class InstanceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function newUid() {
  return `inst_${crypto.randomBytes(4).toString('hex')}`;
}

function getInstance(idOrUid) {
  const db = getDb();
  const row = /^\d+$/.test(String(idOrUid))
    ? db.prepare('SELECT * FROM dungeon_instances WHERE id = ?').get(Number(idOrUid))
    : db.prepare('SELECT * FROM dungeon_instances WHERE uid = ?').get(String(idOrUid));
  if (!row) throw new InstanceError('INSTANCE_NOT_FOUND', `副本实例 "${idOrUid}" 不存在`, 404);
  return row;
}

/** 房间当前活跃实例（一间房同时只跑一个）。 */
function getActiveByRoom(roomId) {
  return getDb()
    .prepare(
      `SELECT * FROM dungeon_instances WHERE room_id = ? AND status IN ('WAITING','RUNNING','PAUSED') ORDER BY id DESC LIMIT 1`
    )
    .get(roomId);
}

/** 实例对应的已发布 Definition。 */
function getDefinition(instance) {
  const v = getDb().prepare('SELECT * FROM dungeon_versions WHERE id = ?').get(instance.dungeon_version_id);
  if (!v) throw new InstanceError('VERSION_NOT_FOUND', '实例引用的版本不存在', 404);
  return { version: v, definition: JSON.parse(v.definition_json) };
}

function partyOf(instance) {
  return JSON.parse(instance.party || '[]');
}

function saveParty(instance, party) {
  getDb().prepare("UPDATE dungeon_instances SET party = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(party),
    instance.id
  );
}

/** 创建实例（仅 PUBLISHED 版本；同房间不重复活跃实例）。 */
function createInstance({ roomId, dungeonVersionId }) {
  const db = getDb();
  const version = db.prepare('SELECT * FROM dungeon_versions WHERE id = ?').get(Number(dungeonVersionId));
  if (!version) throw new InstanceError('VERSION_NOT_FOUND', '版本不存在', 404);
  if (version.status !== 'PUBLISHED') {
    throw new InstanceError('NOT_PUBLISHED', `只有 PUBLISHED 版本可运行（当前 ${version.status}）`, 409);
  }
  if (getActiveByRoom(roomId)) {
    throw new InstanceError('ROOM_BUSY', '该房间已有活跃副本实例', 409);
  }
  let uid;
  do {
    uid = newUid();
  } while (db.prepare('SELECT 1 FROM dungeon_instances WHERE uid = ?').get(uid));

  const info = db
    .prepare('INSERT INTO dungeon_instances (uid, dungeon_version_id, room_id, status) VALUES (?, ?, ?, ?)')
    .run(uid, version.id, roomId, 'WAITING');
  logEvent({ id: info.lastInsertRowid }, 'CREATE', 'server', { uid, dungeonVersionId: version.id });
  return getInstance(info.lastInsertRowid);
}

/** 加入（仅 WAITING；2~3 人；运行中禁止新玩家加入）。 */
function joinInstance(instance, playerRowId) {
  if (instance.status !== 'WAITING') {
    throw new InstanceError('ALREADY_RUNNING', '副本运行中禁止新玩家加入（中途加入未实现）', 409);
  }
  const party = partyOf(instance);
  if (party.includes(playerRowId)) return instance; // 重复加入幂等
  if (party.length >= MAX_PLAYERS) throw new InstanceError('INSTANCE_FULL', '副本已满（最多3人）', 409);
  party.push(playerRowId);
  saveParty(instance, party);
  logEvent(instance, 'JOIN', `player#${playerRowId}`, { partySize: party.length });
  return getInstance(instance.id);
}

/** 离开：WAITING 移除；RUNNING 保留座位（断线语义），无人则 ABORTED。 */
function leaveInstance(instance, playerRowId) {
  const party = partyOf(instance);
  if (!party.includes(playerRowId)) return getInstance(instance.id);
  if (instance.status === 'WAITING') {
    saveParty(instance, party.filter((p) => p !== playerRowId));
    logEvent(instance, 'LEAVE', `player#${playerRowId}`, {});
  } else if (ACTIVE_STATUSES.includes(instance.status)) {
    // 座位保留（断线恢复）；若队伍彻底清空则 ABORTED
    const remaining = party.filter((p) => p !== playerRowId);
    if (remaining.length === 0) {
      getDb()
        .prepare("UPDATE dungeon_instances SET status = 'ABORTED', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(instance.id);
      logEvent(instance, 'ABORT', 'server', { reason: '所有玩家离开' });
    }
  }
  return getInstance(instance.id);
}

/** 开始：≥2 人；初始化场景与世界状态（世界状态属于实例，不回写 Definition）。 */
function startInstance(io, instance) {
  if (instance.status !== 'WAITING') {
    throw new InstanceError('INVALID_TRANSITION', `只有 WAITING 可开始（当前 ${instance.status}）`, 409);
  }
  const party = partyOf(instance);
  if (party.length < MIN_PLAYERS) throw new InstanceError('NOT_ENOUGH_PLAYERS', `至少需要 ${MIN_PLAYERS} 名玩家`, 409);

  const { definition } = getDefinition(instance);
  const scenes = [...(definition.scenes || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!scenes.length) throw new InstanceError('NO_SCENES', '副本定义缺少场景', 422);
  const firstScene = scenes[0];

  // 重置房间世界状态（每个实例全新世界；乐观锁版本重新计数）
  const db = getDb();
  db.prepare('DELETE FROM world_states WHERE room_id = ?').run(instance.room_id);
  worldState.ensureWorld(instance.room_id);

  db.prepare(
    `UPDATE dungeon_instances SET status = 'RUNNING', current_scene_id = ?, world_state_version = ?,
       started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(firstScene.id, worldState.getWorld(instance.room_id).version, instance.id);

  const fresh = getInstance(instance.id);
  logEvent(fresh, 'START', 'server', { scene: firstScene.id, party });

  // 阶段6：副本开始 = 角色快照（副本内用实例状态；结束才回写长期角色）
  const characterService = require('../character/characterService');
  for (const pid of party) {
    try {
      characterService.ensureCharacter(pid);
      characterService.snapshotCharacter(pid, fresh.id);
    } catch { /* 快照失败不阻塞开始 */ }
  }

  applySceneEntryEvents(io, fresh, definition, firstScene.id);
  broadcastUpdate(io, fresh);
  return getInstance(instance.id);
}

/** 场景进入时的声明式事件（阶段4 事件模型：仅声明式动作，由服务器执行）。 */
function applySceneEntryEvents(io, instance, definition, sceneId) {
  const scene = (definition.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return;
  const eventIds = scene.events || [];
  for (const evtId of eventIds) {
    const evt = (definition.events || []).find((e) => e.id === evtId);
    if (!evt) continue;
    for (const action of evt.actions || []) {
      if (action.type === 'MODIFY_WORLD_FLAG') {
        try {
          worldState.setWorldField(instance.room_id, action.flag, action.value, {
            actor: `event:${evt.id}`,
            action: 'declarative_event',
          });
          logEvent(instance, 'EVENT', `event:${evt.id}`, { flag: action.flag, value: action.value });
          io.to(instance.room_id).emit('world:changed', { flag: action.flag, value: action.value, source: 'event' });
        } catch {
          /* 版本冲突等：声明式事件失败不阻塞场景 */
        }
      }
      // 其他声明式类型（SET_SCENE/SPAWN_ENCOUNTER/ADD_MEMORY）由 runtime 后续解释；绝不执行代码
    }
  }
}

/** 更新状态（内部）。 */
function setStatus(instance, status) {
  const ended = ['COMPLETED', 'FAILED', 'ABORTED'].includes(status);
  getDb()
    .prepare(
      `UPDATE dungeon_instances SET status = ?, ${ended ? "ended_at = datetime('now')," : ''} updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, instance.id);
  return getInstance(instance.id);
}

function setCurrentScene(instance, sceneId) {
  getDb()
    .prepare("UPDATE dungeon_instances SET current_scene_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(sceneId, instance.id);
}

/** 事件日志（单调递增 sequence；可重放）。 */
function logEvent(instance, type, actor, data) {
  const db = getDb();
  const seq = (db.prepare('SELECT MAX(sequence) m FROM instance_events WHERE instance_id = ?').get(instance.id).m || 0) + 1;
  db.prepare('INSERT INTO instance_events (instance_id, sequence, type, actor, data) VALUES (?, ?, ?, ?, ?)').run(
    instance.id,
    seq,
    type,
    actor || null,
    JSON.stringify(data || {})
  );
  return seq;
}

function events(instance, limit = 200) {
  return getDb()
    .prepare('SELECT * FROM instance_events WHERE instance_id = ? ORDER BY sequence ASC LIMIT ?')
    .all(instance.id, limit);
}

function broadcastUpdate(io, instance) {
  io.to(instance.room_id).emit('instance:update', {
    uid: instance.uid,
    status: instance.status,
    currentSceneId: instance.current_scene_id,
    party: partyOf(instance),
  });
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  InstanceError,
  getInstance,
  getActiveByRoom,
  getDefinition,
  partyOf,
  createInstance,
  joinInstance,
  leaveInstance,
  startInstance,
  setStatus,
  setCurrentScene,
  logEvent,
  events,
  broadcastUpdate,
  applySceneEntryEvents,
};
