/**
 * Decision 系统（阶段13 第四~七节）：普通选择 / 限时选择 / 团队决策。
 * 红线（第十三节）：
 *  - 计时在服务器（客户端只显示倒计时）；超时自动执行 default_option；
 *  - AI 只能创建选择请求，不能强制选择/延长倒计时/取消/修改结果；
 *  - 所有选项效果在创建时经服务器白名单验证，结算时由服务器执行。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const { TIMED_EVENT_MIN_MS, TIMED_EVENT_MAX_MS } = require('../../config');

class DecisionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DECISION_TYPES = ['NORMAL', 'TIMED', 'PARTY'];
const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const ALLOWED_EFFECT_KEYS = ['npc', 'quest', 'world_event', 'player_relationship', 'damage', 'heal', 'flag'];

const timers = new Map(); // decision uid → timeout handle（服务器计时）

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s || '') || fallback;
  } catch {
    return fallback;
  }
};
const iso = (ms) => new Date(ms).toISOString();

function getDecision(idOrUid) {
  const db = getDb();
  return /^\d+$/.test(String(idOrUid))
    ? db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(idOrUid))
    : db.prepare('SELECT * FROM decisions WHERE uid = ?').get(String(idOrUid));
}

function optionsOf(decisionId) {
  return getDb().prepare('SELECT * FROM decision_options WHERE decision_id = ? ORDER BY option_key').all(decisionId);
}

function votesOf(decisionId) {
  return getDb().prepare('SELECT * FROM decision_votes WHERE decision_id = ? ORDER BY id').all(decisionId);
}

function pendingDecisions(roomId) {
  return getDb().prepare("SELECT * FROM decisions WHERE room_id = ? AND status = 'PENDING' ORDER BY id").all(roomId);
}

// ── 效果白名单验证（创建时执行；AI 不能夹带任意效果）──
function validateResultData(roomId, result, { playersByName, npcFinder }) {
  if (result === null || result === undefined) return {};
  if (typeof result !== 'object' || Array.isArray(result)) throw new DecisionError('BAD_RESULT', '选项效果必须是对象');
  for (const key of Object.keys(result)) {
    if (!ALLOWED_EFFECT_KEYS.includes(key)) {
      throw new DecisionError('FORBIDDEN_EFFECT', `选项效果 "${key}" 不在白名单内（禁止 AI 自定义结算逻辑）`, 403);
    }
  }
  const r = result;
  if (r.npc) {
    const npcEngine = require('../npcs/npcEngine');
    if (!r.npc.npc || !npcEngine.RELATION_DELTAS[r.npc.action]) {
      throw new DecisionError('BAD_NPC_EFFECT', `NPC 效果非法（action 必须是 ${Object.keys(npcEngine.RELATION_DELTAS).join('/')}）`);
    }
    const inst = npcFinder(r.npc.npc); // 必须真实存在于本房间（禁止引用不存在的 NPC）
    if (!inst) throw new DecisionError('NPC_NOT_PRESENT', `NPC「${r.npc.npc}」不在当前房间（禁止引用不存在的 NPC）`, 404);
  }
  if (r.quest) {
    const db = getDb();
    if (!['advance', 'fail'].includes(r.quest.action)) throw new DecisionError('BAD_QUEST_EFFECT', 'quest.action 必须是 advance/fail');
    const qi = db.prepare("SELECT * FROM quest_instances WHERE uid = ? AND room_id = ?").get(String(r.quest.uid || ''), roomId);
    if (!qi) throw new DecisionError('QUEST_NOT_FOUND', `任务实例 ${r.quest.uid} 不在当前房间`, 404);
    if (r.quest.action === 'advance') {
      const questEngine = require('../quests/questEngine');
      const full = questEngine.getInstanceFull(qi.id);
      if (!full.objectives.some((o) => o.objective_key === r.quest.objectiveKey)) {
        throw new DecisionError('OBJECTIVE_NOT_FOUND', `任务目标 ${r.quest.objectiveKey} 不存在`, 404);
      }
    }
  }
  if (r.world_event) {
    const worldEvents = require('../world/worldEvents');
    if (!worldEvents.AI_REQUESTABLE_TYPES.includes(r.world_event.type)) {
      throw new DecisionError('FORBIDDEN_WORLD_EVENT', `选择效果中的世界事件类型 ${r.world_event.type} 不被允许`, 403);
    }
  }
  if (r.player_relationship) {
    const playerRelations = require('./playerRelations');
    if (!playerRelations.RELATION_EVENTS[r.player_relationship.event]) {
      throw new DecisionError('BAD_RELATION_EVENT', `关系事件必须是 ${Object.keys(playerRelations.RELATION_EVENTS).join('/')}`);
    }
    if (!playersByName(String(r.player_relationship.target || ''))) {
      throw new DecisionError('TARGET_NOT_FOUND', `关系目标玩家「${r.player_relationship.target}」不在当前房间`, 404);
    }
  }
  if (r.damage !== undefined) {
    const amt = Number(r.damage.amount);
    if (!Number.isInteger(amt) || amt < 1 || amt > 50) throw new DecisionError('BAD_DAMAGE', '伤害必须为 1~50 的整数');
  }
  if (r.heal !== undefined) {
    const amt = Number(r.heal.amount);
    if (!Number.isInteger(amt) || amt < 1 || amt > 50) throw new DecisionError('BAD_HEAL', '治疗必须为 1~50 的整数');
  }
  if (r.flag !== undefined) {
    if (!/^[a-z_]{3,40}$/.test(String(r.flag.name || ''))) throw new DecisionError('BAD_FLAG', 'flag.name 必须是 3~40 位小写字母/下划线');
  }
  return r;
}

/**
 * 创建决策（服务器验证全部参数与效果）。
 * @param spec { type, prompt, options:[{key?,text,result?}], defaultOption?, targetPlayerId?, timeoutMs?, requiredVotes?, resultRule?, tag?, instanceId?, creator? }
 */
function createDecision(io, roomId, spec) {
  const db = getDb();
  if (!DECISION_TYPES.includes(spec.type)) throw new DecisionError('BAD_TYPE', `非法决策类型 ${spec.type}`);
  const prompt = String(spec.prompt || '').trim();
  if (!prompt || prompt.length > 500) throw new DecisionError('BAD_PROMPT', '剧情文本必填且不超过 500 字');
  const rawOptions = Array.isArray(spec.options) ? spec.options : [];
  if (rawOptions.length < 2 || rawOptions.length > 4) throw new DecisionError('BAD_OPTIONS', '选项必须为 2~4 个');

  const players = db.prepare('SELECT * FROM players WHERE room_id = ? AND left_at IS NULL').all(roomId);
  const playersByName = (name) => players.find((p) => p.name === name || p.uid === name) || null;
  const npcEngine = require('../npcs/npcEngine');
  const npcFinder = (ref) => npcEngine.findNpcInstanceInRoom(roomId, ref);

  // 选项规范化 + 效果验证
  const options = rawOptions.map((o, i) => {
    const key = o.key && OPTION_KEYS.includes(o.key) ? o.key : OPTION_KEYS[i];
    const text = String(o.text || '').trim();
    if (!text || text.length > 120) throw new DecisionError('BAD_OPTION_TEXT', `选项 ${key} 文本非法（1~120字）`);
    const result = validateResultData(roomId, o.result || {}, { playersByName, npcFinder });
    return { key, text, result };
  });
  const keySet = new Set(options.map((o) => o.key));
  if (keySet.size !== options.length) throw new DecisionError('DUPLICATE_OPTION_KEY', '选项键重复');

  // 默认选项（TIMED 必填：超时自动执行）
  const defaultOption = spec.defaultOption || null;
  if ((spec.type === 'TIMED' || spec.type === 'PARTY') && !keySet.has(defaultOption)) {
    throw new DecisionError('BAD_DEFAULT', 'TIMED/PARTY 决策必须指定有效的 default_option（超时自动执行）');
  }

  // 计时（服务器权威；钳制范围内）
  let timeoutMs = null;
  let expiresAt = null;
  if (spec.type === 'TIMED' || spec.type === 'PARTY') {
    timeoutMs = Math.max(TIMED_EVENT_MIN_MS, Math.min(TIMED_EVENT_MAX_MS, Math.round(Number(spec.timeoutMs) || TIMED_EVENT_MAX_MS)));
    expiresAt = iso(Date.now() + timeoutMs);
  }

  // PARTY：必须有队伍；票数钳制
  let requiredVotes = null;
  let resultRule = 'FIRST_VOTE';
  if (spec.type === 'PARTY') {
    const partyService = require('./partyService');
    const party = partyService.getActiveParty(roomId);
    if (!party) throw new DecisionError('NO_PARTY', '团队决策需要房间先有队伍', 409);
    const memberCount = partyService.membersOf(party.id).length;
    requiredVotes = Math.max(1, Math.min(memberCount, Math.round(Number(spec.requiredVotes) || memberCount)));
    resultRule = spec.resultRule === 'FIRST_VOTE' ? 'FIRST_VOTE' : 'MAJORITY';
  }

  const targetPlayerId = spec.targetPlayerId || null;
  if (targetPlayerId && !players.some((p) => p.id === targetPlayerId)) {
    throw new DecisionError('TARGET_NOT_FOUND', '目标玩家不在当前房间', 404);
  }

  let uid;
  do {
    uid = `dec_${crypto.randomBytes(4).toString('hex')}`;
  } while (db.prepare('SELECT 1 FROM decisions WHERE uid = ?').get(uid));
  const info = db
    .prepare(
      `INSERT INTO decisions (uid, room_id, instance_id, type, status, creator, prompt, tag, target_player_id, default_option, timeout_ms, expires_at, required_votes, result_rule)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(uid, roomId, spec.instanceId || null, spec.type, spec.creator || 'ai', prompt, spec.tag || null, targetPlayerId, defaultOption, timeoutMs, expiresAt, requiredVotes, resultRule);
  const decision = getDecision(info.lastInsertRowid);
  const insOpt = db.prepare('INSERT INTO decision_options (decision_id, option_key, text, result_data) VALUES (?, ?, ?, ?)');
  for (const o of options) insOpt.run(decision.id, o.key, o.text, JSON.stringify(o.result));

  // Event Bus + UI 广播
  const gameEvents = require('../quests/gameEvents');
  gameEvents.emit(io, roomId, {
    type: 'DECISION_STARTED',
    actor: decision.creator,
    data: { decisionUid: uid, decisionType: spec.type, tag: spec.tag || null, options: options.map((o) => `${o.key}:${o.text}`) },
    instanceId: spec.instanceId || null,
  });
  if (io) io.to(roomId).emit('decision:new', decisionView(decision.id));
  scheduleTimer(io, decision);
  return decision;
}

function scheduleTimer(io, decision) {
  if (!decision.expires_at || decision.status !== 'PENDING') return;
  const ms = Math.max(0, new Date(decision.expires_at).getTime() - Date.now());
  const handle = setTimeout(() => {
    timers.delete(decision.uid);
    try {
      settleDecision(io, decision.uid, decision.default_option, { reason: 'TIMEOUT', playerId: null });
    } catch { /* 已结算则忽略 */ }
  }, ms);
  if (typeof handle.unref === 'function') handle.unref();
  timers.set(decision.uid, handle);
}

function clearTimer(uid) {
  const h = timers.get(uid);
  if (h) clearTimeout(h);
  timers.delete(uid);
}

/**
 * 玩家选择（服务器验证资格）。
 * PARTY = 投票（一人一票不可改）；NORMAL/TIMED = 目标玩家立即结算。
 */
function selectDecision(io, decisionIdOrUid, playerRowId, optionKey) {
  const db = getDb();
  const decision = getDecision(decisionIdOrUid);
  if (!decision) throw new DecisionError('DECISION_NOT_FOUND', '决策不存在', 404);
  if (decision.status !== 'PENDING') throw new DecisionError('ALREADY_RESOLVED', `决策已结算（${decision.status}）`, 409);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(playerRowId));
  if (!player) throw new DecisionError('PLAYER_NOT_FOUND', '玩家不存在', 404);
  if (player.room_id !== decision.room_id) throw new DecisionError('NOT_IN_ROOM', '玩家不在该房间', 403);
  const option = optionsOf(decision.id).find((o) => o.option_key === String(optionKey).toUpperCase());
  if (!option) throw new DecisionError('OPTION_NOT_FOUND', `选项 ${optionKey} 不存在`, 404);

  if (decision.type === 'PARTY') {
    const partyService = require('./partyService');
    const party = partyService.getActiveParty(decision.room_id);
    if (!party || !partyService.isMember(party.id, player.id)) {
      throw new DecisionError('NOT_PARTY_MEMBER', '只有队伍成员可以参与团队决策投票', 403);
    }
    const voteInfo = db.prepare('INSERT OR IGNORE INTO decision_votes (decision_id, player_id, option_key) VALUES (?, ?, ?)').run(decision.id, player.id, option.option_key);
    if (voteInfo.changes === 0) throw new DecisionError('ALREADY_VOTED', '每位成员只能投票一次，投出不可更改', 409);
    if (io) io.to(decision.room_id).emit('decision:update', decisionView(decision.id));

    const votes = votesOf(decision.id);
    const memberCount = partyService.membersOf(party.id).length;
    if (votes.length >= decision.required_votes || votes.length >= memberCount) {
      return settleDecision(io, decision.uid, tallyVotes(decision, votes), { reason: 'TALLY', playerId: null });
    }
    return { voted: true, optionKey: option.option_key, votes: votes.length, requiredVotes: decision.required_votes };
  }

  // NORMAL / TIMED：目标玩家限定
  if (decision.target_player_id && decision.target_player_id !== player.id) {
    throw new DecisionError('NOT_TARGET_PLAYER', '该选择指定了其他决策者', 403);
  }
  return settleDecision(io, decision.uid, option.option_key, { reason: 'PLAYER', playerId: player.id });
}

function tallyVotes(decision, votes) {
  const counts = {};
  for (const v of votes) counts[v.option_key] = (counts[v.option_key] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length && sorted[0][1] > (sorted[1] ? sorted[1][1] : 0)) return sorted[0][0];
  return decision.default_option || (sorted.length ? sorted[0][0] : null); // 平票 → 默认选项
}

/**
 * 结算（唯一结算入口；幂等：只结算 PENDING）。
 * 结算顺序：状态落库 → Event Bus（DECISION_SELECTED / DECISION_TIMEOUT）→ 服务器执行效果。
 */
function settleDecision(io, decisionIdOrUid, optionKey, { reason = 'PLAYER', playerId = null } = {}) {
  const db = getDb();
  const decision = getDecision(decisionIdOrUid);
  if (!decision) throw new DecisionError('DECISION_NOT_FOUND', '决策不存在', 404);
  if (decision.status !== 'PENDING') {
    return { settled: false, reason: 'ALREADY_RESOLVED', status: decision.status, resolvedOption: decision.resolved_option };
  }
  const option = optionsOf(decision.id).find((o) => o.option_key === optionKey) || optionsOf(decision.id)[0];
  const isTimeout = reason === 'TIMEOUT';
  db.prepare(
    `UPDATE decisions SET status = ?, resolved_option = ?, resolved_by = ?, resolved_reason = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'PENDING'`
  ).run(isTimeout ? 'TIMEOUT' : 'RESOLVED', option ? option.option_key : null, playerId, reason, decision.id);
  clearTimer(decision.uid);

  const gameEvents = require('../quests/gameEvents');
  const eventData = {
    decisionUid: decision.uid,
    decisionType: decision.type,
    tag: decision.tag,
    optionKey: option ? option.option_key : null,
    option: option ? option.text : null,
    reason,
  };
  gameEvents.emit(io, decision.room_id, {
    type: isTimeout ? 'DECISION_TIMEOUT' : 'DECISION_SELECTED',
    actor: playerId ? `player#${playerId}` : 'server',
    actorPlayerId: playerId,
    data: eventData,
    instanceId: decision.instance_id,
  });
  if (io) io.to(decision.room_id).emit('decision:update', decisionView(decision.id));

  const applied = option ? applyEffects(io, { ...decision, resolved_by: playerId }, option) : [];
  return { settled: true, reason, status: isTimeout ? 'TIMEOUT' : 'RESOLVED', optionKey: option ? option.option_key : null, effects: applied };
}

/** 结算效果执行（全部服务器侧；单项失败不阻塞其他效果）。 */
function applyEffects(io, decision, optionRow) {
  const result = parseJson(optionRow.result_data, {});
  const applied = [];
  const db = getDb();
  const playerId = decision.resolved_by || decision.target_player_id;

  const run = (key, fn) => {
    try {
      applied.push({ effect: key, ...(fn() || {}) });
    } catch (err) {
      applied.push({ effect: key, error: err.message });
    }
  };

  if (result.flag) {
    run('flag', () => {
      const worldState = require('../world/worldState');
      worldState.setWorldField(decision.room_id, result.flag.name, true, { actor: 'server', action: `decision:${decision.uid}`, source: 'rule_engine' });
      return { flag: result.flag.name };
    });
  }
  if (result.npc) {
    run('npc', () => {
      const npcEngine = require('../npcs/npcEngine');
      const inst = npcEngine.findNpcInstanceInRoom(decision.room_id, result.npc.npc);
      if (!inst) throw new DecisionError('NPC_NOT_PRESENT', 'NPC 已不在房间');
      if (!playerId) throw new DecisionError('NO_ACTOR', '该效果需要决策玩家');
      const r = npcEngine.applyRelationshipEvent(io, { npcInstanceId: inst.id, playerId, action: result.npc.action, reason: `decision:${decision.uid}` });
      return { npc: result.npc.npc, action: result.npc.action, relationship: r.relationship.value };
    });
  }
  if (result.quest) {
    run('quest', () => {
      const questEngine = require('../quests/questEngine');
      const qi = db.prepare('SELECT * FROM quest_instances WHERE uid = ?').get(result.quest.uid);
      if (!qi) throw new DecisionError('QUEST_NOT_FOUND', '任务实例不存在');
      if (result.quest.action === 'fail') {
        questEngine.setQuestStatus(io, qi.id, 'FAILED', { reason: `decision:${decision.uid}` });
        return { quest: qi.uid, action: 'fail' };
      }
      // advance：DECISION_SELECTED 已在 Event Bus，目标定义可匹配取证
      const r = questEngine.advanceQuest(io, qi.id, playerId, result.quest.objectiveKey);
      return { quest: qi.uid, action: 'advance', completed: r.completed };
    });
  }
  if (result.world_event) {
    run('world_event', () => {
      const worldEvents = require('../world/worldEvents');
      const r = worldEvents.triggerWorldEvent(io, decision.room_id, {
        type: result.world_event.type,
        data: { via_decision: decision.uid },
        source: 'decision',
        durationMs: result.world_event.durationMs || null,
      });
      return { worldEvent: result.world_event.type, triggered: r.triggered };
    });
  }
  if (result.player_relationship) {
    run('player_relationship', () => {
      const playerRelations = require('./playerRelations');
      const target = db.prepare('SELECT * FROM players WHERE room_id = ? AND name = ?').get(decision.room_id, result.player_relationship.target);
      if (!target) throw new DecisionError('TARGET_NOT_FOUND', '目标玩家不存在');
      if (!playerId) throw new DecisionError('NO_ACTOR', '该效果需要决策玩家');
      const r = playerRelations.applyEvent(io, {
        type: result.player_relationship.event,
        actorPlayerId: playerId,
        targetPlayerId: target.id,
        roomId: decision.room_id,
        reason: `decision:${decision.uid}`,
        dedupeKey: `decision:${decision.uid}:${optionRow.option_key}`,
      });
      return { event: result.player_relationship.event, value: r.value, applied: r.applied };
    });
  }
  if (result.damage || result.heal) {
    run(result.damage ? 'damage' : 'heal', () => {
      const characterService = require('../character/characterService');
      const spec = result.damage || result.heal;
      const sign = result.damage ? -1 : 1;
      const target = playerId || null;
      if (!target) throw new DecisionError('NO_ACTOR', '该效果需要决策玩家');
      const r = characterService.changeHp(target, sign * Number(spec.amount), {
        sourceType: result.damage ? 'TIMED_EVENT' : 'DECISION',
        sourceId: `decision:${decision.uid}`,
        action: result.damage ? 'decision_damage' : 'decision_heal',
      });
      if (io && result.damage) io.to(decision.room_id).emit('player:stateChanged', { playerName: null, hp: r.hp, downed: r.downed, reason: 'DECISION_DAMAGE' });
      return { amount: sign * Number(spec.amount), hp: r.hp };
    });
  }
  return applied;
}

/** tick 兜底：结算所有过期的 PENDING 决策（服务器计时失效时的安全网）。 */
function resolveDueDecisions(io, roomId, now = Date.now()) {
  const db = getDb();
  const threshold = iso(now);
  const due = db
    .prepare("SELECT * FROM decisions WHERE room_id = ? AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(roomId, threshold);
  const settled = [];
  for (const d of due) {
    try {
      settled.push(settleDecision(io, d.uid, d.default_option, { reason: 'TIMEOUT', playerId: null }));
    } catch { /* ignore */ }
  }
  return settled;
}

/**
 * 副本集成（第八节）：副本触发限时事件（Boss 技能/逃生）。
 * 复用 Decision 系统；超时 = 选择默认（失败）选项，可携带伤害效果。
 */
function triggerDungeonTimedEvent(io, instance, { prompt, options, defaultOption, timeoutMs, failDamage = 0, tag = null, targetPlayerId = null }) {
  const opts = options.map((o) => ({ ...o }));
  if (failDamage > 0) {
    const def = opts.find((o) => (o.key || '') === defaultOption) || opts[0];
    def.result = { ...(def.result || {}), damage: { amount: Math.max(1, Math.min(50, Math.round(failDamage))) } };
  }
  return createDecision(io, instance.room_id, {
    type: 'TIMED',
    prompt,
    options: opts,
    defaultOption,
    timeoutMs,
    tag,
    instanceId: instance.id,
    targetPlayerId,
    creator: 'server',
  });
}

/** 决策视图（UI/Context；不含内部 result_data —— 效果由服务器结算）。 */
function decisionView(decisionIdOrUid) {
  const decision = getDecision(decisionIdOrUid);
  if (!decision) return null;
  const options = optionsOf(decision.id).map((o) => ({ key: o.option_key, text: o.text }));
  const votes = decision.type === 'PARTY' ? votesOf(decision.id) : [];
  const voteCounts = {};
  for (const v of votes) voteCounts[v.option_key] = (voteCounts[v.option_key] || 0) + 1;
  return {
    uid: decision.uid,
    roomId: decision.room_id,
    instanceId: decision.instance_id,
    type: decision.type,
    status: decision.status,
    prompt: decision.prompt,
    tag: decision.tag,
    options,
    defaultOption: decision.default_option,
    expiresAt: decision.expires_at,
    remainingMs: decision.expires_at && decision.status === 'PENDING' ? Math.max(0, new Date(decision.expires_at).getTime() - Date.now()) : null,
    requiredVotes: decision.required_votes,
    resultRule: decision.result_rule,
    votes: voteCounts,
    totalVotes: votes.length,
    resolvedOption: decision.resolved_option,
    resolvedReason: decision.resolved_reason,
    createdAt: decision.created_at,
  };
}

/** AI 的 resolve_decision 唯一合法路径：只结算已达条件的团队投票，绝不代替玩家选择。 */
function resolveIfReady(io, decisionIdOrUid) {
  const decision = getDecision(decisionIdOrUid);
  if (!decision) throw new DecisionError('DECISION_NOT_FOUND', '决策不存在', 404);
  if (decision.status !== 'PENDING') {
    return { resolved: false, reason: 'ALREADY_RESOLVED', status: decision.status, resolvedOption: decision.resolved_option };
  }
  if (decision.type === 'PARTY') {
    const votes = votesOf(decision.id);
    if (votes.length >= decision.required_votes) {
      const settled = settleDecision(io, decision.uid, tallyVotes(decision, votes), { reason: 'TALLY', playerId: null });
      return { resolved: true, ...settled };
    }
    if (decision.expires_at && new Date(decision.expires_at).getTime() <= Date.now()) {
      const settled = settleDecision(io, decision.uid, decision.default_option, { reason: 'TIMEOUT', playerId: null });
      return { resolved: true, ...settled };
    }
    throw new DecisionError('VOTES_PENDING', `投票未达标（${votes.length}/${decision.required_votes}）且未超时：AI 不能强制结算`, 409);
  }
  throw new DecisionError('PLAYER_CHOICE_PENDING', 'NORMAL/TIMED 决策必须由玩家选择：AI 不能代替玩家做决定', 403);
}

module.exports = {
  DecisionError,
  DECISION_TYPES,
  createDecision,
  selectDecision,
  settleDecision,
  resolveIfReady,
  resolveDueDecisions,
  triggerDungeonTimedEvent,
  pendingDecisions,
  decisionView,
  getDecision,
  optionsOf,
  votesOf,
  validateResultData,
};
