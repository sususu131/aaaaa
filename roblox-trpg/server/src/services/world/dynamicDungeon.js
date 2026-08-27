/**
 * 动态副本（阶段12 第六节）：副本不再固定，由世界状态（世界事件/世界标志）解析变体。
 * 例：DOORS 普通 = 100号门；停电事件 → BLACKOUT 版本；怪物入侵 → HARD 版本；
 *     秘密发现（hidden_route_discovered）→ HIDDEN_ROUTE 隐藏路线。
 */
const { getDb } = require('@roblox-trpg/database');
const worldEvents = require('./worldEvents');
const worldState = require('./worldState');

const VARIANTS = {
  NORMAL: { label: '普通', difficultyDelta: 0, description: '副本的标准状态。' },
  BLACKOUT: { label: '停电版本', difficultyDelta: 1, description: '电力中断：视野受限，实体活动增加，难度上升。' },
  HARD: { label: '困难版本', difficultyDelta: 2, description: '怪物入侵叠加：敌人数量与强度大幅提升。' },
  HIDDEN_ROUTE: { label: '隐藏路线', difficultyDelta: 0, description: '秘密路线开启：可到达常规流程无法进入的区域。' },
};

const isDoorsLike = (name) => String(name || '').toLowerCase().includes('door');

/**
 * 解析某体验在当前房间应变成的变体。
 * 优先级：怪物入侵（HARD）> 停电（BLACKOUT，仅 DOORS 系）> 隐藏路线（HIDDEN_ROUTE）> NORMAL。
 */
function resolveRoomVariant(experienceName, roomId) {
  const events = worldEvents.activeEvents(roomId).map((e) => e.event_type);
  let flags = {};
  try {
    flags = worldState.getWorld(roomId).state || {};
  } catch {
    flags = {};
  }

  const modifiers = [];
  let variant = 'NORMAL';
  if (events.includes('MONSTER_INVASION')) {
    variant = 'HARD';
    modifiers.push('MONSTER_INVASION');
  } else if (events.includes('POWER_OUTAGE') && isDoorsLike(experienceName)) {
    variant = 'BLACKOUT';
    modifiers.push('POWER_OUTAGE');
  }
  if (variant === 'NORMAL' && flags.hidden_route_discovered === true) {
    variant = 'HIDDEN_ROUTE';
    modifiers.push('SECRET_DISCOVERED');
  }
  const spec = VARIANTS[variant];
  return { variant, label: spec.label, difficultyDelta: spec.difficultyDelta, description: spec.description, modifiers };
}

/** 实例对应体验名（经版本 → 副本）。 */
function experienceNameOfInstance(instance) {
  const row = getDb()
    .prepare(
      `SELECT d.roblox_experience_name AS name FROM dungeon_versions v JOIN dungeons d ON d.id = v.dungeon_id WHERE v.id = ?`
    )
    .get(instance.dungeon_version_id);
  return row ? row.name : null;
}

/** 创建实例时解析变体（写入 variant_key）。 */
function resolveVariantForInstance({ dungeon_version_id, room_id }) {
  const name = experienceNameOfInstance({ dungeon_version_id });
  return resolveRoomVariant(name, room_id);
}

/**
 * World Tick：同步房间内活跃实例的变体（世界事件触发副本状态变化）。
 * 变体改变 → 更新实例 + Event Bus + 审计。
 */
function syncInstanceVariants(io, roomId) {
  const db = getDb();
  const instances = db
    .prepare("SELECT * FROM dungeon_instances WHERE room_id = ? AND status IN ('WAITING','RUNNING','PAUSED')")
    .all(roomId);
  const changed = [];
  for (const inst of instances) {
    const name = experienceNameOfInstance(inst);
    const resolved = resolveRoomVariant(name, roomId);
    if (resolved.variant === inst.variant_key) continue;
    db.prepare("UPDATE dungeon_instances SET variant_key = ?, updated_at = datetime('now') WHERE id = ?").run(resolved.variant, inst.id);
    const gameEvents = require('../quests/gameEvents');
    gameEvents.emit(io, roomId, {
      type: 'DUNGEON_VARIANT_CHANGED',
      actor: 'server',
      data: { instanceId: inst.id, experience: name, from: inst.variant_key, to: resolved.variant, modifiers: resolved.modifiers },
      instanceId: inst.id,
    });
    db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
      roomId,
      'server',
      'DUNGEON_VARIANT_CHANGED',
      JSON.stringify({ variant: inst.variant_key }),
      JSON.stringify({ variant: resolved.variant, experience: name }),
      'dynamic_dungeon'
    );
    if (io) io.to(roomId).emit('world:event', { type: 'DUNGEON_VARIANT_CHANGED', instanceId: inst.id, experience: name, from: inst.variant_key, to: resolved.variant, label: resolved.label });
    changed.push({ instanceId: inst.id, from: inst.variant_key, to: resolved.variant });
  }
  return changed;
}

/** 房间活跃实例的变体视图（UI/Context）。 */
function roomInstanceVariants(roomId) {
  return getDb()
    .prepare(
      `SELECT di.id, di.uid, di.status, di.variant_key, d.dungeon_name, d.roblox_experience_name
       FROM dungeon_instances di
       JOIN dungeon_versions v ON v.id = di.dungeon_version_id
       JOIN dungeons d ON d.id = v.dungeon_id
       WHERE di.room_id = ? AND di.status IN ('WAITING','RUNNING','PAUSED')`
    )
    .all(roomId)
    .map((r) => ({ ...r, variant: VARIANTS[r.variant_key] || VARIANTS.NORMAL }));
}

module.exports = { VARIANTS, resolveRoomVariant, resolveVariantForInstance, syncInstanceVariants, roomInstanceVariants, experienceNameOfInstance };
