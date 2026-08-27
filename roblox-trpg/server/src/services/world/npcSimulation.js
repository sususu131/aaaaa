/**
 * NPC 自主行为 + 移动系统（阶段12 第二、三节）。
 * 行为由服务器规则决定：personality / goals / nature / mood / 世界事件 驱动。
 * AI 只能通过 update_npc_plan 【提出】计划文本；计划必须通过本模块的规则验证才会被执行。
 */
const { getDb } = require('@roblox-trpg/database');
const npcEngine = require('../npcs/npcEngine');

const BEHAVIOR_STATES = ['IDLE', 'WORKING', 'TRAVELING', 'FIGHTING', 'FLEEING', 'PLANNING'];

class NpcSimError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

// ── 地点系统 ──
function listLocations() {
  return getDb().prepare('SELECT * FROM npc_locations ORDER BY id').all();
}

function getLocation(keyOrName) {
  const db = getDb();
  return (
    db.prepare('SELECT * FROM npc_locations WHERE key = ?').get(String(keyOrName)) ||
    db.prepare('SELECT * FROM npc_locations WHERE name = ?').get(String(keyOrName)) ||
    null
  );
}

function locationName(key) {
  if (!key) return null;
  const loc = getDb().prepare('SELECT name FROM npc_locations WHERE key = ?').get(key);
  return loc ? loc.name : key;
}

/** 第一个安全地点（FLEEING 目标；按 id 稳定选择，无随机）。 */
function nearestSafeLocation(exceptKey = null) {
  const rows = getDb().prepare('SELECT * FROM npc_locations WHERE is_safe = 1 ORDER BY id').all();
  return rows.find((r) => r.key !== exceptKey) || rows[0] || null;
}

function writeBehavior(db, inst, state, data) {
  db.prepare('UPDATE npc_instances SET behavior_state = ?, behavior_data_json = ? WHERE id = ?').run(state, JSON.stringify(data || {}), inst.id);
}

function emitBehaviorChange(io, inst, from, to, extra = {}) {
  const npc = npcEngine.getNpc(inst.npc_id);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, inst.room_id, {
    type: 'NPC_BEHAVIOR_CHANGED',
    actor: npc ? npc.name : null,
    data: { npcInstanceId: inst.id, npc: npc ? npc.name : null, from, to, location: inst.location_key, ...extra },
    instanceId: inst.dungeon_instance_id,
  });
  if (io) io.to(inst.room_id).emit('world:event', { type: 'NPC_BEHAVIOR_CHANGED', npc: npc ? npc.name : null, from, to });
}

// ── 移动系统（地点A → 地点B；多 tick 行程）──
/**
 * 开始移动。目标必须存在于 npc_locations（否则拒绝 —— AI 不能创造地点）。
 * ticks = 行程所需 tick 数（≥1；下一系列 tick 推进，到 0 时抵达）。
 */
function beginTravel(io, npcInstanceId, toKeyOrName, { ticks = 1 } = {}) {
  const db = getDb();
  const inst = npcEngine.getNpcInstance(npcInstanceId);
  if (!inst) throw new NpcSimError('NPC_INSTANCE_NOT_FOUND', 'NPC 实例不存在', 404);
  if (!inst.alive) throw new NpcSimError('NPC_DEAD', '该 NPC 已死亡，无法移动');
  const to = getLocation(toKeyOrName);
  if (!to) throw new NpcSimError('LOCATION_NOT_FOUND', `地点「${toKeyOrName}」不存在（禁止移动到未登记地点）`, 404);
  if (inst.location_key === to.key) {
    return { started: false, reason: 'ALREADY_THERE', location: to.key };
  }
  const t = Math.max(1, Math.round(Number(ticks) || 1));
  writeBehavior(db, inst, 'TRAVELING', { from: inst.location_key || null, to: to.key, remaining: t });
  emitBehaviorChange(io, { ...inst, location_key: inst.location_key }, inst.behavior_state, 'TRAVELING', { to: to.key });
  return { started: true, to: to.key, ticks: t };
}

/** 推进一次行程（每个 World Tick 调用一次）。返回 { arrived, location }。 */
function advanceTravel(io, inst) {
  const db = getDb();
  const data = parseJson(inst.behavior_data_json, {});
  const remaining = Math.max(0, Number(data.remaining) || 0) - 1;
  if (remaining > 0) {
    writeBehavior(db, inst, 'TRAVELING', { ...data, remaining });
    return { arrived: false, location: inst.location_key, remaining };
  }
  // 抵达
  const to = data.to;
  db.prepare('UPDATE npc_instances SET location_key = ?, behavior_state = ?, behavior_data_json = ? WHERE id = ?').run(to, 'IDLE', '{}', inst.id);
  // NPC 定义的常驻地点同步（玩家再次进入时看到新位置）
  db.prepare('UPDATE npcs SET location_id = ? WHERE id = ?').run(to, inst.npc_id);
  const npc = npcEngine.getNpc(inst.npc_id);
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, inst.room_id, {
    type: 'NPC_MOVED',
    actor: npc ? npc.name : null,
    data: { npcInstanceId: inst.id, npc: npc ? npc.name : null, from: data.from || null, to, locationName: locationName(to) },
    instanceId: inst.dungeon_instance_id,
  });
  db.prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
    inst.room_id,
    npc ? npc.name : 'server',
    'NPC_MOVED',
    JSON.stringify({ location: data.from || null }),
    JSON.stringify({ location: to, name: locationName(to) }),
    'npc_simulation'
  );
  if (io) io.to(inst.room_id).emit('world:event', { type: 'NPC_MOVED', npc: npc ? npc.name : null, from: data.from || null, to, locationName: locationName(to) });
  return { arrived: true, location: to };
}

// ── AI 计划验证（AI 只能提出计划；执行必须过规则验证）──
/**
 * 解析并验证 AI 提出的计划文本（update_npc_plan 写入的 current_plan_json.plan）。
 * 只有识别出合法结构化动作才会被执行；其余计划仅作为叙事，不影响状态。
 * @returns { action: 'move'|'work'|'wait'|null, target?: string, ok, reason? }
 */
function validateNpcPlan(planText) {
  const text = String(planText || '');
  if (!text.trim()) return { ok: true, action: null };
  // 移动意图：目的地必须是已登记地点（按登记名/键做最长匹配，拒绝未登记目的地）
  if (/移动到/.test(text)) {
    let best = null;
    for (const l of listLocations()) {
      for (const cand of [l.name, l.key]) {
        if (text.includes(`移动到${cand}`) && (!best || cand.length > best.cand.length)) best = { loc: l, cand };
      }
    }
    if (!best) return { ok: false, action: 'move', reason: '目的地不存在：AI 不能创造地点' };
    return { ok: true, action: 'move', target: best.loc.key };
  }
  if (/巡逻|工作|建造|修理|站岗|劳作/.test(text)) return { ok: true, action: 'work' };
  if (/等待|原地|休息|停留/.test(text)) return { ok: true, action: 'wait' };
  return { ok: true, action: null }; // 纯叙事计划：不执行任何状态变更
}

// ── 自主行为决策（确定性规则表，无随机 —— 可测试/可重放）──
/**
 * 决定单个 NPC 的下一步行为并写库。
 * 优先级：死亡 > 行程推进 > 怪物入侵反应 > AI 已验证计划 > 事件应激 > 人格/目标 > IDLE。
 */
function decideNpcBehavior(io, inst, { activeEventTypes = [], worldFlags = {} } = {}) {
  const db = getDb();
  const npc = npcEngine.getNpc(inst.npc_id);
  if (!npc || !inst.alive) return { state: inst.behavior_state, reason: 'dead' };

  const from = inst.behavior_state || 'IDLE';
  const invasion = activeEventTypes.includes('MONSTER_INVASION');
  const outage = activeEventTypes.includes('POWER_OUTAGE');
  const traits = (npc.personality && npc.personality.traits) || [];
  const goals = npc.goals || [];
  let next = from;
  let reason = 'hold';

  // 1. 行程推进（优先于其他决策，保证移动确定性）；抵达后立即重新决策
  if (from === 'TRAVELING') {
    const adv = advanceTravel(io, inst);
    if (adv.arrived) {
      const fresh = npcEngine.getNpcInstance(inst.id);
      const next = decideNpcBehavior(io, fresh, { activeEventTypes, worldFlags });
      return { ...next, reason: `arrived:${adv.location}→${next.reason}` };
    }
    return { state: 'TRAVELING', reason: 'traveling' };
  }

  // 2. 怪物入侵：敌对本性迎战，其余逃往安全点
  if (invasion) {
    if (npc.nature === 'hostile') {
      next = 'FIGHTING';
      reason = 'monster_invasion:hostile_fights';
    } else {
      const here = inst.location_key;
      const safe = nearestSafeLocation(here);
      if (safe && here !== safe.key) {
        beginTravel(io, inst.id, safe.key, { ticks: 1 });
        return { state: 'TRAVELING', reason: 'monster_invasion:flee_to_safety' };
      }
      next = 'FLEEING';
      reason = 'monster_invasion:hiding_in_safety';
    }
  } else {
    // 3. AI 计划（验证后才执行）
    const planText = parseJson(inst.current_plan_json, {}).plan || '';
    const plan = validateNpcPlan(planText);
    if (plan.ok && plan.action === 'move' && plan.target !== inst.location_key) {
      beginTravel(io, inst.id, plan.target, { ticks: 1 });
      return { state: 'TRAVELING', reason: 'ai_plan:move(validated)' };
    }
    if (plan.ok && plan.action === 'work') {
      next = 'WORKING';
      reason = 'ai_plan:work(validated)';
    } else if (plan.ok && plan.action === 'wait') {
      next = 'IDLE';
      reason = 'ai_plan:wait(validated)';
    } else if (!plan.ok) {
      reason = `ai_plan_rejected:${plan.reason}`;
      next = from; // 非法计划不执行
    } else {
      // 4. 事件应激 / 人格 / 目标
      if (outage && traits.includes('谨慎')) {
        next = 'PLANNING';
        reason = 'power_outage:cautious_plans';
      } else if (goals.some((g) => /守|守护|帮助|重建/.test(String(g)))) {
        next = 'WORKING';
        reason = 'goal_driven';
      } else {
        next = 'IDLE';
        reason = 'default';
      }
    }
  }

  if (next !== from) {
    writeBehavior(db, inst, next, {});
    emitBehaviorChange(io, inst, from, next, { reason });
  }
  return { state: next, reason };
}

/** 房间内所有存活 NPC 实例的行为推进（World Tick 调用）。 */
function simulateRoomNpcs(io, roomId, { activeEventTypes = [], worldFlags = {} } = {}) {
  const results = [];
  for (const inst of npcEngine.npcInstancesInRoom(roomId)) {
    if (!inst.alive) continue;
    try {
      results.push({ npcInstanceId: inst.id, ...decideNpcBehavior(io, inst, { activeEventTypes, worldFlags }) });
    } catch {
      /* 单个 NPC 决策失败不阻塞整个 tick */
    }
  }
  return results;
}

module.exports = {
  BEHAVIOR_STATES,
  NpcSimError,
  listLocations,
  getLocation,
  locationName,
  nearestSafeLocation,
  beginTravel,
  advanceTravel,
  validateNpcPlan,
  decideNpcBehavior,
  simulateRoomNpcs,
};
