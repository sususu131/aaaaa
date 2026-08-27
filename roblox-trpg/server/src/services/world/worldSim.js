/**
 * World Tick 系统（阶段12 第一节）：服务器周期驱动世界演化。
 * 每个 tick 执行：事件到期结算 → 动态副本同步 → NPC 自主行为 → 传奇人物世界判定。
 * 要求：可暂停 / 可恢复 / 幂等（world_ticks UNIQUE(room_id, tick_number) 保证重放跳过）。
 * 红线：tick 内所有写操作都经各引擎的固定规则；AI 不在 tick 内直接写库。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const worldEvents = require('./worldEvents');
const npcSimulation = require('./npcSimulation');
const dynamicDungeon = require('./dynamicDungeon');
const factionRelations = require('./factionRelations');
const worldState = require('./worldState');
const npcEngine = require('../npcs/npcEngine');
const legendEngine = require('../legends/legendEngine');

let timer = null;
let timerIo = null;

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};

// ── 调度器状态（持久化：重启/断线恢复后延续）──
function getSchedulerState() {
  const db = getDb();
  db.exec('INSERT OR IGNORE INTO world_scheduler (id, paused, last_tick, interval_ms) VALUES (1, 0, 0, 30000)');
  const row = db.prepare('SELECT * FROM world_scheduler WHERE id = 1').get();
  return { paused: Boolean(row.paused), lastTick: row.last_tick, intervalMs: row.interval_ms, lastRunAt: row.last_run_at };
}

function isPaused() {
  return getSchedulerState().paused;
}

/** 暂停世界模拟（幂等）。 */
function pause(io = null) {
  getDb().prepare('UPDATE world_scheduler SET paused = 1 WHERE id = 1').run();
  if (io) io.emit('world:event', { type: 'WORLD_SCHEDULER', paused: true });
  return getSchedulerState();
}

/** 恢复世界模拟（幂等）。 */
function resume(io = null) {
  getDb().prepare('UPDATE world_scheduler SET paused = 0 WHERE id = 1').run();
  if (io) io.emit('world:event', { type: 'WORLD_SCHEDULER', paused: false });
  return getSchedulerState();
}

function bumpTick() {
  const db = getDb();
  db.prepare("UPDATE world_scheduler SET last_tick = last_tick + 1, last_run_at = datetime('now') WHERE id = 1").run();
  return db.prepare('SELECT last_tick FROM world_scheduler WHERE id = 1').get().last_tick;
}

/** 需要 tick 的房间：有玩家 / 有 NPC 实例 / 有活跃事件的房间。 */
function simulationRooms() {
  const db = getDb();
  const rooms = new Set();
  for (const r of db.prepare("SELECT room_id FROM players WHERE room_id IS NOT NULL AND left_at IS NULL").all()) rooms.add(r.room_id);
  for (const r of db.prepare('SELECT DISTINCT room_id FROM npc_instances').all()) rooms.add(r.room_id);
  for (const r of db.prepare("SELECT DISTINCT room_id FROM world_sim_events WHERE status = 'ACTIVE' AND room_id IS NOT NULL").all()) rooms.add(r.room_id);
  for (const r of db.prepare('SELECT room_id FROM world_states').all()) if (r.room_id) rooms.add(r.room_id);
  return [...rooms];
}

/**
 * 执行一次房间 tick（幂等核心）：
 * - 暂停中（且未 force）→ 跳过；
 * - 同房间同 tick_number 已执行（world_ticks UNIQUE）→ 跳过（重放/重复调用安全）。
 */
function runTick(io, roomId, { tickNumber = null, force = false, now = Date.now() } = {}) {
  if (isPaused() && !force) return { paused: true, skipped: true, roomId };
  const db = getDb();
  const tick = tickNumber !== null ? Number(tickNumber) : bumpTick();
  const claim = db.prepare('INSERT OR IGNORE INTO world_ticks (room_id, tick_number) VALUES (?, ?)').run(roomId, tick);
  if (claim.changes === 0) {
    return { skipped: true, reason: 'TICK_ALREADY_PROCESSED', tickNumber: tick, roomId };
  }

  const actions = [];
  // 0. 阶段13：决策超时兜底结算（正常路径由服务器定时器触发；此为安全网）
  const dueDecisions = require('../party/decisionEngine').resolveDueDecisions(io, roomId, now);
  for (const d of dueDecisions) actions.push({ phase: 'decision_timeout', option: d.optionKey });

  // 1. 事件到期结算（停电结束恢复供电等）
  const expired = worldEvents.expireDueEvents(io, roomId, now);
  for (const e of expired) actions.push({ phase: 'expire_event', event: e.event_type, uid: e.uid });

  // 2. 动态副本同步（世界事件改变副本形态）
  const variantChanges = dynamicDungeon.syncInstanceVariants(io, roomId);
  for (const c of variantChanges) actions.push({ phase: 'dungeon_variant', ...c });

  // 3. NPC 自主行为与移动
  const activeTypes = worldEvents.activeEvents(roomId).map((e) => e.event_type);
  const flags = worldState.getWorld(roomId).state || {};
  const behaviors = npcSimulation.simulateRoomNpcs(io, roomId, { activeEventTypes: activeTypes, worldFlags: flags });
  for (const b of behaviors) {
    if (b.reason && !['hold', 'default'].includes(b.reason)) actions.push({ phase: 'npc_behavior', npcInstanceId: b.npcInstanceId, state: b.state, reason: b.reason });
  }

  // 4. 传奇人物世界判定（由剑术/世界状态/剧情决定，不是简单随机）
  const legendResult = legendWorldCheck(io, roomId);
  if (legendResult.checked) actions.push({ phase: 'legend_check', ...legendResult });

  // tick 结果落库（审计 + 断线恢复可查询）
  db.prepare("UPDATE world_ticks SET status = 'COMPLETED', result_json = ? WHERE room_id = ? AND tick_number = ?").run(
    JSON.stringify({ actions, at: new Date(now).toISOString() }),
    roomId,
    tick
  );
  // Event Bus：tick 本身也是事件（可追溯）
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, { type: 'WORLD_TICK', actor: 'server', data: { tickNumber: tick, actionCount: actions.length } });
  return { skipped: false, tickNumber: tick, roomId, actions };
}

/** 一轮全房间 tick（调度器调用）。 */
function tickAllRooms(io) {
  if (isPaused()) return { paused: true, rooms: [] };
  const results = [];
  for (const roomId of simulationRooms()) {
    try {
      results.push(runTick(io, roomId));
    } catch (err) {
      results.push({ roomId, error: err.message });
    }
  }
  return { paused: false, rooms: results };
}

/** 启动周期调度（服务器入口调用；测试直接调 runTick）。 */
function startScheduler(io, intervalMs = null) {
  if (timer) return { alreadyRunning: true };
  const state = getSchedulerState();
  const every = intervalMs || state.intervalMs || 30000;
  timerIo = io;
  timer = setInterval(() => {
    try {
      tickAllRooms(timerIo);
    } catch (err) {
      console.error('[worldSim] tick error:', err.message);
    }
  }, every);
  if (typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出（测试友好）
  return { started: true, intervalMs: every, paused: state.paused };
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  timerIo = null;
  return { stopped: true };
}

// ── 传奇人物世界联动（阶段11 NPC 加入世界模拟）──
/**
 * 检查传奇人物的世界出现条件（不是简单随机）：
 * spawn_rules.world_conditions 支持：
 *   always / any_skill（玩家持有技能名包含任一关键词）/ any_world_flag / active_event / min_quest_progress
 * 条件不满足 → 完全不掷骰。
 */
function checkLegendConditions(legend, roomId) {
  const db = getDb();
  const rules = parseJson(legend.spawn_rules_json, {});
  const cond = rules.world_conditions;
  if (!cond) return { eligible: false, reason: 'NO_WORLD_CONDITIONS' };
  if (cond.always === true) return { eligible: true, matched: ['always'] };

  const matched = [];
  // 玩家剑术/技能条件
  if (Array.isArray(cond.any_skill) && cond.any_skill.length) {
    const playerIds = db.prepare('SELECT id FROM players WHERE room_id = ? AND left_at IS NULL').all(roomId).map((p) => p.id);
    const skills = playerIds.length
      ? db
          .prepare(
            `SELECT s.name FROM player_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.player_id IN (${playerIds.map(() => '?').join(',')})`
          )
          .all(...playerIds)
          .map((s) => s.name)
      : [];
    if (skills.some((name) => cond.any_skill.some((tok) => String(name).toLowerCase().includes(String(tok).toLowerCase())))) {
      matched.push('any_skill');
    }
  }
  // 世界状态标志
  if (Array.isArray(cond.any_world_flag) && cond.any_world_flag.length) {
    const flags = worldState.getWorld(roomId).state || {};
    if (cond.any_world_flag.some((f) => flags[f] === true)) matched.push('any_world_flag');
  }
  // 活跃世界事件
  if (cond.active_event && worldEvents.hasActiveEvent(roomId, cond.active_event)) matched.push('active_event');
  // 剧情进度（房间已完成任务数）
  if (cond.min_quest_progress !== undefined) {
    const done = db.prepare("SELECT COUNT(*) c FROM quest_instances WHERE room_id = ? AND status = 'COMPLETED'").get(roomId).c;
    if (done >= Number(cond.min_quest_progress)) matched.push('quest_progress');
  }
  return { eligible: matched.length > 0, matched };
}

/**
 * tick 内传奇判定：条件通过才掷骰（服务器随机，可注入 rng）。
 * @returns { checked, spawned?: {name}, matched?, reason? }
 */
function legendWorldCheck(io, roomId, { rng = null } = {}) {
  const legends = legendEngine.allLegends();
  const existingNpcIds = new Set(npcEngine.npcInstancesInRoom(roomId).map((ni) => ni.npc_id));
  const warActive = worldEvents.hasActiveEvent(roomId, 'FACTION_WAR');
  let checkedAny = false;

  for (const legend of legends) {
    if (existingNpcIds.has(legend.npc_id)) continue;
    const cond = checkLegendConditions(legend, roomId);
    if (!cond.eligible) continue;
    checkedAny = true;

    const rules = parseJson(legend.spawn_rules_json, {});
    let chance = Number(rules.base_chance) || 0;
    chance += Math.min(0.1, cond.matched.length * 0.02); // 条件匹配越多，出现率略升
    if (warActive) chance += 0.05;                        // 阵营战争期间传奇更易现身
    chance = Math.max(0, Math.min(0.9, chance));

    const roll = rng !== null ? rng : crypto.randomInt(0, 100000) / 100000;
    const gameEvents = require('../quests/gameEvents');
    if (roll < chance) {
      npcEngine.spawnNpcInstance(io, { npcId: legend.npc_id, roomId });
      gameEvents.emit(io, roomId, { type: 'LEGENDARY_NPC_FOUND', actor: null, data: { legendId: legend.id, name: legend.display_name, rarity: legend.rarity, via: 'world_simulation', matched: cond.matched } });
      getDb().prepare('INSERT INTO world_events (room_id, actor, action, before_state, after_state, source) VALUES (?, ?, ?, ?, ?, ?)').run(
        roomId,
        'server',
        'LEGEND_WORLD_SPAWN',
        null,
        JSON.stringify({ name: legend.display_name, matched: cond.matched, chance }),
        'world_sim'
      );
      if (io) io.to(roomId).emit('world:event', { type: 'LEGEND_WORLD_SPAWN', name: legend.display_name });
      return { checked: true, spawned: { name: legend.display_name, legendId: legend.id }, matched: cond.matched, chance };
    }
    gameEvents.emit(io, roomId, { type: 'NPC_ENCOUNTER_CHECK', actor: null, data: { result: 'NONE', via: 'world_simulation', legend: legend.display_name, matched: cond.matched, roll, chance } });
    return { checked: true, spawned: null, matched: cond.matched, chance, roll };
  }
  return { checked: checkedAny, spawned: null, reason: checkedAny ? 'ROLL_MISS_OR_NONE' : 'NO_ELIGIBLE_LEGEND' };
}

// ── 世界快照（UI / Context / get_world_simulation 工具共用）──

/**
 * 阶段22 修复：房间当前世界的阵营范围。
 * 进入某副本 → 只含该副本的阵营 + 世界级阵营（dungeon_id IS NULL）；
 * 未进入副本 → 仅世界级阵营。跨世界关系（如 DOORS 关系出现在 DOD 房间）不再显示。
 */
function roomFactionScope(roomId) {
  const db = getDb();
  const inst = db
    .prepare("SELECT * FROM dungeon_instances WHERE room_id = ? AND status IN ('WAITING','RUNNING','PAUSED') ORDER BY id DESC LIMIT 1")
    .get(roomId);
  if (!inst) {
    return { dungeonId: null, factionIds: db.prepare('SELECT id FROM factions WHERE dungeon_id IS NULL').all().map((r) => r.id) };
  }
  const dungeonId = (db.prepare('SELECT dungeon_id FROM dungeon_versions WHERE id = ?').get(inst.dungeon_version_id) || {}).dungeon_id;
  const factionIds = dungeonId
    ? db.prepare('SELECT id FROM factions WHERE dungeon_id = ? OR dungeon_id IS NULL').all(dungeonId).map((r) => r.id)
    : db.prepare('SELECT id FROM factions WHERE dungeon_id IS NULL').all().map((r) => r.id);
  return { dungeonId, factionIds };
}

function worldSnapshot(roomId) {
  const db = getDb();
  const sched = getSchedulerState();
  const events = worldEvents.activeEvents(roomId).map((e) => ({
    uid: e.uid,
    type: e.event_type,
    category: e.category,
    label: worldEvents.EVENT_CATALOG[e.event_type] ? worldEvents.EVENT_CATALOG[e.event_type].label : e.event_type,
    source: e.source,
    startedAt: e.started_at,
    expiresAt: e.expires_at,
    data: parseJson(e.data_json, {}),
  }));
  // 阶段22 修复：关系按房间当前世界过滤（跨副本关系不再混入）
  const scope = roomFactionScope(roomId);
  const inScope = (r) => scope.factionIds.includes(r.faction_a) && scope.factionIds.includes(r.faction_b);
  const relations = factionRelations.allRelations().filter(inScope).map((r) => ({
    factionA: r.faction_a_name,
    factionB: r.faction_b_name,
    relation: r.relation,
    reason: r.reason,
    updatedAt: r.updated_at,
  }));
  const npcs = npcEngine.npcInstancesInRoom(roomId).map((ni) => {
    const npc = npcEngine.getNpc(ni.npc_id);
    return {
      npcInstanceId: ni.id,
      name: npc ? npc.name : `#${ni.npc_id}`,
      avatar: npc ? npc.avatar : '',
      alive: Boolean(ni.alive),
      mood: ni.mood,
      behaviorState: ni.behavior_state || 'IDLE',
      locationKey: ni.location_key || (npc ? npc.location_id : null),
      locationName: npcSimulation.locationName(ni.location_key || (npc ? npc.location_id : null)),
      traveling: parseJson(ni.behavior_data_json, {}).to || null,
    };
  });
  const recentTicks = db.prepare('SELECT tick_number, result_json, created_at FROM world_ticks WHERE room_id = ? ORDER BY id DESC LIMIT 5').all(roomId).reverse();
  const flags = worldState.getWorld(roomId).state || {};
  return {
    scheduler: sched,
    events,
    relations,
    npcs,
    variants: dynamicDungeon.roomInstanceVariants(roomId),
    recentTicks: recentTicks.map((t) => ({ tickNumber: t.tick_number, at: t.created_at, result: parseJson(t.result_json, {}) })),
    environment: { worldVersion: worldState.getWorld(roomId).version, flags },
  };
}

module.exports = {
  getSchedulerState,
  isPaused,
  pause,
  resume,
  runTick,
  tickAllRooms,
  startScheduler,
  stopScheduler,
  simulationRooms,
  checkLegendConditions,
  legendWorldCheck,
  roomFactionScope,
  worldSnapshot,
};
