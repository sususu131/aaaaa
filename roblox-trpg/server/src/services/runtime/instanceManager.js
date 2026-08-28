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
  // 阶段12：动态副本 —— 创建时按世界状态解析变体（事件失败不阻塞创建）
  try {
    const { resolveVariantForInstance } = require('../world/dynamicDungeon');
    const variant = resolveVariantForInstance({ dungeon_version_id: version.id, room_id: roomId });
    db.prepare('UPDATE dungeon_instances SET variant_key = ? WHERE id = ?').run(variant.variant, info.lastInsertRowid);
    logEvent({ id: info.lastInsertRowid }, 'CREATE', 'server', { uid, dungeonVersionId: version.id, variant: variant.variant });
  } catch {
    logEvent({ id: info.lastInsertRowid }, 'CREATE', 'server', { uid, dungeonVersionId: version.id });
  }
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

  // 阶段21 修复：进入副本 = 清理属于【其他副本实例】的 NPC（不再显示不属于当前副本的 NPC）
  cleanupRoomNpcs(fresh.room_id, fresh.id);

  // 阶段6：副本开始 = 角色快照（副本内用实例状态；结束才回写长期角色）
  const characterService = require('../character/characterService');
  for (const pid of party) {
    try {
      characterService.ensureCharacter(pid);
      characterService.snapshotCharacter(pid, fresh.id);
    } catch { /* 快照失败不阻塞开始 */ }
  }

  // 阶段8：加载副本绑定的任务定义 → 创建任务实例 → 玩家进入事件驱动目标
  try {
    const questEngine = require('../quests/questEngine');
    questEngine.onDungeonInstanceStarted(io, fresh, party);
  } catch (err) {
    console.error('[instanceManager] quest auto-start error:', err.message);
  }

  // 阶段15：自动生成定义中的 NPC（新手流程：进入副本即遇见关键 NPC；幂等）
  try {
    const npcEngine = require('../npcs/npcEngine');
    for (const npcSpec of definition.npcs || []) {
      const npc = npcEngine.getNpc(npcSpec.uid || npcSpec.name);
      if (!npc) continue;
      npcEngine.spawnNpcInstance(io, { npcId: npc.id, roomId: fresh.room_id, dungeonInstanceId: fresh.id });
      if (npcSpec.spawn_scene) {
        getDb().prepare('UPDATE npc_instances SET location_key = ? WHERE npc_id = ? AND room_id = ?').run(npcSpec.spawn_scene, npc.id, fresh.room_id);
      }
    }
  } catch (err) {
    console.error('[instanceManager] npc auto-spawn error:', err.message);
  }

  // 阶段16：预设副本随机事件（如 Something Evil Will Happen；服务器抽签，按实例幂等）
  try {
    require('../presets/presetSeeder').maybeTriggerPresetEvents(io, fresh);
  } catch (err) {
    console.error('[instanceManager] preset events error:', err.message);
  }

  // 阶段11：传奇遭遇判定（NPC_ENCOUNTER_CHECK；概率由副本/幸运/任务进度决定；幂等不重复生成）
  try {
    const encounter = require('../legends/legendEncounter');
    const expName = definition.roblox_universe_id
      ? (getDb().prepare('SELECT roblox_experience_name FROM dungeons WHERE roblox_universe_id = ?').get(definition.roblox_universe_id) || {}).roblox_experience_name
      : null;
    // 幸运加成：取队伍最高 LUK 属性
    let luckBonus = 0;
    try {
      const characterService = require('../character/characterService');
      for (const pid of party) {
        const st = characterService.effectiveStats(pid, {});
        luckBonus = Math.max(luckBonus, (st.totals.LUK || 5) - 5);
      }
    } catch { /* ignore */ }
    encounter.encounterCheck(io, fresh.room_id, {
      dungeonInstance: { id: fresh.id, experienceName: expName },
      luckBonus,
      questProgress: 0,
    });
    encounter.ensurePerformance(fresh.id);
  } catch (err) {
    console.error('[instanceManager] encounter check error:', err.message);
  }

  applySceneEntryEvents(io, fresh, definition, firstScene.id);
  broadcastUpdate(io, fresh);
  // 阶段31：副本开始同步进大聊天框（主战场是聊天框，面板是详情台）
  try {
    const chatNotify = require('./chatNotify');
    const dungeonName = definition.dungeon?.display_name || definition.dungeon?.name || '副本';
    chatNotify.notify(io, fresh.room_id, `⚔ 副本「${dungeonName}」开始：队伍（${party.length}人）进入「${firstScene.name}」。在聊天框 @AI 提交行动即可推进。`);
  } catch { /* 通知失败不阻塞开始 */ }
  // 阶段32：进入副本 → AI GM 主动发开场白（进实例串行队列，先于玩家行动；
  // 失败有静态兜底，不阻塞开始）
  try {
    const partyRows = party
      .map((pid) => getDb().prepare('SELECT * FROM players WHERE id = ?').get(pid))
      .filter(Boolean);
    require('./runtimeEngine').enqueueOpening(io, fresh, definition, partyRows).catch(() => {});
  } catch { /* 开场白失败不阻塞开始 */ }
  return getInstance(instance.id);
}

/** 场景进入时的声明式事件（阶段4 事件模型：仅声明式动作，由服务器执行）。 */
function applySceneEntryEvents(io, instance, definition, sceneId) {
  const gameEvents = require('../quests/gameEvents');
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
          // 阶段8：世界状态变化 → Game Event（驱动隐藏任务发现等）
          gameEvents.emit(io, instance.room_id, {
            type: 'WORLD_STATE_CHANGED',
            actor: `event:${evt.id}`,
            data: { flag: action.flag, value: action.value },
            instanceId: instance.id,
          });
        } catch {
          /* 版本冲突等：声明式事件失败不阻塞场景 */
        }
      }
      // 其他声明式类型（SET_SCENE/SPAWN_ENCOUNTER/ADD_MEMORY）由 runtime 后续解释；绝不执行代码
    }
  }
}

/**
 * 阶段22：停止副本运行（玩家可主动结束；状态 → ABORTED）。
 * - 广播实例更新（前端立即反映）+ 结束事件日志；
 * - 幂等：已结束实例直接返回。
 */
function stopInstance(io, instance, { byPlayerId = null, reason = '' } = {}) {
  if (['COMPLETED', 'FAILED', 'ABORTED'].includes(instance.status)) return getInstance(instance.id);
  const stopped = setStatus(instance, 'ABORTED');
  logEvent(stopped, 'ABORT', byPlayerId ? `player:${byPlayerId}` : 'server', { reason });
  try {
    broadcastUpdate(io, stopped);
  } catch { /* 广播失败不影响停止 */ }
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, instance.room_id, {
    type: 'DUNGEON_ABORTED',
    actor: byPlayerId ? (getDb().prepare('SELECT name FROM players WHERE id = ?').get(byPlayerId) || {}).name : '系统',
    data: { instanceId: instance.id, reason: reason || '玩家手动停止' },
  });
  return stopped;
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

/**
 * 阶段21 修复：清理房间内属于【其他副本实例】的 NPC 与旧 NPC 名册记忆。
 * - npc_instances：删除绑定其他 dungeon_instance 的行（进入新副本不显示旧副本 NPC）；
 * - room_memories(kind='npc')：旧名册清空（NPC 名册唯一来源 = 服务器 npc_instances）；
 * - 世界级 NPC（dungeon_instance_id IS NULL，如世界模拟传奇）保留。
 */
function cleanupRoomNpcs(roomId, keepInstanceId) {
  const db = getDb();
  db.prepare(
    'DELETE FROM npc_instances WHERE room_id = ? AND dungeon_instance_id IS NOT NULL AND dungeon_instance_id != ?'
  ).run(roomId, keepInstanceId);
  db.prepare("DELETE FROM room_memories WHERE room_id = ? AND kind = 'npc'").run(roomId);
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
  stopInstance,
  cleanupRoomNpcs,
  setStatus,
  setCurrentScene,
  logEvent,
  events,
  broadcastUpdate,
  applySceneEntryEvents,
};
