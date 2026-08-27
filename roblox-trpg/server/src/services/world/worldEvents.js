/**
 * 世界事件系统（阶段12 第五节）：自然 / 剧情 / 系统 三类事件。
 * 事件只能由服务器规则触发，或经 AI 的 request_world_event 工具【申请】后由服务器审核执行。
 * 红线：AI 不能直接创造事件/生成怪物/发放物品 —— 所有效果由本模块的固定规则表执行。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const worldState = require('./worldState');
const factionRelations = require('./factionRelations');
const {
  WORLD_EVENT_MAX_ACTIVE,
  WORLD_EVENT_MAX_DURATION_MS,
  WORLD_EVENT_COOLDOWN_MS,
} = require('../../config');

class WorldEventError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 事件目录（白名单）：不在目录中的类型一律拒绝。
 * persistent = 无到期时间（永久记录，直到手动取消）。
 */
const EVENT_CATALOG = {
  POWER_OUTAGE: { category: 'NATURAL', label: '停电', defaultDurationMs: 5 * 60 * 1000, description: '电力中断，灯光熄灭，黑暗中的危险上升。' },
  MONSTER_INVASION: { category: 'NATURAL', label: '怪物入侵', defaultDurationMs: 10 * 60 * 1000, description: '怪物涌入当前区域，平民逃离，敌对者迎战。' },
  WEATHER_CHANGE: { category: 'NATURAL', label: '天气变化', defaultDurationMs: 10 * 60 * 1000, description: '天气改变，环境影响行动。' },
  NPC_DEATH: { category: 'STORY', label: 'NPC死亡', persistent: true, description: '某位 NPC 的死亡改变了世界格局。' },
  FACTION_WAR: { category: 'STORY', label: '阵营战争', defaultDurationMs: 15 * 60 * 1000, description: '两个阵营爆发冲突，关系转为敌对。' },
  SECRET_DISCOVERED: { category: 'STORY', label: '秘密发现', persistent: true, description: '一个秘密被揭开，世界状态永久改变。' },
  DUNGEON_MUTATION: { category: 'SYSTEM', label: '副本变化', defaultDurationMs: 15 * 60 * 1000, description: '副本规则发生系统性变化。' },
};

/** AI 可申请的事件类型子集（SYSTEM 类与 NPC 生死类禁止由 AI 发起）。 */
const AI_REQUESTABLE_TYPES = ['POWER_OUTAGE', 'WEATHER_CHANGE', 'MONSTER_INVASION', 'SECRET_DISCOVERED'];

/** data 中出现这些键 = 试图借事件夹带 NPC/物品操作，直接拒绝。 */
const FORBIDDEN_DATA_KEYS = ['npc', 'npc_id', 'spawn', 'monster', 'item', 'item_id', 'give', 'grant', 'reward', 'currency'];

const iso = (ms) => new Date(ms).toISOString();

function getEventRow(idOrUid) {
  const db = getDb();
  return /^\d+$/.test(String(idOrUid))
    ? db.prepare('SELECT * FROM world_sim_events WHERE id = ?').get(Number(idOrUid))
    : db.prepare('SELECT * FROM world_sim_events WHERE uid = ?').get(String(idOrUid));
}

/** 当前生效事件（本房间 + 全局）。 */
function activeEvents(roomId) {
  return getDb()
    .prepare("SELECT * FROM world_sim_events WHERE status = 'ACTIVE' AND (room_id = ? OR room_id IS NULL) ORDER BY id")
    .all(roomId || '__none__');
}

function hasActiveEvent(roomId, type) {
  return activeEvents(roomId).some((e) => e.event_type === type);
}

/**
 * 触发世界事件（服务器执行入口）。
 * 幂等：同房间同 dedupe_key（默认 = event_type）已有 ACTIVE 事件时不重复触发。
 */
function triggerWorldEvent(io, roomId, { type, data = {}, source = 'server', durationMs = null, dedupeKey = null, now = Date.now() } = {}) {
  const db = getDb();
  const spec = EVENT_CATALOG[type];
  if (!spec) throw new WorldEventError('UNKNOWN_EVENT_TYPE', `未知事件类型 ${type}（必须在事件目录内）`);

  const dedupe = dedupeKey || type;
  const dup = db
    .prepare("SELECT * FROM world_sim_events WHERE status = 'ACTIVE' AND (room_id = ? OR (room_id IS NULL AND ? IS NULL)) AND dedupe_key = ?")
    .get(roomId || null, roomId || null, dedupe);
  if (dup) return { triggered: false, reason: 'DUPLICATE', event: dup };

  const startedAt = iso(now);
  const expiresAt = spec.persistent ? null : iso(now + (durationMs ?? spec.defaultDurationMs));
  let uid;
  do {
    uid = `wse_${crypto.randomBytes(4).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM world_sim_events WHERE uid = ?').get(uid));

  const info = db
    .prepare(
      'INSERT INTO world_sim_events (uid, room_id, event_type, category, status, data_json, source, dedupe_key, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(uid, roomId || null, type, spec.category, 'ACTIVE', JSON.stringify(data || {}), source, dedupe, startedAt, expiresAt);
  const event = db.prepare('SELECT * FROM world_sim_events WHERE id = ?').get(info.lastInsertRowid);

  applyEventEffects(io, roomId, event);

  // Event Bus + 审计 + UI 广播
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'WORLD_EVENT_STARTED', actor: source, data: { event: type, category: spec.category, label: spec.label, data } });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    roomId,
    source,
    `WORLD_EVENT:${type}`,
    null,
    JSON.stringify({ uid, data, expiresAt }),
    'world_events'
  );
  if (io && roomId) io.to(roomId).emit('world:event', { type: 'WORLD_EVENT_STARTED', event: type, label: spec.label, category: spec.category, expiresAt });
  return { triggered: true, event };
}

/**
 * 事件效果表（固定规则；AI 的 data 只能影响叙事描述，不能改变规则）。
 */
function applyEventEffects(io, roomId, event) {
  const data = JSON.parse(event.data_json || '{}');
  const db = getDb();
  switch (event.event_type) {
    case 'POWER_OUTAGE':
      // 复用阶段3 白名单字段 lights_on（服务器规则引擎写入，不经 AI）
      if (roomId) worldState.setWorldField(roomId, 'lights_on', false, { actor: 'server', action: 'event:POWER_OUTAGE', source: 'rule_engine' });
      break;
    case 'MONSTER_INVASION':
      if (roomId) worldState.setWorldField(roomId, 'monster_invasion', true, { actor: 'server', action: 'event:MONSTER_INVASION', source: 'rule_engine' });
      break;
    case 'SECRET_DISCOVERED': {
      // 只允许写固定剧情标志（防止 AI 夹带任意字段）
      const flag = typeof data.flag === 'string' && /^[a-z_]{3,40}$/.test(data.flag) ? data.flag : 'secret_discovered';
      if (roomId) worldState.setWorldField(roomId, flag, true, { actor: 'server', action: 'event:SECRET_DISCOVERED', source: 'rule_engine' });
      break;
    }
    case 'FACTION_WAR': {
      // data: { factionA: 名称, factionB: 名称 } → 关系转 HOSTILE；到期恢复原关系
      const fa = db.prepare('SELECT * FROM factions WHERE name = ?').get(String(data.factionA || ''));
      const fb = db.prepare('SELECT * FROM factions WHERE name = ?').get(String(data.factionB || ''));
      if (fa && fb) {
        const prev = factionRelations.getFactionRelation(fa.id, fb.id).relation;
        factionRelations.setFactionRelation(io, fa.id, fb.id, 'HOSTILE', { source: `event:${event.uid}`, reason: '阵营战争', roomId });
        const merged = { ...data, prev_relation: prev };
        db.prepare('UPDATE world_sim_events SET data_json = ? WHERE id = ?').run(JSON.stringify(merged), event.id);
      }
      break;
    }
    default:
      break; // WEATHER_CHANGE / NPC_DEATH / DUNGEON_MUTATION：无自动数值效果，仅记录
  }
}

/** 撤销效果（事件到期/取消时）。 */
function revertEventEffects(io, roomId, event) {
  const data = JSON.parse(event.data_json || '{}');
  const db = getDb();
  switch (event.event_type) {
    case 'POWER_OUTAGE':
      if (roomId) worldState.setWorldField(roomId, 'lights_on', true, { actor: 'server', action: 'event_end:POWER_OUTAGE', source: 'rule_engine' });
      break;
    case 'MONSTER_INVASION':
      if (roomId) worldState.setWorldField(roomId, 'monster_invasion', false, { actor: 'server', action: 'event_end:MONSTER_INVASION', source: 'rule_engine' });
      break;
    case 'FACTION_WAR': {
      const fa = db.prepare('SELECT * FROM factions WHERE name = ?').get(String(data.factionA || ''));
      const fb = db.prepare('SELECT * FROM factions WHERE name = ?').get(String(data.factionB || ''));
      if (fa && fb) {
        factionRelations.setFactionRelation(io, fa.id, fb.id, data.prev_relation || 'NEUTRAL', { source: `event_end:${event.uid}`, reason: '阵营战争结束', roomId });
      }
      break;
    }
    default:
      break;
  }
}

/** 到期事件结算（由 World Tick 周期调用；幂等：只处理 ACTIVE）。 */
function expireDueEvents(io, roomId, now = Date.now()) {
  const db = getDb();
  const threshold = iso(now);
  const due = db
    .prepare("SELECT * FROM world_sim_events WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ? AND (room_id = ? OR room_id IS NULL)")
    .all(threshold, roomId || '__none__');
  const expired = [];
  for (const event of due) {
    db.prepare("UPDATE world_sim_events SET status = 'EXPIRED', ended_at = ? WHERE id = ? AND status = 'ACTIVE'").run(iso(now), event.id);
    revertEventEffects(io, roomId, event);
    const gameEvents = require('../quests/gameEvents');
    gameEvents.emit(io, roomId, { type: 'WORLD_EVENT_EXPIRED', actor: 'server', data: { event: event.event_type, uid: event.uid } });
    if (io && roomId) io.to(roomId).emit('world:event', { type: 'WORLD_EVENT_EXPIRED', event: event.event_type, label: EVENT_CATALOG[event.event_type] ? EVENT_CATALOG[event.event_type].label : event.event_type });
    expired.push(event);
  }
  return expired;
}

/** 手动取消（服务器专用）。 */
function cancelEvent(io, roomId, idOrUid) {
  const db = getDb();
  const event = getEventRow(idOrUid);
  if (!event) throw new WorldEventError('EVENT_NOT_FOUND', '事件不存在', 404);
  if (event.status !== 'ACTIVE') return { cancelled: false, reason: 'NOT_ACTIVE' };
  db.prepare("UPDATE world_sim_events SET status = 'CANCELLED', ended_at = datetime('now') WHERE id = ?").run(event.id);
  revertEventEffects(io, roomId, event);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'WORLD_EVENT_EXPIRED', actor: 'server', data: { event: event.event_type, uid: event.uid, cancelled: true } });
  return { cancelled: true, event };
}

/**
 * AI 事件申请审核（第八节：AI 不能直接创造事件，只能请求，服务器审核）。
 * 通过则返回 { ok:true }，否则抛 WorldEventError。
 */
function validateAiEventRequest(roomId, { type, durationMs = null, data = {} } = {}) {
  if (!AI_REQUESTABLE_TYPES.includes(type)) {
    throw new WorldEventError('EVENT_NOT_REQUESTABLE', `AI 无权请求事件类型 ${type}（SYSTEM/剧情生死类事件为服务器专属）`, 403);
  }
  // 禁止夹带 NPC/物品操作
  for (const key of Object.keys(data || {})) {
    if (FORBIDDEN_DATA_KEYS.includes(String(key).toLowerCase())) {
      throw new WorldEventError('FORBIDDEN_DATA', `事件数据禁止包含 "${key}"（禁止借事件生成 NPC/发放物品）`, 403);
    }
  }
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 60 * 1000 || durationMs > WORLD_EVENT_MAX_DURATION_MS)) {
    throw new WorldEventError('BAD_DURATION', `事件时长必须在 1 分钟 ~ ${WORLD_EVENT_MAX_DURATION_MS / 60000} 分钟之间`, 400);
  }
  const db = getDb();
  const active = db
    .prepare("SELECT COUNT(*) c FROM world_sim_events WHERE status = 'ACTIVE' AND (room_id = ? OR room_id IS NULL)")
    .get(roomId || '__none__').c;
  if (active >= WORLD_EVENT_MAX_ACTIVE) {
    throw new WorldEventError('TOO_MANY_EVENTS', `当前房间活跃事件已达上限（${WORLD_EVENT_MAX_ACTIVE}）`, 409);
  }
  const cooldownAfter = iso(Date.now() - WORLD_EVENT_COOLDOWN_MS);
  const recent = db
    .prepare('SELECT 1 FROM world_sim_events WHERE event_type = ? AND (room_id = ? OR room_id IS NULL) AND started_at > ? LIMIT 1')
    .get(type, roomId || '__none__', cooldownAfter);
  if (recent) {
    throw new WorldEventError('EVENT_COOLDOWN', `事件 ${type} 处于冷却期（${WORLD_EVENT_COOLDOWN_MS / 60000} 分钟内不可重复）`, 409);
  }
  return { ok: true };
}

/**
 * 随机事件抽取（阶段14 补充需求：高随机性事件允许 AI 生成一部分——提供候选与权重，
 * 但【抽签由服务器执行】：候选必须在白名单内，权重被钳制，随机数来自服务器）。
 * @param candidates AI 提议的事件类型数组（必须是 AI_REQUESTABLE_TYPES 的子集，≥2）
 * @param weights 与 candidates 等长的权重（可缺省=均等；钳制 1~100）
 * @param rng 可注入（测试）；默认服务器加密随机
 * @returns 选中的事件类型
 */
function pickRandomEventType(roomId, { candidates, weights = null, rng = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    throw new WorldEventError('BAD_CANDIDATES', '候选事件至少 2 个（AI 提供候选，服务器抽签）');
  }
  const uniq = [...new Set(candidates.map(String))];
  if (uniq.length < 2) throw new WorldEventError('BAD_CANDIDATES', '候选事件重复（至少 2 个不同候选）');
  for (const c of uniq) {
    if (!AI_REQUESTABLE_TYPES.includes(c)) {
      throw new WorldEventError('CANDIDATE_NOT_REQUESTABLE', `候选事件 ${c} 不在服务器白名单内（AI 不能扩大随机范围）`, 403);
    }
  }
  const ws = uniq.map((_, i) => {
    const raw = Array.isArray(weights) ? Number(weights[i]) : 1;
    return Math.max(1, Math.min(100, Number.isFinite(raw) && raw > 0 ? raw : 1));
  });
  const total = ws.reduce((a, b) => a + b, 0);
  const roll = rng !== null ? rng * total : (crypto.randomInt(0, 100000) / 100000) * total;
  let acc = 0;
  for (let i = 0; i < uniq.length; i += 1) {
    acc += ws[i];
    if (roll < acc) return uniq[i];
  }
  return uniq[uniq.length - 1];
}

/** 申请随机世界事件：AI 给候选 → 服务器抽签 → 常规审核（冷却/上限）→ 触发。 */
function requestRandomEvent(io, roomId, { candidates, weights = null, durationMs = null, reason = '', rng = null } = {}) {
  const type = pickRandomEventType(roomId, { candidates, weights, rng });
  validateAiEventRequest(roomId, { type, durationMs, data: {} });
  const result = triggerWorldEvent(io, roomId, {
    type,
    data: { requested_by: 'ai_random', reason, candidates, via: 'random_pick' },
    source: 'ai_request',
    durationMs,
  });
  return { type, ...result };
}

module.exports = {
  WorldEventError,
  EVENT_CATALOG,
  AI_REQUESTABLE_TYPES,
  triggerWorldEvent,
  expireDueEvents,
  cancelEvent,
  activeEvents,
  hasActiveEvent,
  validateAiEventRequest,
  getEventRow,
  pickRandomEventType,
  requestRandomEvent,
};
