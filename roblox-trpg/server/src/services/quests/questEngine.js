/**
 * Quest Engine（阶段8 核心）：任务状态机 + Objective 系统 + 事件监听推进
 * + 分支/选择 + 奖励结算（复用阶段6 characterService）+ 幂等 + 乐观锁。
 *
 * 红线：AI/玩家不能直接 UPDATE quest 表 —— 只能通过 Tool/REST，全部服务器验证。
 */
const crypto = require('crypto');
const { getDb } = require('@roblox-trpg/database');
const gameEvents = require('./gameEvents');
const conditionDsl = require('./conditionDsl');
const characterService = require('../character/characterService');

// ── 状态机（第八/九节：严格转换，禁止 COMPLETED→ACTIVE 等）──
const QUEST_TRANSITIONS = {
  AVAILABLE: ['ACTIVE', 'ABANDONED'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'FAILED', 'ABANDONED'],
  PAUSED: ['ACTIVE', 'ABANDONED', 'FAILED'],
  ABANDONED: ['ACTIVE'], // 明确支持：放弃后可重开（若定义允许）
  COMPLETED: [],
  FAILED: [],
};
const OBJECTIVE_TRANSITIONS = {
  LOCKED: ['ACTIVE', 'SKIPPED'],
  ACTIVE: ['COMPLETED', 'FAILED', 'SKIPPED'],
  COMPLETED: [],
  FAILED: [],
  SKIPPED: [],
};

// Objective 类型 → 默认监听事件
const OBJECTIVE_EVENT_MAP = {
  ENTER_DUNGEON: 'PLAYER_ENTERED_DUNGEON',
  REACH_LOCATION: 'PLAYER_ENTERED_SCENE',
  OPEN_DOOR: 'DOOR_OPENED',
  COLLECT_ITEM: 'ITEM_ACQUIRED',
  ACQUIRE_ITEM: 'ITEM_ACQUIRED',
  USE_ITEM: 'ITEM_USED',
  DEFEAT_ENEMY: 'ENEMY_DEFEATED',
  DEAL_DAMAGE: 'DAMAGE_DEALT',
  USE_SKILL: 'SKILL_USED',
  TALK_TO_NPC: 'NPC_TALKED',
  INTERACT: 'INTERACT',
  SEARCH: 'SEARCH',
  ESCAPE: 'PLAYER_ESCAPED',
  COMPLETE_DUNGEON: 'DUNGEON_COMPLETED',
  SURVIVE: 'DUNGEON_COMPLETED',
  ACQUIRE_SKILL: 'SKILL_ACQUIRED',
  ROLL_CHECK: 'DICE_ROLLED',
  CUSTOM: null,
};

class QuestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function uidOf(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function questBroadcast(io, roomId, type, payload) {
  if (io && roomId) io.to(roomId).emit('quest:event', { type, ...payload, at: new Date().toISOString() });
}

// ── 定义读取 ──
function getDefinition(qi) {
  const qv = getDb().prepare('SELECT * FROM quest_versions WHERE id = ?').get(qi.quest_version_id);
  let def = {};
  try {
    def = JSON.parse(qv.definition_json);
  } catch { /* 非法定义按空处理 */ }
  return { def, version: qv };
}

function objectivesOf(questVersionId) {
  return getDb().prepare('SELECT * FROM quest_objectives WHERE quest_version_id = ? ORDER BY order_index, id').all(questVersionId);
}

function getInstanceFull(qiId) {
  const db = getDb();
  const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qiId);
  if (!qi) return null;
  const { def, version } = getDefinition(qi);
  return {
    instance: qi,
    definition: def,
    version,
    quest: db.prepare('SELECT * FROM quests WHERE id = ?').get(version.quest_id),
    participants: db.prepare('SELECT * FROM quest_participants WHERE quest_instance_id = ?').all(qiId),
    objectives: db
      .prepare(
        `SELECT qoi.*, qo.objective_key, qo.name, qo.description, qo.type, qo.order_index, qo.is_optional, qo.definition_json AS obj_def
         FROM quest_objective_instances qoi JOIN quest_objectives qo ON qo.id = qoi.objective_id
         WHERE qoi.quest_instance_id = ? ORDER BY qo.order_index, qo.id`
      )
      .all(qiId),
    choices: db.prepare('SELECT * FROM quest_choices WHERE quest_instance_id = ?').all(qiId),
  };
}

// ── 任务设计验证（阶段8 第四十三/四十四节：禁止无限奖励/不存在的技能物品）──
function validateQuestDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== 'object') return ['定义必须是 JSON 对象'];
  if (!Array.isArray(draft.objectives) || draft.objectives.length === 0) errors.push('任务必须至少有一个 Objective');
  if ((draft.objectives || []).length > 20) errors.push('Objective 数量超过上限（20）');
  const seenKeys = new Set();
  for (const o of draft.objectives || []) {
    if (!o.key || !o.name || !o.type) errors.push('Objective 缺少 key/name/type');
    if (seenKeys.has(o.key)) errors.push(`重复的 objective_key: ${o.key}`);
    seenKeys.add(o.key);
    if (o.required_count != null && (!Number.isInteger(o.required_count) || o.required_count < 1 || o.required_count > 100)) {
      errors.push('required_count 必须在 1~100');
    }
  }
  const db = getDb();
  for (const r of draft.rewards || []) {
    const type = String(r.type || '').toUpperCase();
    if (!['XP', 'CURRENCY', 'ITEM', 'EQUIPMENT', 'SKILL', 'TITLE', 'UNLOCK', 'DUNGEON_ACCESS'].includes(type)) {
      errors.push(`非法奖励类型 ${r.type}`);
      continue;
    }
    if (type === 'XP' && (!Number.isFinite(r.amount) || r.amount <= 0 || r.amount > 10000)) errors.push('XP 奖励必须在 1~10000');
    if (type === 'CURRENCY' && (!Number.isFinite(r.amount) || r.amount <= 0 || r.amount > 100000)) errors.push('货币奖励必须在 1~100000');
    if (type === 'ITEM' || type === 'EQUIPMENT') {
      const row = db.prepare("SELECT 1 FROM items WHERE name = ? AND status = 'approved'").get(String(r.item || ''));
      if (!row) errors.push(`物品不存在或未审核：${r.item}（REWARD_VALIDATION_FAILED）`);
    }
    if (type === 'SKILL') {
      const row = db.prepare("SELECT 1 FROM skills WHERE name = ? AND status = 'approved'").get(String(r.skill || ''));
      if (!row) errors.push(`技能不存在或未审核：${r.skill}（AI 不能凭空创建技能）`);
    }
  }
  if (draft.time_limit_ms != null && (!Number.isFinite(draft.time_limit_ms) || draft.time_limit_ms < 10000 || draft.time_limit_ms > 3600000)) {
    errors.push('time_limit_ms 必须在 10 秒 ~ 60 分钟');
  }
  const blob = JSON.stringify(draft);
  if (/admin|管理员|god_mode|infinite|无限|omnipotent/i.test(blob)) errors.push('定义包含禁止内容（安全校验）');
  return errors;
}

/** 创建设计师任务（DRAFT）——AI 草案只能进 DRAFT，不能直接 PUBLISHED。 */
function createQuestDraft({ name, description, type = 'SIDE', dungeonId = null, sourceType = 'DESIGNER', sourceId = null, definition }) {
  const errors = validateQuestDraft(definition);
  if (errors.length) throw new QuestError('QUEST_VALIDATION_FAILED', errors.join('；'), 422);
  const db = getDb();
  let uid;
  do {
    uid = uidOf('quest');
  } while (db.prepare('SELECT 1 FROM quests WHERE uid = ?').get(uid));
  const q = db
    .prepare('INSERT INTO quests (uid, name, description, type, status, source_type, source_id, dungeon_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid, String(name).slice(0, 80), String(description || '').slice(0, 500), type, 'DRAFT', sourceType, sourceId, dungeonId);
  const v = db
    .prepare("INSERT INTO quest_versions (quest_id, version, definition_json, status) VALUES (?, 1, ?, 'DRAFT')")
    .run(q.lastInsertRowid, JSON.stringify(definition));
  // 物化 Objectives 到 quest_objectives（定义表；运行时用 quest_objective_instances）
  for (const o of definition.objectives) {
    db.prepare(
      `INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      v.lastInsertRowid,
      o.key,
      o.name,
      o.description || '',
      o.type,
      o.required_count || 1,
      o.order_index || 1,
      o.is_optional ? 1 : 0,
      JSON.stringify({ event_type: o.event_type, match: o.match, branch: o.branch, evidence_flag: o.evidence_flag })
    );
  }
  return { questId: q.lastInsertRowid, questUid: uid, versionId: v.lastInsertRowid, status: 'DRAFT' };
}

/** 发布任务版本（DRAFT/REVIEW → PUBLISHED；发布后定义不可变，修改需新版本）。 */
function publishQuestVersion(versionId) {
  const db = getDb();
  const v = db.prepare('SELECT * FROM quest_versions WHERE id = ?').get(versionId);
  if (!v) throw new QuestError('VERSION_NOT_FOUND', '版本不存在', 404);
  if (v.status === 'PUBLISHED') throw new QuestError('ALREADY_PUBLISHED', '该版本已发布（immutable）', 409);
  if (v.status === 'ARCHIVED') throw new QuestError('ARCHIVED', '已归档版本不能发布', 409);
  const defParsed = JSON.parse(v.definition_json);
  const errs = validateQuestDraft(defParsed);
  if (errs.length) throw new QuestError('QUEST_VALIDATION_FAILED', errs.join('；'), 422);
  const maxV = db.prepare('SELECT MAX(version) m FROM quest_versions WHERE quest_id = ?').get(v.quest_id).m || 1;
  if (v.version < maxV) throw new QuestError('STALE_VERSION', '已有更新版本，不能发布旧版本', 409);
  // 物化 Objectives（直接插入的版本可能未经 createQuestDraft）
  for (const o of defParsed.objectives || []) {
    db.prepare(
      `INSERT OR IGNORE INTO quest_objectives (quest_version_id, objective_key, name, description, type, required_count, order_index, is_optional, definition_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      v.id,
      o.key,
      o.name,
      o.description || '',
      o.type,
      o.required_count || 1,
      o.order_index || 1,
      o.is_optional ? 1 : 0,
      JSON.stringify({ event_type: o.event_type, match: o.match, branch: o.branch, evidence_flag: o.evidence_flag })
    );
  }
  db.prepare("UPDATE quest_versions SET status = 'PUBLISHED', published_at = datetime('now') WHERE id = ?").run(v.id);
  db.prepare("UPDATE quests SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?").run(v.quest_id);
  return { versionId: v.id, status: 'PUBLISHED' };
}

// ── 实例创建 / 生命周期 ──
function createInstance(io, { questVersionId, roomId, dungeonInstanceId = null, partyPlayerIds = [], activate = true }) {
  const db = getDb();
  const v = db.prepare('SELECT * FROM quest_versions WHERE id = ?').get(questVersionId);
  if (!v) throw new QuestError('VERSION_NOT_FOUND', '版本不存在', 404);
  if (v.status !== 'PUBLISHED') throw new QuestError('NOT_PUBLISHED', `只有 PUBLISHED 版本可运行（当前 ${v.status}）`, 409);
  const def = JSON.parse(v.definition_json);
  const qi = db
    .prepare(
      `INSERT INTO quest_instances (uid, quest_version_id, room_id, dungeon_instance_id, status, progress_scope, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uidOf('qi'),
      questVersionId,
      roomId,
      dungeonInstanceId,
      activate ? 'ACTIVE' : 'AVAILABLE',
      def.scope || 'PERSONAL',
      def.time_limit_ms && activate ? new Date(Date.now() + def.time_limit_ms).toISOString() : null
    );
  const qiId = qi.lastInsertRowid;
  for (const pid of partyPlayerIds) {
    db.prepare('INSERT OR IGNORE INTO quest_participants (quest_instance_id, player_id, status) VALUES (?, ?, ?)').run(
      qiId,
      pid,
      activate ? 'ACTIVE' : 'ACTIVE'
    );
  }
  // Objective 实例：order_index=1 组直接 ACTIVE（顺序模式），其余 LOCKED（并行组在同组激活时一起解锁）
  const objectives = objectivesOf(questVersionId);
  const firstOrder = objectives.length ? Math.min(...objectives.map((o) => o.order_index)) : 1;
  for (const o of objectives) {
    db.prepare(
      `INSERT INTO quest_objective_instances (quest_instance_id, objective_id, status, current_count, required_count, progress_json)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(qiId, o.id, activate && o.order_index === firstOrder ? 'ACTIVE' : 'LOCKED', o.required_count, '{}');
  }
  if (activate) {
    db.prepare("UPDATE quest_instances SET started_at = datetime('now') WHERE id = ?").run(qiId);
  }
  const full = getInstanceFull(qiId);
  if (activate) {
    questBroadcast(io, roomId, 'QUEST_STARTED', { questInstanceId: qiId, name: full.quest.name, hidden: Boolean(def.hidden && !def.discovered) });
    logQuestEvent(qiId, null, null, 'QUEST_STARTED', null, null, { status: 'ACTIVE' });
  }
  return full;
}

function assertTransition(kind, from, to) {
  const allowed = (kind === 'quest' ? QUEST_TRANSITIONS : OBJECTIVE_TRANSITIONS)[from] || [];
  if (!allowed.includes(to)) {
    throw new QuestError('INVALID_TRANSITION', `非法状态转换：${from} → ${to}`, 409);
  }
}

function setQuestStatus(io, qiId, to, { reason } = {}) {
  const db = getDb();
  const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qiId);
  if (!qi) throw new QuestError('INSTANCE_NOT_FOUND', '任务实例不存在', 404);
  if (qi.status === to) return qi;
  assertTransition('quest', qi.status, to);
  const stamps = { COMPLETED: 'completed_at', FAILED: 'failed_at', ACTIVE: 'started_at' };
  db.prepare(
    `UPDATE quest_instances SET status = ?, ${stamps[to] ? `${stamps[to]} = datetime('now'),` : ''} version = version + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(to, qiId);
  if (to === 'COMPLETED') questBroadcast(io, qi.room_id, 'QUEST_COMPLETED', { questInstanceId: qiId });
  if (to === 'FAILED') questBroadcast(io, qi.room_id, 'QUEST_FAILED', { questInstanceId: qiId, reason: reason || null });
  logQuestEvent(qiId, null, null, `QUEST_${to}`, null, { status: qi.status }, { status: to });
  return db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qiId);
}

function startQuest(io, qiId) {
  return setQuestStatus(io, qiId, 'ACTIVE');
}

function abandonQuest(io, qiId) {
  return setQuestStatus(io, qiId, 'ABANDONED');
}

function logQuestEvent(qiId, playerId, eventId, eventType, objectiveId, before, after) {
  try {
    getDb()
      .prepare(
        'INSERT INTO quest_events (quest_instance_id, player_id, event_id, event_type, objective_id, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(qiId, playerId, eventId || uidOf('qe'), eventType, objectiveId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
    return true;
  } catch {
    return false; // UNIQUE 冲突 = 幂等拦截
  }
}

// ── 事件驱动推进（第十三节）──
function activeInstancesInRoom(roomId) {
  return getDb().prepare("SELECT * FROM quest_instances WHERE room_id = ? AND status = 'ACTIVE'").all(roomId);
}

function objectiveMatches(objRow, evt) {
  let odef = {};
  try {
    odef = JSON.parse(objRow.obj_def || '{}');
  } catch { /* ignore */ }
  const expectedType = odef.event_type || OBJECTIVE_EVENT_MAP[objRow.type];
  if (!expectedType || evt.type !== expectedType) return false;
  const match = odef.match || {};
  for (const [k, v] of Object.entries(match)) {
    if (String((evt.data || {})[k] ?? '') !== String(v)) return false;
  }
  return true;
}

/** 乐观锁推进计数（第三十八节：并发防护）。 */
function incrementObjective(qoi, playerId, scope, evt) {
  const db = getDb();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const fresh = db.prepare('SELECT * FROM quest_objective_instances WHERE id = ?').get(qoi.id);
    if (!fresh || fresh.status !== 'ACTIVE') return null;
    let newCount = fresh.current_count;
    let progress = {};
    try {
      progress = JSON.parse(fresh.progress_json || '{}');
    } catch { /* ignore */ }
    if (scope === 'PERSONAL') {
      const key = String(playerId || 'unknown');
      if ((progress[key] || 0) >= fresh.required_count) return null;
      progress[key] = (progress[key] || 0) + 1;
    } else {
      if (fresh.current_count >= fresh.required_count) return null;
      newCount = fresh.current_count + 1;
    }
    const upd = db
      .prepare(
        `UPDATE quest_objective_instances SET current_count = ?, progress_json = ?, version = version + 1
         WHERE id = ? AND version = ?`
      )
      .run(scope === 'PERSONAL' ? fresh.current_count : newCount, JSON.stringify(progress), fresh.id, fresh.version);
    if (upd.changes === 1) {
      return { ...fresh, current_count: scope === 'PERSONAL' ? fresh.current_count : newCount, progress_json: JSON.stringify(progress), version: fresh.version + 1 };
    }
  }
  throw new QuestError('VERSION_CONFLICT', '目标并发冲突过于频繁', 409);
}

function personalCompleted(qoi, participants) {
  let progress = {};
  try {
    progress = JSON.parse(qoi.progress_json || '{}');
  } catch { /* ignore */ }
  const active = participants.filter((p) => p.status === 'ACTIVE' || p.status === 'COMPLETED');
  if (!active.length) return false;
  return active.every((p) => (progress[String(p.player_id)] || 0) >= qoi.required_count);
}

function activateNextObjectives(io, qiId) {
  const db = getDb();
  const full = getInstanceFull(qiId);
  const orderGroups = [...new Set(full.objectives.map((o) => o.order_index))].sort((a, b) => a - b);
  // 顺序模式：每个已完成组解锁其下一组；未完成组之后的保持 LOCKED
  for (let gi = 0; gi < orderGroups.length; gi += 1) {
    const ord = orderGroups[gi];
    const group = full.objectives.filter((o) => o.order_index === ord);
    const allDone = group.every((o) => ['COMPLETED', 'SKIPPED', 'FAILED'].includes(o.status));
    const nextOrd = orderGroups[gi + 1];
    if (allDone && nextOrd != null) {
      for (const o of full.objectives.filter((x) => x.order_index === nextOrd && x.status === 'LOCKED')) {
        db.prepare("UPDATE quest_objective_instances SET status = 'ACTIVE' WHERE id = ?").run(o.id);
      }
    }
  }
}

function checkQuestCompletion(io, qiId) {
  const db = getDb();
  const full = getInstanceFull(qiId);
  if (!full || full.instance.status !== 'ACTIVE') return false;
  const required = full.objectives.filter((o) => !o.is_optional);
  const done = required.every((o) => o.status === 'COMPLETED' || o.status === 'SKIPPED');
  if (!done) return false;
  // 可选目标标记为 SKIPPED
  for (const o of full.objectives.filter((o) => o.is_optional && o.status === 'ACTIVE')) {
    db.prepare("UPDATE quest_objective_instances SET status = 'SKIPPED' WHERE id = ?").run(o.id);
  }
  settleRewards(io, qiId);
  setQuestStatus(io, qiId, 'COMPLETED');
  return true;
}

// ── 奖励结算（复用阶段6 characterService；quest_reward_grants 幂等）──
function settleRewards(io, qiId) {
  const db = getDb();
  const full = getInstanceFull(qiId);
  if (!full) return [];
  const def = full.definition;
  const rewards = def.rewards || [];
  const granted = [];
  for (const p of full.participants) {
    if (p.status === 'LEFT') continue;
    for (const r of rewards) {
      const type = String(r.type || '').toUpperCase();
      const key = `${type}:${r.skill || r.item || r.currency || ''}:${r.amount || ''}`;
      const ins = db
        .prepare(
          'INSERT OR IGNORE INTO quest_reward_grants (grant_uid, quest_instance_id, player_id, reward_key, reward_type) VALUES (?, ?, ?, ?, ?)'
        )
        .run(uidOf('qrg'), qiId, p.player_id, key, type);
      if (ins.changes === 0) {
        granted.push({ player: p.player_id, key, status: 'ALREADY_GRANTED' });
        continue;
      }
      let result = { type };
      if (type === 'XP') {
        result = { ...result, ...characterService.grantXp(p.player_id, Math.min(10000, Number(r.amount) || 0), { sourceType: 'QUEST', sourceId: full.quest.uid }) };
      } else if (type === 'CURRENCY') {
        const cur = db.prepare('SELECT * FROM currencies WHERE name = ?').get(String(r.currency || '金币'));
        if (cur) result = { ...result, ...characterService.grantCurrency(p.player_id, cur.id, Math.min(100000, Number(r.amount) || 0), { sourceType: 'QUEST', sourceId: full.quest.uid }) };
      } else if (type === 'ITEM' || type === 'EQUIPMENT') {
        const item = db.prepare("SELECT * FROM items WHERE name = ? AND status = 'approved'").get(String(r.item || ''));
        if (item) result = { ...result, ...characterService.grantItem(p.player_id, item.id, { sourceType: 'QUEST', sourceId: full.quest.uid }) };
        else result = { ...result, granted: 'REJECTED', reason: 'ITEM_NOT_APPROVED' };
      } else if (type === 'SKILL') {
        const skill = db.prepare("SELECT * FROM skills WHERE name = ? AND status = 'approved'").get(String(r.skill || ''));
        if (skill) result = { ...result, ...characterService.grantSkill(p.player_id, skill.id, { sourceType: 'QUEST', sourceId: full.quest.uid }) };
        else result = { ...result, granted: 'REJECTED', reason: 'SKILL_NOT_APPROVED' };
      } else {
        result = { ...result, granted: 'NOTED' }; // TITLE/UNLOCK/DUNGEON_ACCESS 占位
      }
      granted.push({ player: p.player_id, key, ...result });
    }
    db.prepare("UPDATE quest_participants SET status = 'COMPLETED' WHERE quest_instance_id = ? AND player_id = ?").run(qiId, p.player_id);
  }
  questBroadcast(io, full.instance.room_id, 'QUEST_REWARD', { questInstanceId: qiId, granted: granted.length });
  for (const g of granted) logQuestEvent(qiId, g.player, null, 'REWARD', null, null, g);
  return granted;
}

// ── Game Event 监听器 ──
function handleGameEvent(io, evt) {
  const db = getDb();
  // 隐藏任务发现（第二十八节）
  const hiddenCandidates = db
    .prepare(
      `SELECT qv.id AS version_id, qv.definition_json, q.id AS quest_id, q.name FROM quest_versions qv
       JOIN quests q ON q.id = qv.quest_id
       WHERE qv.status = 'PUBLISHED' AND q.type = 'HIDDEN'
         AND (q.dungeon_id IS NULL OR q.dungeon_id = (SELECT dungeon_id FROM dungeon_instances di WHERE di.id = ?))
         AND NOT EXISTS (SELECT 1 FROM quest_instances qi WHERE qi.quest_version_id = qv.id AND qi.room_id = ?)`
    )
    .all(evt.instanceId || -1, evt.roomId);
  for (const h of hiddenCandidates) {
    let def = {};
    try {
      def = JSON.parse(h.definition_json);
    } catch {
      continue;
    }
    const disc = def.discovery;
    if (!disc || disc.event_type !== evt.type) continue;
    const matchOk = !disc.match || Object.entries(disc.match).every(([k, v]) => String((evt.data || {})[k] ?? '') === String(v));
    if (!matchOk) continue;
    const need = disc.count || 1;
    const seen = gameEvents.findEvents({ roomId: evt.roomId, type: disc.event_type, matchKey: disc.match ? Object.keys(disc.match)[0] : null, matchValue: disc.match ? disc.match[Object.keys(disc.match)[0]] : null, limit: 100 });
    if (seen.length >= need) {
      const party = db.prepare("SELECT id FROM players WHERE room_id = ? AND left_at IS NULL").all(evt.roomId).map((r) => r.id);
      createInstance(io, { questVersionId: h.version_id, roomId: evt.roomId, dungeonInstanceId: evt.instanceId, partyPlayerIds: party, activate: true });
    }
  }

  // 失败条件（第二十九节）：如 DUNGEON_FAILED → 关联任务失败
  if (evt.type === 'DUNGEON_FAILED') {
    for (const qi of activeInstancesInRoom(evt.roomId)) {
      const { def } = getDefinition(qi);
      if ((def.fail_on || []).includes('DUNGEON_FAILED')) {
        setQuestStatus(io, qi.id, 'FAILED', { reason: '副本失败' });
      }
    }
  }

  // 推进 ACTIVE 任务目标
  for (const qi of activeInstancesInRoom(evt.roomId)) {
    // 服务器时间限制检查（第三十节）
    if (qi.deadline_at && new Date(qi.deadline_at).getTime() < Date.now()) {
      setQuestStatus(io, qi.id, 'FAILED', { reason: '时间耗尽' });
      continue;
    }
    const full = getInstanceFull(qi.id);
    const scope = qi.progress_scope;
    let changed = false;
    for (const obj of full.objectives.filter((o) => o.status === 'ACTIVE')) {
      if (!objectiveMatches(obj, evt)) continue;
      // 幂等：同一 event 不能重复推进同一目标（第十四节）
      const logged = logQuestEvent(qi.id, null, evt.uid, evt.type, obj.id, { count: obj.current_count }, null);
      if (!logged) continue; // UNIQUE 冲突 → 已处理
      const updated = incrementObjective(obj, evt.actorPlayerId || evt.actor, scope, evt);
      if (!updated) continue;
      changed = true;
      const completed =
        scope === 'PERSONAL'
          ? personalCompleted({ ...updated, progress_json: updated.progress_json }, full.participants)
          : updated.current_count >= updated.required_count;
      if (completed) {
        db.prepare("UPDATE quest_objective_instances SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?").run(obj.id);
        questBroadcast(io, qi.room_id, 'QUEST_OBJECTIVE_COMPLETED', { questInstanceId: qi.id, objective: obj.name, key: obj.objective_key });
        logQuestEvent(qi.id, null, null, 'OBJECTIVE_COMPLETED', obj.id, null, { status: 'COMPLETED' });
        // 分支选择（第十七节）：目标带 branch 时生成 Choice
        let odef = {};
        try {
          odef = JSON.parse(obj.obj_def || '{}');
        } catch { /* ignore */ }
        if (odef.branch) {
          db.prepare(
            'INSERT OR IGNORE INTO quest_choices (quest_instance_id, choice_key, options_json) VALUES (?, ?, ?)'
          ).run(qi.id, odef.branch.choice_key || obj.objective_key, JSON.stringify(odef.branch.options || []));
          questBroadcast(io, qi.room_id, 'QUEST_BRANCH', { questInstanceId: qi.id, choiceKey: odef.branch.choice_key || obj.objective_key, options: odef.branch.options });
        }
      }
    }
    if (changed) {
      activateNextObjectives(io, qi.id);
      checkQuestCompletion(io, qi.id);
    }
    // SURVIVE / COMPLETE_DUNGEON 类在 DUNGEON_COMPLETED 时自动推进（由上面的事件匹配处理）
  }
}

// ── 玩家选择（第二十节：服务器重新验证）──
function submitChoice(io, qiId, playerRowId, choiceKey, optionId) {
  const db = getDb();
  const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qiId);
  if (!qi) throw new QuestError('INSTANCE_NOT_FOUND', '任务实例不存在', 404);
  if (qi.status !== 'ACTIVE') throw new QuestError('QUEST_NOT_ACTIVE', `任务状态 ${qi.status}，不能选择`, 409);
  const isParticipant = db.prepare('SELECT 1 FROM quest_participants WHERE quest_instance_id = ? AND player_id = ?').get(qiId, playerRowId);
  if (!isParticipant) throw new QuestError('NOT_PARTICIPANT', '你不是该任务的参与者', 403);
  const choice = db.prepare('SELECT * FROM quest_choices WHERE quest_instance_id = ? AND choice_key = ?').get(qiId, choiceKey);
  if (!choice) throw new QuestError('CHOICE_NOT_FOUND', '当前没有该选择（可能已失效）', 404);
  if (choice.status === 'RESOLVED') throw new QuestError('CHOICE_RESOLVED', '该选择已被做出', 409);
  const options = JSON.parse(choice.options_json);
  const opt = options.find((o) => o.id === optionId);
  if (!opt) throw new QuestError('INVALID_OPTION', '非法选项', 400);
  // 分支条件（第十八节）：Condition DSL 验证
  if (opt.conditions && !conditionDsl.evaluateAll(opt.conditions, { playerRowId, roomId: qi.room_id })) {
    throw new QuestError('CONDITION_NOT_MET', '分支条件不满足', 409);
  }
  db.prepare(
    "UPDATE quest_choices SET status = 'RESOLVED', chosen_by = ?, chosen_option = ?, resolved_at = datetime('now') WHERE id = ?"
  ).run(playerRowId, optionId, choice.id);
  // 分支效果：激活指定目标 / 跳过其他
  if (Array.isArray(opt.activate_objectives)) {
    const objs = objectivesOf(qi.quest_version_id);
    for (const key of opt.activate_objectives) {
      const o = objs.find((x) => x.objective_key === key);
      if (o) {
        db.prepare("UPDATE quest_objective_instances SET status = 'ACTIVE' WHERE quest_instance_id = ? AND objective_id = ? AND status = 'LOCKED'").run(qiId, o.id);
      }
    }
  }
  if (Array.isArray(opt.skip_objectives)) {
    const objs = objectivesOf(qi.quest_version_id);
    for (const key of opt.skip_objectives) {
      const o = objs.find((x) => x.objective_key === key);
      if (o) {
        db.prepare("UPDATE quest_objective_instances SET status = 'SKIPPED' WHERE quest_instance_id = ? AND objective_id = ? AND status IN ('LOCKED','ACTIVE')").run(qiId, o.id);
      }
    }
  }
  logQuestEvent(qiId, playerRowId, null, 'CHOICE_RESOLVED', null, { choiceKey }, { optionId });
  questBroadcast(io, qi.room_id, 'QUEST_BRANCH', { questInstanceId: qiId, resolved: true, choiceKey, optionId });
  checkQuestCompletion(io, qiId);
  return { ok: true, choiceKey, optionId };
}

/**
 * advance_quest（AI 工具）：服务器取证验证目标是否真的满足（第二十三/二十四节）。
 * AI 的叙事不是事实 —— 必须检查 Game Event Log / 数据库证据。
 */
function advanceQuest(io, qiId, playerRowId, objectiveKey) {
  const db = getDb();
  const qi = db.prepare('SELECT * FROM quest_instances WHERE id = ?').get(qiId);
  if (!qi) throw new QuestError('INSTANCE_NOT_FOUND', '任务实例不存在', 404);
  if (qi.status !== 'ACTIVE') throw new QuestError('QUEST_NOT_ACTIVE', `任务状态 ${qi.status}`, 409);
  const full = getInstanceFull(qiId);
  const obj = full.objectives.find((o) => o.objective_key === objectiveKey);
  if (!obj) throw new QuestError('OBJECTIVE_NOT_FOUND', `目标 ${objectiveKey} 不存在`, 404);
  if (obj.status !== 'ACTIVE') throw new QuestError('OBJECTIVE_NOT_ACTIVE', `目标状态 ${obj.status}`, 409);
  // 服务器取证：按目标类型检查事件日志 / 数据库状态
  const expected = OBJECTIVE_EVENT_MAP[obj.type];
  let odef = {};
  try {
    odef = JSON.parse(obj.obj_def || '{}');
  } catch { /* ignore */ }
  let evidence = [];
  if (expected) {
    evidence = gameEvents.findEvents({
      roomId: qi.room_id,
      instanceId: qi.dungeon_instance_id || null,
      type: expected,
      matchKey: odef.match ? Object.keys(odef.match)[0] : null,
      matchValue: odef.match ? odef.match[Object.keys(odef.match)[0]] : null,
      limit: 200,
    });
  } else if (odef.evidence_flag) {
    // CUSTOM：检查世界状态标志作为证据
    const worldState = require('../world/worldState');
    const w = worldState.getWorld(qi.room_id);
    if (w.state[odef.evidence_flag]) evidence = [{ uid: `flag:${odef.evidence_flag}` }];
  }
  const needed = obj.required_count;
  if (evidence.length < needed) {
    throw new QuestError('EVIDENCE_INSUFFICIENT', `证据不足：需要 ${needed} 次 ${expected || obj.type} 事件，实际 ${evidence.length}（AI 叙事不是事实）`, 409);
  }
  // 用证据事件推进（幂等）
  for (const e of evidence.slice(0, needed)) {
    const logged = logQuestEvent(qiId, playerRowId, e.uid, `ADVANCE:${obj.type}`, obj.objective_id, { count: obj.current_count }, null);
    if (!logged) continue;
    incrementObjective(obj, playerRowId, qi.progress_scope, e);
  }
  const fresh = db.prepare('SELECT * FROM quest_objective_instances WHERE quest_instance_id = ? AND objective_id = ?').get(qiId, obj.objective_id);
  const completed =
    qi.progress_scope === 'PERSONAL'
      ? personalCompleted(fresh, full.participants)
      : fresh.current_count >= fresh.required_count;
  if (completed) {
    db.prepare("UPDATE quest_objective_instances SET status = 'COMPLETED', completed_at = datetime('now') WHERE id = ?").run(obj.id);
    questBroadcast(io, qi.room_id, 'QUEST_OBJECTIVE_COMPLETED', { questInstanceId: qiId, objective: obj.name, key: objectiveKey });
    activateNextObjectives(io, qiId);
    checkQuestCompletion(io, qiId);
  }
  return { ok: true, objective: objectiveKey, count: fresh.current_count, required: fresh.required_count, completed };
}

// ── 副本生命周期联动（第四十一节）──
function onDungeonInstanceStarted(io, dungeonInstance, partyPlayerIds) {
  const db = getDb();
  const version = db.prepare('SELECT definition_json FROM dungeon_versions WHERE id = ?').get(dungeonInstance.dungeon_version_id);
  if (!version) return [];
  let def = {};
  try {
    def = JSON.parse(version.definition_json);
  } catch {
    return [];
  }
  const dungeonRow = db.prepare('SELECT * FROM dungeons WHERE id = ?').get(def.dungeon_id || -1) || db.prepare('SELECT * FROM dungeons WHERE roblox_universe_id = ?').get(def.roblox_universe_id || '__none__');
  if (!dungeonRow) return [];
  // 该副本绑定的已发布任务（隐藏任务除外——由事件发现）
  const versions = db
    .prepare(
      `SELECT qv.id FROM quest_versions qv JOIN quests q ON q.id = qv.quest_id
       WHERE q.dungeon_id = ? AND qv.status = 'PUBLISHED' AND q.type != 'HIDDEN'`
    )
    .all(dungeonRow.id);
  const created = [];
  for (const v of versions) {
    try {
      created.push(createInstance(io, { questVersionId: v.id, roomId: dungeonInstance.room_id, dungeonInstanceId: dungeonInstance.id, partyPlayerIds, activate: true }));
    } catch (err) {
      console.error('[questEngine] auto-start failed:', err.message);
    }
  }
  // 进入副本事件（驱动 ENTER_DUNGEON 目标）
  for (const pid of partyPlayerIds) {
    const p = db.prepare('SELECT name FROM players WHERE id = ?').get(pid);
    gameEvents.emit(io, dungeonInstance.room_id, { type: 'PLAYER_ENTERED_DUNGEON', actor: p ? p.name : null, actorPlayerId: pid, data: { dungeonInstanceUid: dungeonInstance.uid }, instanceId: dungeonInstance.id });
  }
  return created;
}

// ── 查询（权限：第三十九节）──
function listForRoom(roomId, { includeHidden = false } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT qi.*, q.name, q.description, q.type AS quest_type, q.uid AS quest_uid, qv.version
       FROM quest_instances qi
       JOIN quest_versions qv ON qv.id = qi.quest_version_id
       JOIN quests q ON q.id = qv.quest_id
       WHERE qi.room_id = ? AND qi.status IN ('AVAILABLE','ACTIVE','PAUSED','COMPLETED','FAILED')
       ORDER BY qi.id DESC LIMIT 50`
    )
    .all(roomId);
  return rows.filter((r) => {
    if (includeHidden) return true;
    const def = (() => {
      try {
        return JSON.parse(db.prepare('SELECT definition_json FROM quest_versions WHERE id = ?').get(qi_version_id(r)).definition_json);
      } catch {
        return {};
      }
    })();
    return !(def.hidden && r.status === 'AVAILABLE');
  });
}
function qi_version_id(r) {
  return r.quest_version_id;
}

module.exports = {
  QuestError,
  QUEST_TRANSITIONS,
  OBJECTIVE_TRANSITIONS,
  OBJECTIVE_EVENT_MAP,
  validateQuestDraft,
  createQuestDraft,
  publishQuestVersion,
  createInstance,
  getInstanceFull,
  startQuest,
  abandonQuest,
  setQuestStatus,
  handleGameEvent,
  submitChoice,
  advanceQuest,
  settleRewards,
  onDungeonInstanceStarted,
  listForRoom,
  activeInstancesInRoom,
};

// 注册事件监听（启动一次）
gameEvents.onEvent((io, evt) => handleGameEvent(io, evt));
